import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { Message, TelegramEvent } from "../telegram/types";
import { createTelegramStore, type MessageChangeEvent } from "./telegramStore";
import { IncomingMediaAlbums } from "./incomingMediaAlbums";
import { TauriTelegramTransport } from "../telegram/tauriTransport";
import type { TdObject } from "../telegram/tdlibMapper";

class AlbumTransport extends MockTelegramTransport {
  events?: TelegramEventListener;
  historyMessages: Message[] = [];
  override async connect(listener: TelegramEventListener) {
    this.events = listener;
    return super.connect(listener);
  }
  override async loadChatHistory() {
    return { messages: this.historyMessages, messageIds: this.historyMessages.map(message => message.id),
      loadedCount: this.historyMessages.length, hasMore: false };
  }
  dispatch(event: TelegramEvent) { this.events?.(event); }
}

afterEach(() => { vi.useRealTimers(); });

const photo = (id: string, chatId = "chat-product", albumId = "incoming-album"): Message => ({
  id, chatId, senderId: "u-chen", outgoing: false, delivery: "sent",
  sentAt: "2026-10-09T10:00:00.000Z", mediaAlbumId: albumId,
  content: { kind: "media", mediaType: "photo", fileName: `${id}.jpg`, sizeLabel: "1 KB",
    fileId: 91, width: 1200, height: 900 },
});

const fixture = async () => {
  const transport = new AlbumTransport({ connectionStatus: "offline" });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  vi.useFakeTimers();
  const changes: MessageChangeEvent[] = [];
  store.getState().subscribeMessageChanges(change => changes.push(change));
  const received = (chatId = "chat-product") => (store.getState().messages.get(chatId) ?? [])
    .filter(message => message.mediaAlbumId === "incoming-album");
  const send = (message: Message) => transport.dispatch({ type: "message.upsert", message, animateEntrance: true });
  return { store, transport, changes, received, send };
};

it("publishes a staggered live album in one message change with every live identity", async () => {
  const { store, received, send, changes } = await fixture();
  const commits: number[] = [];
  store.subscribe((state, previous) => {
    if (state.messages !== previous.messages) commits.push(received().length);
  });
  send(photo("101"));
  await vi.advanceTimersByTimeAsync(180);
  send(photo("102"));
  await vi.advanceTimersByTimeAsync(180);
  send(photo("103"));
  expect(received()).toEqual([]);
  await vi.advanceTimersByTimeAsync(500);
  expect(received().map(message => message.id)).toEqual(["101", "102", "103"]);
  expect(commits).toEqual([3]);
  expect(changes.filter(change => change.type === "upsert")).toEqual([
    expect.objectContaining({ messages: received(), liveMessages: received() }),
  ]);
});

it("folds caption edits, bulk hydration and file completion into the first album commit", async () => {
  const { transport, send, received } = await fixture();
  send(photo("101"));
  send(photo("102"));
  transport.dispatch({ type: "messages.upserted", messages: [{ ...photo("101"),
    content: { kind: "media", mediaType: "photo", fileName: "101.jpg", sizeLabel: "1 KB", fileId: 91,
      width: 1200, height: 900, caption: "Updated caption" } }], cacheRelevant: false });
  transport.dispatch({ type: "file.updated", file: { fileId: 91, sizeLabel: "1 KB",
    isDownloaded: true, isDownloading: false, localPath: "C:/cache/album.jpg" } });
  expect(received()).toEqual([]);
  await vi.advanceTimersByTimeAsync(500);
  expect(received()[0].content).toMatchObject({ caption: "Updated caption", localPath: "C:/cache/album.jpg", isDownloaded: true });
  expect(received()[1].content).toMatchObject({ localPath: "C:/cache/album.jpg", isDownloaded: true });
});

