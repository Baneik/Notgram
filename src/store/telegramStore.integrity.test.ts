import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { TauriTelegramTransport } from "../telegram/tauriTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { TdObject } from "../telegram/tdlibMapper";
import type { CachedTelegramSnapshot, HistoryPageRequest, Message } from "../telegram/types";
import { mockSnapshot } from "../telegram/mockData";
import { createTelegramStore } from "./telegramStore";
import { cachedSnapshotFrom } from "./telegramStore.cache";
import { preferencesStore } from "./preferencesStore";
import { projectHistoryWindow } from "./conversationHistory";

afterEach(() => preferencesStore.setState({ deletedMessageArchiveEnabled: false }));

it("repairs an overnight gap through the native pager after a partial refresh is saved and restarted", async () => {
  const source: Message[] = Array.from({ length: 200 }, (_, i) => ({
    id: String((i + 1) * 1_048_576), chatId: "7", senderId: "11", outgoing: false,
    sentAt: new Date((1_700_000_000 + i + (i >= 70 ? 86_400 : 0)) * 1000).toISOString(), delivery: "sent",
    content: { kind: "text", text: `overnight ${i + 1}` },
  }));
  const cached: CachedTelegramSnapshot = {
    version: 4, savedAt: new Date().toISOString(), currentUserId: mockSnapshot.currentUserId,
    users: mockSnapshot.users, folders: mockSnapshot.folders,
    chats: [{ ...mockSnapshot.chats.find(chat => chat.id === "chat-product")!, id: "7", unreadCount: 0 }],
    messages: [...source.slice(40, 70), ...source.slice(-30)], activeChatId: "7", chatFilter: "main",
  };
  class OvernightTransport extends MockTelegramTransport {
    readonly native = new TauriTelegramTransport();
    failOlder = false;
    cursors: number[] = [];
    constructor(snapshot: CachedTelegramSnapshot) {
      super({ cachedSnapshot: snapshot, connectionStatus: "offline" });
      const internal = this.native as unknown as { request: (query: TdObject) => Promise<TdObject> };
      internal.request = async query => {
        if (query["@type"] !== "getChatHistory") return {};
        const cursor = Number(query.from_message_id);
        this.cursors.push(cursor);
        if (cursor && this.failOlder) throw new Error("offline during recovery");
        return { messages: source.filter(message => !cursor || Number(message.id) < cursor).slice(-7).reverse().map(message => ({
          "@type": "message", id: Number(message.id), chat_id: 7, date: Date.parse(message.sentAt) / 1000,
          sender_id: { "@type": "messageSenderUser", user_id: 11 },
          content: { "@type": "messageText", text: { text: `overnight ${Number(message.id) / 1_048_576}`, entities: [] } },
        })) };
      };
    }
    override async loadChatHistory(chatId: string, limit = 30, request?: HistoryPageRequest) {
      return chatId === "7" ? this.native.loadChatHistory(chatId, limit, request) : super.loadChatHistory(chatId, limit, request);
    }
  }
  const transport = new OvernightTransport(cached);
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  // The first complete native window succeeds; the next window fails.
  const load = transport.loadChatHistory.bind(transport);
  vi.spyOn(transport, "loadChatHistory").mockImplementation(async (...args) => {
    const result = await load(...args);
    transport.failOlder = true;
    return result;
  });
  transport.setConnectionStatus("online");
  await vi.waitFor(() => expect(store.getState().histories.get("7")?.recovery).toBe("failed"));
  transport.setConnectionStatus("offline");
  expect(await store.getState().rebuildCachedSnapshot()).toBe(true);
  const saved = (await transport.loadCachedSnapshot())!;
  expect(saved.historyContexts?.some(context => context.messageIds.includes(source[69].id))).toBe(true);
  const restartedTransport = new OvernightTransport(saved);
  const restarted = createTelegramStore(restartedTransport);
  await restarted.getState().initialize();
  restartedTransport.setConnectionStatus("online");
  await vi.waitFor(() => expect(restarted.getState().histories.get("7")?.recovery).toBe("complete"));
  const visible = () => projectHistoryWindow(restarted.getState().messages.get("7")!, restarted.getState().histories.get("7")?.view);
  for (let turn = 0; turn < 10 && restarted.getState().histories.get("7")?.hasMore !== false; turn++) {
    const rows = visible();
    expect(rows.map(message => message.id)).toEqual(source.filter(message => Number(message.id) >= Number(rows[0].id)).map(message => message.id));
    await restarted.getState().loadMoreHistory("7");
  }
  expect(visible().map(message => message.id)).toEqual(source.map(message => message.id));
  expect(restartedTransport.cursors.filter(Boolean).every((cursor, i, cursors) => !i || cursor <= cursors[i - 1])).toBe(true);
  await transport.disconnect();
  await restartedTransport.disconnect();
});

