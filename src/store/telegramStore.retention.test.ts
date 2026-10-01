import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { mockSnapshot } from "../telegram/mockData";
import type { HistoryPageRequest, Message, TelegramEvent } from "../telegram/types";
import type { TelegramEventListener } from "../telegram/transport";
import { createTelegramStore } from "./telegramStore";
import { HISTORY_MESSAGE_LIMIT, HISTORY_MESSAGE_TARGET } from "./historyRetention";
import { projectHistoryWindow } from "./conversationHistory";
import { MessageFileIndex } from "./messageFileIndex";

const message = (id: number, chatId = "chat-product"): Message => ({
  ...mockSnapshot.messages[0], id: String(id), chatId,
  sentAt: new Date(1_700_000_000_000 + id * 1_000).toISOString(),
  content: { kind: "text", text: `retention ${id}` }, outgoing: true,
  delivery: "sent", replyTo: undefined, isPending: false, isLocallyDeleted: false,
});

class RetentionTransport extends MockTelegramTransport {
  events?: TelegramEventListener;
  anchor = "12000";
  source = Array.from({ length: 12_000 }, (_, index) => message(index + 1));
  evictChatMessages = vi.fn();
  override async connect(listener: TelegramEventListener) { this.events = listener; return super.connect(listener); }
  override async loadChatHistory(chatId: string, limit = 30, request?: HistoryPageRequest) {
    const boundary = Number(request?.fromMessageId ?? 12001);
    const candidates = this.source.filter(item => request?.purpose === "newer" ? Number(item.id) > boundary : Number(item.id) < boundary);
    const items = request?.purpose === "newer" ? candidates.slice(0, limit) : candidates.slice(-limit).reverse();
    if (request?.purpose !== "newer" && items.length) this.anchor = items.at(-1)!.id;
    return { messages: items, messageIds: items.map(item => item.id), loadedCount: items.length,
      hasMore: candidates.length > items.length, nextFromMessageId: items.at(-1)?.id };
  }
  override async getMessageContext(chatId: string, id: string) {
    return this.source.filter(item => Math.abs(Number(item.id) - Number(id)) <= 15);
  }
  override async loadForumTopicHistory(chatId: string, topicId: string, limit = 30, request?: HistoryPageRequest) {
    return this.loadChatHistory(chatId, limit, request);
  }
  dispatch(event: TelegramEvent) { this.events?.(event); }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const fixture = async (reading = false, topicId?: string) => {
  vi.useFakeTimers();
  const transport = new RetentionTransport({ connectionStatus: "offline" });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.setState({ messages: new Map(), histories: new Map(), connectionStatus: "online" });
  if (topicId) {
    transport.source = transport.source.map(message => ({ ...message, topicId }));
    const chats = new Map(store.getState().chats);
    chats.set("chat-product", { ...chats.get("chat-product")!, isForum: true });
    store.setState({ chats, activeTopicId: topicId });
  }
  store.getState().registerHistoryRetentionViewport("chat-product", () => ({
    following: !reading, anchorId: reading ? transport.anchor : undefined, protectedIds: [], topicId,
  }));
  store.getState().focusHistoryWindow("chat-product", undefined, topicId);
  return { transport, store };
};

it("bounds repeated live updates and evicts file and transport indexes without tombstoning messages", async () => {
  const { transport, store } = await fixture();
  const captured = new Set<MessageFileIndex>();
  const upsert = MessageFileIndex.prototype.upsert;
  vi.spyOn(MessageFileIndex.prototype, "upsert").mockImplementation(function (this: MessageFileIndex, items) {
    captured.add(this); return upsert.call(this, items);
  });
  for (let round = 0; round < 12; round++) {
    transport.dispatch({ type: "messages.upserted", messages: transport.source.slice(round * 1000, (round + 1) * 1000) });
    expect(store.getState().messages.get("chat-product")!.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
  }
  const stored = store.getState().messages.get("chat-product")!;
  expect(stored.at(-1)!.id).toBe("12000");
  expect(stored.some(item => item.id === "1")).toBe(false);
  expect(Math.max(...[...captured].map(index => index.all().length))).toBe(stored.length);
  expect(transport.evictChatMessages).toHaveBeenCalled();
  expect(await store.getState().loadMessage("chat-product", "1", { forceContext: true })).toBe(true);
  expect(store.getState().messages.get("chat-product")!.some(item => item.id === "1")).toBe(true);
});

it("bounds 400 older pages, keeps the reader separate from latest and pages newer without skipping the gap", async () => {
  const { transport, store } = await fixture(true);
  for (let turn = 0; turn < 400; turn++) {
    await store.getState().loadMoreHistory("chat-product");
    expect(store.getState().messages.get("chat-product")!.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
  }
  let state = store.getState();
  expect(state.messages.get("chat-product")![0].id).toBe("1");
  expect(state.messages.get("chat-product")!.at(-1)!.id).toBe("12000");
  const visible = projectHistoryWindow(state.messages.get("chat-product")!, state.histories.get("chat-product")?.view);
  expect(visible[0].id).toBe("1");
  expect(visible.at(-1)!.id).not.toBe("12000");
  expect(state.histories.get("chat-product")?.view?.hasNewer).toBe(true);
  const boundary = Number(visible.at(-1)!.id);
  await state.loadNewerHistory("chat-product");
  state = store.getState();
  const nextVisible = projectHistoryWindow(state.messages.get("chat-product")!, state.histories.get("chat-product")?.view);
  expect(nextVisible.slice(-30).map(item => Number(item.id))).toEqual(Array.from({ length: 30 }, (_, index) => boundary + index + 1));
  for (let turn = 0; turn < 400 && state.histories.get("chat-product")?.view?.hasNewer; turn++) {
    const view = state.histories.get("chat-product")!.view!;
    const previous = Number(view.newest!.id);
    transport.anchor = view.newest!.id;
    await state.loadNewerHistory("chat-product");
    state = store.getState();
    const next = Number(state.histories.get("chat-product")!.view!.newest!.id);
    expect(next).toBeGreaterThan(previous);
    expect(state.messages.get("chat-product")!.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
  }
  expect(state.histories.get("chat-product")?.view?.id).toBe("latest");
  state.focusHistoryWindow("chat-product");
  expect(projectHistoryWindow(store.getState().messages.get("chat-product")!, store.getState().histories.get("chat-product")?.view).at(-1)!.id).toBe("12000");
});

it("does not treat native publication of a fetched newer page as overlap with latest", async () => {
  const { transport, store } = await fixture(true);
  for (let turn = 0; turn < 100; turn++) await store.getState().loadMoreHistory("chat-product");
  const read = transport.loadChatHistory.bind(transport);
  vi.spyOn(transport, "loadChatHistory").mockImplementation(async (...args) => {
    const page = await read(...args);
    transport.dispatch({ type: "messages.upserted", messages: page.messages, cacheRelevant: false });
    return page;
  });
  await store.getState().loadNewerHistory("chat-product");
  expect(store.getState().histories.get("chat-product")?.view?.id).toMatch(/^retained:/);
});

it("does not replace a newly selected reply context when an older newer-page request rejoins latest", async () => {
  const { transport, store } = await fixture(true);
  for (let turn = 0; turn < 100; turn++) await store.getState().loadMoreHistory("chat-product");
  let overlaps = false;
  for (let turn = 0; turn < 400; turn++) {
    const state = store.getState();
    const view = state.histories.get("chat-product")!.view!;
    const boundary = Number(view.newest!.id);
    overlaps = state.messages.get("chat-product")!.some(message => !view.excludedIds.has(message.id) &&
      Number(message.id) > boundary && Number(message.id) <= boundary + 30);
    if (overlaps) break;
    transport.anchor = view.newest!.id;
    await state.loadNewerHistory("chat-product");
  }
  expect(overlaps).toBe(true);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const read = transport.loadChatHistory.bind(transport);
  vi.spyOn(transport, "loadChatHistory").mockImplementation(async (...args) => {
    if (args[2]?.purpose === "newer") await held;
    return read(...args);
  });
  const pending = store.getState().loadNewerHistory("chat-product");
  await store.getState().loadMessage("chat-product", "1", { forceContext: true });
  store.getState().focusHistoryWindow("chat-product", "1");
  const selected = store.getState().histories.get("chat-product")!.view!.id;
  expect(selected).toBe("context:1");
  release();
  await pending;
  expect(store.getState().histories.get("chat-product")!.view!.id).toBe(selected);
});

it("retries deferred eviction on the existing idle cache callback after the viewport closes", async () => {
  const { transport, store } = await fixture();
  const dispose = store.getState().registerHistoryRetentionViewport("chat-product", () => ({
    following: true, protectedIds: [], busy: true,
  }));
  transport.dispatch({ type: "messages.upserted", messages: transport.source.slice(0, 5000) });
  expect(store.getState().messages.get("chat-product")).toHaveLength(5000);
  dispose();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.getState().messages.get("chat-product")).toHaveLength(HISTORY_MESSAGE_TARGET);
  expect(transport.evictChatMessages).toHaveBeenCalled();
});

it("bounds forum history and keeps its topic reader independently pageable", async () => {
  const { store, transport } = await fixture(true, "1");
  for (let turn = 0; turn < 200; turn++) await store.getState().loadMoreHistory("chat-product");
  const before = store.getState();
  const view = before.topicHistories.get("chat-product:topic:1")!.view!;
  expect(view.id).toMatch(/^retained:/);
  expect(view.hasNewer).toBe(true);
  expect(before.messages.get("chat-product")!.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
  const boundary = Number(view.newest!.id);
  await before.loadNewerHistory("chat-product", "1");
  expect(Number(store.getState().topicHistories.get("chat-product:topic:1")!.view!.newest!.id)).toBe(boundary + 30);
  expect(transport.evictChatMessages).toHaveBeenCalled();
});

it("keeps archives, failed sends and draft replies while bounding ordinary history", async () => {
  const { transport, store } = await fixture();
  store.getState().updateChatDraft("chat-product", "reply", "10");
  const special = [{ ...message(1), isLocallyDeleted: true }, { ...message(2), delivery: "failed" as const }];
  transport.dispatch({ type: "messages.upserted", messages: [...special, ...transport.source.slice(2, 5000)] });
  const items = store.getState().messages.get("chat-product")!;
  expect(items.some(item => item.id === "1" && item.isLocallyDeleted)).toBe(true);
  expect(items.some(item => item.id === "2" && item.delivery === "failed")).toBe(true);
  expect(items.some(item => item.id === "10")).toBe(true);
  expect(items.length).toBeLessThanOrEqual(HISTORY_MESSAGE_TARGET + 3);
});
