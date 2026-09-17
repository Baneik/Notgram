import { afterEach, expect, it } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { TauriTelegramTransport } from "../telegram/tauriTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { TdObject } from "../telegram/tdlibMapper";
import type { HistoryPageRequest } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";
import { cachedSnapshotFrom } from "./telegramStore.cache";
import { preferencesStore } from "./preferencesStore";
import { projectHistoryWindow } from "./conversationHistory";

afterEach(() => preferencesStore.setState({ deletedMessageArchiveEnabled: false }));

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
