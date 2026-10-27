import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { mockSnapshot } from "../telegram/mockData";
import type { Message, TelegramEvent } from "../telegram/types";
import type { TelegramEventListener } from "../telegram/transport";
import { MessageFileIndex } from "./messageFileIndex";
import { createTelegramStore } from "./telegramStore";

class PerformanceTransport extends MockTelegramTransport {
  events?: TelegramEventListener;
  override async connect(listener: TelegramEventListener) { this.events = listener; return super.connect(listener); }
  override async loadChatHistory() { return { messages: [], messageIds: [], loadedCount: 0, hasMore: false }; }
  discardChatHistoryCache = vi.fn();
  dispatch(event: TelegramEvent) { this.events?.(event); }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const fixture = async () => {
  const transport = new PerformanceTransport({ connectionStatus: "offline" });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  vi.useFakeTimers();
  return { transport, store };
};

const message = (id: string, chatId: string): Message => ({
  ...mockSnapshot.messages[0], id, chatId, delivery: "sent", outgoing: true,
  replyTo: undefined, containsUnreadMention: false, containsUnreadReaction: false,
  content: { kind: "text", text: id },
});

it("publishes a navigation context and its messages in one store update", async () => {
  const transport = new PerformanceTransport({ connectionStatus: "offline" });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const chatId = "chat-mia";
  const target = message("context-target", chatId);
  vi.spyOn(transport, "getMessageContext").mockResolvedValue([target]);
  store.getState().focusHistoryWindow(chatId, target.id);
  const snapshots: Array<{ hasTarget: boolean; selected: boolean }> = [];
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.messages === previous.messages && state.histories === previous.histories) return;
    snapshots.push({
      hasTarget: Boolean(state.messages.get(chatId)?.some(item => item.id === target.id)),
      selected: Boolean(state.histories.get(chatId)?.view?.messageIds?.has(target.id)),
    });
  });
  expect(await store.getState().loadMessage(chatId, target.id)).toBe(true);
  unsubscribe();
  expect(snapshots).toHaveLength(1);
  expect(snapshots).toEqual([{ hasTarget: true, selected: true }]);
});

it("keeps other topic messages cached outside the selected navigation context", async () => {
  const transport = new PerformanceTransport({ connectionStatus: "offline" });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const chatId = "chat-forum";
  const target = { ...message("context-target", chatId), topicId: "12" };
  const neighbor = { ...message("other-topic", chatId), topicId: "18" };
  vi.spyOn(transport, "getMessageContext").mockResolvedValue([target, neighbor]);
  store.getState().focusHistoryWindow(chatId, target.id, target.topicId);
  expect(await store.getState().loadMessage(chatId, target.id)).toBe(true);
  expect(store.getState().messages.get(chatId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: target.id }), expect.objectContaining({ id: neighbor.id }),
  ]));
  const view = store.getState().topicHistories.get(`${chatId}:topic:12`)?.view;
  expect(view?.messageIds?.has(target.id)).toBe(true);
  expect(view?.messageIds?.has(neighbor.id)).toBe(false);
});

it("bounds ordinary file indexes across repeated history eviction while preserving archives", async () => {
  const { store, transport } = await fixture();
  const captured = new Set<MessageFileIndex>();
  const upsert = MessageFileIndex.prototype.upsert;
  vi.spyOn(MessageFileIndex.prototype, "upsert").mockImplementation(function (this: MessageFileIndex, items) {
    captured.add(this);
    return upsert.call(this, items);
  });
  const retained = { ...message("retained", "archive-chat"), isLocallyDeleted: true };
  transport.dispatch({ type: "messages.upserted", messages: [retained] });
  const committedArchive = store.getState().messages.get(retained.chatId)?.[0];
  for (let round = 0; round < 3; round++) {
    const incoming = Array.from({ length: 120 }, (_, index) => message("1", `round-${round}-chat-${index}`));
    transport.dispatch({ type: "messages.upserted", messages: incoming });
    const state = store.getState();
    const stored = [...state.messages.values()].reduce((sum, items) => sum + items.length, 0);
    expect(state.messages.size).toBeLessThanOrEqual(100);
    expect([...captured].map(index => index.all().length).sort((left, right) => left - right)).toEqual([1, stored]);
    expect(state.messages.get(retained.chatId)?.[0]).toBe(committedArchive);
  }
  expect(transport.discardChatHistoryCache).toHaveBeenCalled();
});

it("reuses history capacity counts during draft-only writes and rechecks changed histories", async () => {
  const { store } = await fixture();
  const chatId = store.getState().activeChatId!;
  let reads = 0;
  const items = Array.from({ length: 1_000 }, (_, index) => {
    const item = message(String(index), chatId);
    Object.defineProperty(item, "isLocallyDeleted", { get: () => { reads++; return false; } });
    return item;
  });
  store.setState({ messages: new Map([[chatId, items]]) });
  store.getState().updateChatDraft(chatId, "first");
  expect(reads).toBe(1_000);
  reads = 0;
  store.getState().updateChatDraft(chatId, "second");
  expect(reads).toBe(0);
  store.setState({ messages: new Map(store.getState().messages) });
  store.getState().updateChatDraft(chatId, "same history in another map");
  expect(reads).toBe(0);
  store.setState({ messages: new Map([[chatId, items.slice()]]) });
  store.getState().updateChatDraft(chatId, "new history");
  expect(reads).toBe(1_000);
});