it("keeps a continuous mixed timeline through TDLib pages, remote deletions and snapshot restart", async () => {
  const raw = Array.from({ length: 120 }, (_, index): TdObject => ({
    "@type": "message", id: (index + 1) * 1_048_576, chat_id: 7,
    date: 1_700_000_000 + index, is_outgoing: index % 2 === 1,
    sender_id: { "@type": "messageSenderUser", user_id: index % 2 === 1 ? 11 : 12 },
    content: { "@type": "messageText", text: { "@type": "formattedText", text: `original ${index + 1}`, entities: [] } },
  }));
  const deleted = new Set(raw.filter((_, index) => index % 4 === 0).map(message => message.id));
  const live = raw.filter(message => !deleted.has(message.id)).reverse();
  const tdlib = new TauriTelegramTransport();
  const internal = tdlib as unknown as { listener?: TelegramEventListener;
    emitMessage: (message: TdObject) => void; handleUpdate: (update: TdObject) => void;
    request: (query: TdObject) => Promise<TdObject> };
  const cursors: number[] = [];
  let emptyRace = true;
  internal.request = async query => {
    if (query["@type"] !== "getChatHistory") return {};
    const cursor = Number(query.from_message_id);
    cursors.push(cursor);
    if (cursor && emptyRace) { emptyRace = false; return { messages: [] }; }
    // Match the bundled TDLib's strict older ordering; IDs have gaps after deletion.
    return { messages: live.filter(message => !cursor || Number(message.id) < cursor).slice(0, 7) };
  };
  class HistoryTransport extends MockTelegramTransport {
    override async connect(listener: TelegramEventListener) {
      internal.listener = listener;
      return super.connect(listener);
    }
    override async loadChatHistory(chatId: string, limit = 30, request?: HistoryPageRequest) {
      return chatId === "7" ? tdlib.loadChatHistory(chatId, limit, request) : super.loadChatHistory(chatId, limit, request);
    }
  }
  const transport = new HistoryTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const chat = { ...store.getState().chats.get("chat-product")!, id: "7" };
  store.setState({ chats: new Map([[chat.id, chat]]), activeChatId: "7" });
  preferencesStore.setState({ deletedMessageArchiveEnabled: true });
  for (const message of raw) internal.emitMessage(message);
  internal.handleUpdate({ "@type": "updateDeleteMessages", chat_id: 7,
    message_ids: [...deleted], is_permanent: true, from_cache: false });
  for (let page = 0; page < 10 && store.getState().histories.get("7")?.hasMore !== false; page++) {
    await store.getState().loadMoreHistory("7");
  }
  const messages = store.getState().messages.get("7")!;
  expect(messages.map(message => message.id)).toEqual(raw.map(message => String(message.id)));
  expect(messages.filter(message => message.isLocallyDeleted).map(message => Number(message.id))).toEqual([...deleted]);
  expect(messages.filter(message => message.outgoing)).toHaveLength(60);
  expect(new Set(messages.map(message => message.id)).size).toBe(120);
  expect(store.getState().histories.get("7")?.hasMore).toBe(false);
  expect(cursors.slice(1).every((cursor, index) => index === 0 || cursor <= cursors[index])).toBe(true);
  const snapshot = cachedSnapshotFrom(store.getState());
  expect(snapshot.messages.filter(message => message.chatId === "7")).toHaveLength(60);
  expect(snapshot.locallyDeletedMessages).toHaveLength(30);

  tdlib.resetSyncState();
  const restarted = createTelegramStore(new HistoryTransport({ cachedSnapshot: snapshot, connectionStatus: "offline" }));
  await restarted.getState().initialize();
  expect(restarted.getState().messages.get("7")?.filter(message => message.isLocallyDeleted)).toHaveLength(30);
  expect(restarted.getState().messages.get("7")?.filter(message => !message.isLocallyDeleted)).toHaveLength(60);
  restarted.setState({ connectionStatus: "online" });
  restarted.getState().focusHistoryWindow("7");
  const visible = () => projectHistoryWindow(restarted.getState().messages.get("7")!, restarted.getState().histories.get("7")?.view);
  expect(Number(visible()[0].id)).toBeGreaterThan(Number(raw[0].id));
  for (let page = 0; page < 10 && restarted.getState().histories.get("7")?.hasMore !== false; page++) {
    await restarted.getState().loadMoreHistory("7");
    const current = visible();
    expect(current.map(message => message.id)).toEqual(raw.filter(message => Number(message.id) >= Number(current[0].id)).map(message => String(message.id)));
  }
  expect(restarted.getState().histories.get("7")?.hasMore).toBe(false);
  expect(visible().map(message => message.id)).toEqual(raw.map(message => String(message.id)));
  expect(visible().filter(message => message.isLocallyDeleted)).toHaveLength(30);
});