it("does not hold ordinary messages, outgoing albums or loaded history", async () => {
  const { transport, send, store, received } = await fixture();
  send(photo("101"));
  send({ ...photo("102"), mediaAlbumId: undefined });
  send({ ...photo("103"), outgoing: true });
  transport.dispatch({ type: "messages.upserted", messages: [photo("104", "chat-mia")] });
  expect(received().map(message => message.id)).toEqual(["103"]);
  expect(store.getState().messages.get("chat-product")?.some(message => message.id === "102")).toBe(true);
  expect(received("chat-mia").map(message => message.id)).toEqual(["104"]);
});

it("does not postpone an album for repeated content or file updates", async () => {
  const { transport, send, received } = await fixture();
  send(photo("101"));
  for (let index = 0; index < 4; index++) {
    await vi.advanceTimersByTimeAsync(100);
    transport.dispatch({ type: "message.upsert", message: photo("101") });
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(received()).toHaveLength(1);
});

it("bounds the wait while more members keep arriving", async () => {
  const { send, received } = await fixture();
  for (let index = 0; index < 5; index++) {
    send(photo(String(101 + index)));
    await vi.advanceTimersByTimeAsync(400);
  }
  expect(received()).toHaveLength(5);
});

it("keeps album timers separate between chats", async () => {
  const { send, received } = await fixture();
  send(photo("101"));
  await vi.advanceTimersByTimeAsync(300);
  send(photo("102", "chat-mia"));
  await vi.advanceTimersByTimeAsync(200);
  expect(received()).toHaveLength(1);
  expect(received("chat-mia")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(300);
  expect(received("chat-mia")).toHaveLength(1);
});

it.each(["message.remove", "chat.historyDeleted"] as const)("does not resurrect buffered items after %s", async type => {
  const { transport, send, received } = await fixture();
  send(photo("101"));
  send(photo("102"));
  if (type === "message.remove") transport.dispatch({ type, chatId: "chat-product", messageId: "101", permanent: true, source: "local" });
  else transport.dispatch({ type, chatId: "chat-product", lastMessageId: "101" });
  await vi.advanceTimersByTimeAsync(600);
  expect(received().map(message => message.id)).toEqual(["102"]);
});

it("cannot deliver the previous account's pending album after switching accounts", async () => {
  const { store, send } = await fixture();
  send(photo("101"));
  await store.getState().switchAccount("account-secondary");
  await vi.advanceTimersByTimeAsync(2500);
  expect(store.getState().activeAccountId).toBe("account-secondary");
  expect([...store.getState().messages.values()].flat().some(message => message.id === "101")).toBe(false);
});

it("preserves a newer caption against stale hydration while the album is pending", async () => {
  const { send, transport, received } = await fixture();
  const message = photo("101");
  send(message);
  transport.dispatch({ type: "message.upsert", message: { ...message, editedAt: "2026-10-09T10:01:00.000Z",
    content: { kind: "media", mediaType: "photo", fileName: "101.jpg", sizeLabel: "1 KB", caption: "New caption" } } });
  transport.dispatch({ type: "messages.upserted", messages: [message] });
  await vi.advanceTimersByTimeAsync(500);
  expect(received()[0].content).toMatchObject({ caption: "New caption" });
});

it("keeps different albums in the same chat independent and updates an existing album immediately", async () => {
  const { send, store, transport, received } = await fixture();
  send(photo("101"));
  await vi.advanceTimersByTimeAsync(300);
  send(photo("201", "chat-product", "other-album"));
  await vi.advanceTimersByTimeAsync(200);
  expect(received()).toHaveLength(1);
  expect(store.getState().messages.get("chat-product")?.some(message => message.id === "201")).toBe(false);
  transport.dispatch({ type: "message.upsert", message: { ...photo("101"), isPinned: true } });
  expect(received()[0].isPinned).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(store.getState().messages.get("chat-product")?.some(message => message.id === "201")).toBe(true);
});

it("delivers members that arrive after the bounded wait without losing earlier members", async () => {
  const { send, received } = await fixture();
  send(photo("101"));
  await vi.advanceTimersByTimeAsync(500);
  send(photo("102"));
  expect(received().map(message => message.id)).toEqual(["101"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(received().map(message => message.id)).toEqual(["101", "102"]);
});

it("releases a fully discarded album's timers and retains durable cache relevance", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const albums = new IncomingMediaAlbums(publish);
  albums.capture(photo("101"), true);
  expect(vi.getTimerCount()).toBe(2);
  albums.discard(() => true);
  expect(vi.getTimerCount()).toBe(0);
  albums.capture(photo("102"), true);
  albums.capture(photo("102"), false, false);
  await vi.advanceTimersByTimeAsync(500);
  expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cacheRelevant: true }));
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces raw TDLib updateNewMessage events through the real transport mapper", async () => {
  const { transport, store, changes } = await fixture();
  const native = new TauriTelegramTransport() as unknown as {
    listener?: TelegramEventListener;
    handleUpdate: (update: TdObject) => void;
    request: (request: TdObject) => Promise<TdObject>;
  };
  native.listener = event => transport.dispatch(event);
  native.request = vi.fn(async () => ({ "@type": "error" }));
  for (let index = 0; index < 3; index++) {
    native.handleUpdate({ "@type": "updateNewMessage", message: {
      "@type": "message", id: 1001 + index, chat_id: 99, media_album_id: "9223372036854775000",
      sender_id: { "@type": "messageSenderUser", user_id: 7 }, date: 1_700_000_000,
      content: { "@type": "messagePhoto", photo: { sizes: [] },
        caption: { "@type": "formattedText", text: index === 0 ? "Album caption" : "", entities: [] } },
    } });
    await vi.advanceTimersByTimeAsync(150);
  }
  expect(store.getState().messages.get("99")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(500);
  expect(store.getState().messages.get("99")?.map(message => message.mediaAlbumId)).toEqual([
    "9223372036854775000", "9223372036854775000", "9223372036854775000",
  ]);
  expect(changes.filter(event => event.type === "upsert")).toEqual([
    expect.objectContaining({ liveMessages: expect.arrayContaining([
      expect.objectContaining({ id: "1001" }), expect.objectContaining({ id: "1002" }), expect.objectContaining({ id: "1003" }),
    ]) }),
  ]);
});

it("does not expose a pending album through an overlapping history page or its change subscribers", async () => {
  const { send, transport, store, changes } = await fixture();
  const chatId = "chat-history-album";
  send(photo("101", chatId));
  transport.historyMessages = [photo("101", chatId), photo("102", chatId)];
  store.setState({ connectionStatus: "online" });
  await store.getState().loadMoreHistory(chatId);
  expect(store.getState().messages.get(chatId)).toBeUndefined();
  expect(changes.filter(event => event.type === "upsert")).toEqual([]);
  await vi.advanceTimersByTimeAsync(500);
  expect(store.getState().messages.get(chatId)?.map(message => message.id)).toEqual(["101", "102"]);
  expect(changes.filter(event => event.type === "upsert")).toEqual([
    expect.objectContaining({ liveMessages: [expect.objectContaining({ id: "101" })] }),
  ]);
});

it("keeps an album pending when the connect snapshot overlaps its live events", async () => {
  class SnapshotAlbumTransport extends AlbumTransport {
    override async connect(listener: TelegramEventListener) {
      const snapshot = await super.connect(listener);
      listener({ type: "message.upsert", message: photo("101"), animateEntrance: true });
      return { ...snapshot, messages: [photo("101"), photo("102")] };
    }
  }
  vi.useFakeTimers();
  const store = createTelegramStore(new SnapshotAlbumTransport({ connectionStatus: "offline" }));
  await store.getState().initialize();
  const received = () => (store.getState().messages.get("chat-product") ?? [])
    .filter(message => message.mediaAlbumId === "incoming-album");
  expect(received()).toEqual([]);
  await vi.advanceTimersByTimeAsync(500);
  expect(received().map(message => message.id)).toEqual(["101", "102"]);
});