it("commits shared-file patches in bounded batches and yields before processing the rest", async () => {
  const { store, transport } = await fixture();
  const chatId = store.getState().activeChatId!;
  const items = Array.from({ length: 100 }, (_, index) => ({ ...message(String(index), chatId),
    content: { kind: "media" as const, mediaType: "photo" as const, fileId: 91,
      fileName: "shared.jpg", sizeLabel: "1 KB", isDownloaded: false, isDownloading: true },
  }));
  transport.dispatch({ type: "messages.upserted", messages: items });
  const before = store.getState().messages.get(chatId)!;
  const commits: Message[][] = [];
  const stop = store.subscribe((state, previous) => {
    if (state.messages !== previous.messages) commits.push(state.messages.get(chatId)!);
  });
  transport.dispatch({ type: "file.updated", file: { fileId: 91, sizeLabel: "1 KB",
    isDownloaded: true, isDownloading: false, localPath: "C:/cache/shared.jpg" } });
  expect(commits).toHaveLength(1);
  expect(commits[0].filter(message => message.content.kind === "media" && message.content.localPath === "C:/cache/shared.jpg").length).toBeLessThanOrEqual(32);
  await vi.advanceTimersByTimeAsync(10);
  stop();
  expect(commits.length).toBeGreaterThanOrEqual(4);
  for (const item of items) {
    expect(commits.at(-1)!.find(value => value.id === item.id)?.content).toMatchObject({ isDownloaded: true, localPath: "C:/cache/shared.jpg" });
  }
  expect(before.find(item => item.id === "0")?.content).toMatchObject({ isDownloaded: false });
});

it("does not revisit unrelated expiry or retention fields for a persistent file patch and keeps expiration armed", async () => {
  const { store, transport } = await fixture();
  const chatId = store.getState().activeChatId!;
  const expiresAt = new Date(Date.now() + 1_000).toISOString();
  const photo: Message = { ...message("expires", chatId), expiresAt,
    content: { kind: "file", fileId: 91, fileName: "photo", sizeLabel: "1 KB" } };
  const unrelated = Array.from({ length: 1_000 }, (_, index) => message(`unrelated-${index}`, chatId));
  transport.dispatch({ type: "messages.upserted", messages: [photo, ...unrelated] });
  let reads = 0;
  for (const item of store.getState().messages.get(chatId)!.filter(item => item.id.startsWith("unrelated-"))) {
    Object.defineProperty(item, "expiresAt", { configurable: true, get: () => { reads++; return undefined; } });
    Object.defineProperty(item, "isLocallyDeleted", { configurable: true, get: () => { reads++; return false; } });
  }
  transport.dispatch({ type: "file.updated", file: { fileId: 91, sizeLabel: "1 KB", localPath: "C:/cache/photo", isDownloaded: true } });
  expect(reads).toBe(0);
  expect(store.getState().messages.get(chatId)?.find(item => item.id === "expires")?.content).toMatchObject({ localPath: "C:/cache/photo" });
  await vi.advanceTimersByTimeAsync(1_001);
  expect(store.getState().messages.get(chatId)?.some(item => item.id === "expires")).toBe(false);
});

it("uses current content and file state after yielding, preserving edits, deletion and archive-owned paths", async () => {
  const { store, transport } = await fixture();
  const chatId = store.getState().activeChatId!;
  const items = Array.from({ length: 100 }, (_, index): Message => ({ ...message(`shared-${index}`, chatId),
    isLocallyDeleted: index >= 90, content: { kind: "file", fileId: 91, fileName: "shared", sizeLabel: "1 KB",
      localPath: index >= 90 ? "C:/archive/independent" : undefined },
  }));
  transport.dispatch({ type: "messages.upserted", messages: items });
  transport.dispatch({ type: "file.updated", file: { fileId: 91, sizeLabel: "1 KB", localPath: "C:/cache/completed", isDownloaded: true } });
  transport.dispatch({ type: "message.upsert", message: { ...items[80], content: { kind: "text", text: "edited while yielded" } } });
  transport.dispatch({ type: "message.remove", chatId, messageId: "shared-81", permanent: true, source: "local" });
  transport.dispatch({ type: "file.updated", file: { fileId: 91, sizeLabel: "1 KB", localPath: undefined, isDownloaded: false, downloadedSize: 0 } });
  await vi.advanceTimersByTimeAsync(50);
  const read = (id: string) => store.getState().messages.get(chatId)?.find(item => item.id === id);
  expect(read("shared-80")?.content).toEqual({ kind: "text", text: "edited while yielded" });
  expect(read("shared-81")).toBeUndefined();
  expect(read("shared-89")?.content).toMatchObject({ localPath: undefined, isDownloaded: false });
  expect(read("shared-99")?.content).toMatchObject({ localPath: "C:/archive/independent", isDownloaded: true });
});
