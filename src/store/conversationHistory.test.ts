import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistory, HISTORY_REFRESH_PAGE_BUDGET, projectHistoryWindow, type ConversationHistoryState } from "./conversationHistory";
import type { ChatHistoryPage, HistoryPageRequest, Message } from "../telegram/types";
import { upsertMessages } from "./telegramStore.messages";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import { migrateCachedSnapshot } from "./telegramStore.cache";

const message = (id: number): Message => ({ id: String(id), chatId: "7", senderId: "11", outgoing: false,
  sentAt: new Date(1_700_000_000_000 + id * 1000).toISOString(), delivery: "sent", content: { kind: "text", text: `message ${id}` } });
const page = (ids: number[], hasMore = true): ChatHistoryPage => ({
  messages: ids.map(message), messageIds: ids.map(String), nextFromMessageId: String(ids.at(-1)), loadedCount: ids.length, hasMore,
});

const harness = (initial: Message[]) => {
  let messages = initial;
  let state: ConversationHistoryState | undefined;
  const request = vi.fn<(chatId: string, topicId: string | undefined, request: HistoryPageRequest) => Promise<ChatHistoryPage>>();
  const diagnostic = vi.fn();
  const history = new ConversationHistory({ online: () => true, active: () => true, messages: () => messages, state: () => state,
    request, diagnostic, error: vi.fn(),
    publish: (_chat, _topic, next, incoming) => { state = next; messages = upsertMessages(messages, incoming?.messages ?? []); },
  });
  return { history, request, diagnostic, state: () => state!, messages: () => messages,
    merge: (incoming: Message[]) => { messages = upsertMessages(messages, incoming); },
    visible: () => projectHistoryWindow(messages, state?.view),
  };
};

describe("conversation history ownership", () => {
  afterEach(() => vi.useRealTimers());

  it("admits restored deletion archives only as reader pages reach their history range", async () => {
    const retained = [1, 20, 40, 59, 61].map(id => ({ ...message(id), isLocallyDeleted: true }));
    const h = harness(upsertMessages([message(60), message(62)], retained));
    h.history.focus("7");
    expect(h.visible().map(m => m.id)).toEqual(["60", "61", "62"]);
    h.request.mockResolvedValueOnce(page([62, 60])).mockResolvedValueOnce(page([58, 39]))
      .mockResolvedValueOnce(page([19, 2], false));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    await h.history.older("7");
    expect(h.visible().map(m => m.id)).toEqual(["39", "40", "58", "59", "60", "61", "62"]);
    await h.history.older("7");
    expect(h.visible().map(m => m.id)).toEqual(["1", "2", "19", "20", "39", "40", "58", "59", "60", "61", "62"]);
    expect(h.messages().filter(m => m.isLocallyDeleted)).toHaveLength(5);
  });

  it("walks duplicate cached pages in one older request until the visible boundary advances", async () => {
    const h = harness(Array.from({ length: 60 }, (_, i) => message(i + 41)));
    h.request.mockImplementation(async (_chat, _topic, request) => {
      const from = request.fromMessageId ? Number(request.fromMessageId) - 1 : 100;
      return page(Array.from({ length: 10 }, (_, i) => from - i));
    });
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    await h.history.older("7");
    expect(h.visible()[0].id).toBe("31");
    expect(h.request).toHaveBeenCalledTimes(7);
  });

  it("does not join a distant context to latest through a restored archive", () => {
    const archived = { ...message(11), isLocallyDeleted: true };
    const h = harness([archived, message(99), message(100)]);
    h.history.focus("7", undefined, "10");
    h.history.context("7", undefined, "10", [message(10), message(11), message(12)]);
    h.merge([message(10), message(11), message(12)]);
    expect(h.state().view?.id).toBe("context:10");
    expect(h.visible().map(m => m.id)).toEqual(["10", "11", "12"]);
    h.history.focus("7");
    expect(h.visible().map(m => m.id)).toEqual(["99", "100"]);
  });

  it("includes archives inside a context, and permits explicit navigation to an older retained copy", () => {
    const retained = [1, 11, 20].map(id => ({ ...message(id), isLocallyDeleted: true }));
    const h = harness([...retained, message(100)]);
    h.history.focus("7", undefined, "10");
    h.history.context("7", undefined, "10", [message(10), message(12)]);
    h.merge([message(10), message(12)]);
    expect(h.visible().map(m => m.id)).toEqual(["10", "11", "12"]);
    h.history.focus("7", undefined, "1");
    expect(h.visible().map(m => m.id)).toEqual(["1"]);
    h.history.focus("7");
    expect(h.visible().map(m => m.id)).toEqual(["100"]);
  });

  it("keeps navigation to an archive inside the already loaded context", () => {
    const h = harness([{ ...message(11), isLocallyDeleted: true }, message(100)]);
    h.history.focus("7", undefined, "10");
    h.history.context("7", undefined, "10", [message(10), message(12)]);
    h.merge([message(10), message(12)]);
    h.history.focus("7", undefined, "11");
    expect(h.state().view?.id).toBe("context:10");
    expect(h.visible().map(m => m.id)).toEqual(["10", "11", "12"]);
  });

  it("admits a previously visited archive back into latest once pagination reaches it", async () => {
    const h = harness([{ ...message(1), isLocallyDeleted: true }, message(100)]);
    h.history.focus("7", undefined, "1");
    h.history.focus("7");
    h.request.mockResolvedValue(page([100, 2], false));
    await h.history.older("7");
    expect(h.visible().map(m => m.id)).toEqual(["1", "2", "100"]);
  });

  it("preserves an admitted oldest message when it is deleted or a refresh overlaps a warm cache", async () => {
    const h = harness([message(40), message(60), message(100)]);
    h.history.focus("7");
    h.merge([{ ...message(40), isLocallyDeleted: true }]);
    h.request.mockResolvedValue(page([100, 99, 98]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    expect(h.visible()[0]).toMatchObject({ id: "40", isLocallyDeleted: true });
  });

  it("bounds duplicate-page walking and resumes from the committed cursor", async () => {
    vi.useFakeTimers();
    const h = harness(Array.from({ length: 100 }, (_, i) => message(i + 1)));
    h.request.mockImplementation(async (_chat, _topic, request) => page([request.fromMessageId ? Number(request.fromMessageId) - 1 : 100]));
    await h.history.ensure("7");
    await vi.advanceTimersByTimeAsync(1);
    await h.history.older("7");
    expect(h.request).toHaveBeenCalledTimes(1 + HISTORY_REFRESH_PAGE_BUDGET);
    expect(h.state()).toMatchObject({ loading: false, hasMore: true });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.request).toHaveBeenCalledTimes(1 + HISTORY_REFRESH_PAGE_BUDGET);
    await h.history.older("7");
    expect(h.request.mock.calls[1 + HISTORY_REFRESH_PAGE_BUDGET][2].fromMessageId).toBe("91");
  });

  it("keeps a partial duplicate walk retryable after a timeout", async () => {
    vi.useFakeTimers();
    const h = harness([message(40), message(60), message(100)]);
    h.request.mockResolvedValueOnce(page([100, 99]));
    await h.history.ensure("7");
    await vi.advanceTimersByTimeAsync(1);
    h.request.mockResolvedValueOnce(page([98, 97])).mockRejectedValueOnce(new Error("timeout"));
    await h.history.older("7");
    expect(h.state()).toMatchObject({ loading: false, hasMore: true });
    h.request.mockResolvedValueOnce(page([39, 38]));
    await h.history.older("7");
    expect(h.request).toHaveBeenLastCalledWith("7", undefined, { purpose: "older", fromMessageId: "97" });
    expect(h.visible()[0].id).toBe("38");
    h.history.clear();
  });

  it("reveals all retained copies when an archive-only chat reaches a confirmed empty server history", async () => {
    const h = harness([1, 2].map(id => ({ ...message(id), isLocallyDeleted: true })));
    h.history.focus("7");
    expect(h.visible()).toEqual([]);
    h.request.mockResolvedValue({ messages: [], messageIds: [], loadedCount: 0, hasMore: false });
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    expect(h.visible().map(m => m.id)).toEqual(["1", "2"]);
  });

  it("does not let an old restored context expand archive coverage in latest", () => {
    const h = harness([message(10), { ...message(20), isLocallyDeleted: true }, message(100)]);
    h.history.restoreContexts([{ chatId: "7", targetId: "10", messageIds: ["10"] }]);
    expect(h.visible().map(m => m.id)).toEqual(["100"]);
    h.history.focus("7", undefined, "10");
    expect(h.visible().map(m => m.id)).toEqual(["10"]);
  });

  it("refreshes recent history without scanning toward a distant cached context", async () => {
    vi.useFakeTimers();
    const h = harness(Array.from({ length: 164 }, (_, i) => message(9837 + i)));
    const context = Array.from({ length: 31 }, (_, i) => message(100 + i));
    h.history.context("7", undefined, "115", context);
    h.merge(context);
    h.request.mockResolvedValue(page(Array.from({ length: 30 }, (_, i) => 10000 - i)));
    for (let cycle = 0; cycle < 4; cycle++) {
      h.history.invalidate();
      await h.history.ensure("7");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.request).toHaveBeenCalledTimes(cycle + 1);
      expect(h.state().recovery).toBe("complete");
      expect(h.visible()).toHaveLength(164);
      expect(h.messages()).toHaveLength(195);
    }
  });

  it("selects context windows synchronously and paginates from their own oldest message", async () => {
    const h = harness([message(99), message(100)]);
    h.history.focus("7", undefined, "11");
    h.history.context("7", undefined, "11", [message(10), message(11), message(12)]);
    h.merge([message(10), message(11), message(12)]);
    expect(h.visible().map(m => m.id)).toEqual(["10", "11", "12"]);
    h.request.mockResolvedValue(page([9, 8]));
    await h.history.older("7");
    expect(h.request).toHaveBeenLastCalledWith("7", undefined, { purpose: "older", fromMessageId: "10" });
    expect(h.visible().map(m => m.id)).toEqual(["8", "9", "10", "11", "12"]);
    h.history.focus("7");
    expect(h.visible().map(m => m.id)).toEqual(["99", "100"]);
  });

  it("joins an early unread context to the head page so later live messages stay visible", async () => {
    const h = harness([]);
    h.history.focus("7", undefined, "10");
    h.history.context("7", undefined, "10", [message(10), message(11)]);
    h.merge([message(10), message(11)]);
    expect(h.state().view?.id).toBe("context:10");
    h.request.mockResolvedValue(page([12, 11, 10]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    expect(h.state().view?.id).toBe("latest");
    h.merge([message(13)]);
    expect(h.visible().map(m => m.id)).toEqual(["10", "11", "12", "13"]);
  });

  it("uses the oldest message ID when a context's messages share one timestamp", async () => {
    const h = harness([message(100)]);
    h.history.focus("7", undefined, "11");
    const context = [12, 11, 10].map(id => ({ ...message(id), sentAt: message(10).sentAt }));
    h.history.context("7", undefined, "11", context);
    h.merge(context);
    h.request.mockResolvedValue(page([9, 8]));
    await h.history.older("7");
    expect(h.request).toHaveBeenLastCalledWith("7", undefined, { purpose: "older", fromMessageId: "10" });
  });

  it("keeps already paged context messages when another jump overlaps that window", async () => {
    const h = harness([message(100)]);
    h.history.focus("7", undefined, "11");
    h.history.context("7", undefined, "11", [message(10), message(11), message(12)]);
    h.merge([message(10), message(11), message(12)]);
    h.request.mockResolvedValue(page([9, 8]));
    await h.history.older("7");
    h.history.focus("7", undefined, "12");
    h.history.context("7", undefined, "12", [message(11), message(12), message(13)]);
    h.merge([message(11), message(12), message(13)]);
    expect(h.visible().map(m => m.id)).toEqual(["8", "9", "10", "11", "12", "13"]);
    expect(h.state().view?.id).toBe("context:11");
    await h.history.older("7");
    expect(h.request).toHaveBeenLastCalledWith("7", undefined, { purpose: "older", fromMessageId: "8" });
  });

  it("pauses a large recovery at a total page budget without scheduling another scan", async () => {
    vi.useFakeTimers();
    const h = harness([message(1)]);
    h.request.mockImplementation(async (_chat, _topic, request) => {
      const from = request.fromMessageId ? Number(request.fromMessageId) - 1 : 1000;
      return page(Array.from({ length: 30 }, (_, i) => from - i));
    });
    await h.history.ensure("7");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.request).toHaveBeenCalledTimes(HISTORY_REFRESH_PAGE_BUDGET);
    expect(h.state()).toMatchObject({ recovery: "paused", hasMore: true, loading: false });
    expect(h.messages().some(m => m.id === "1")).toBe(true);
    await h.history.older("7");
    expect(h.request.mock.calls[HISTORY_REFRESH_PAGE_BUDGET]?.[2]).toEqual({ purpose: "refresh", fromMessageId: "731" });
    expect(h.request).toHaveBeenCalledTimes(HISTORY_REFRESH_PAGE_BUDGET * 2);
  });

  it("keeps the older reader cursor across reconnect and rejects late pre-recovery pages", async () => {
    const h = harness([message(99), message(100)]);
    h.request.mockResolvedValueOnce(page([100, 99, 98]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    let resolve!: (page: ChatHistoryPage) => void;
    h.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const stale = h.history.older("7");
    h.history.invalidate();
    h.request.mockResolvedValue(page([102, 101, 100]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    resolve(page([97, 96]));
    await stale;
    expect(h.messages().some(m => m.id === "96")).toBe(false);
    await h.history.older("7");
    expect(h.request).toHaveBeenLastCalledWith("7", undefined, { purpose: "older", fromMessageId: "98" });
  });

  it("stops at a deleted refresh boundary without deleting its cached copy", async () => {
    const h = harness([message(100)]);
    h.request.mockResolvedValue(page([102, 101, 99]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.messages().some(m => m.id === "100")).toBe(true);
  });

  it("preserves context membership over cache restore and message replacement", () => {
    const h = harness([message(100)]);
    h.history.context("7", undefined, "11", [message(10), message(11)]);
    h.merge([message(10), message(11)]);
    const contexts = h.history.cachedContexts(h.messages());
    const restored = harness(h.messages());
    restored.history.restoreContexts(contexts);
    expect(restored.visible().map(m => m.id)).toEqual(["100"]);
    restored.history.focus("7", undefined, "11");
    expect(restored.visible().map(m => m.id)).toEqual(["10", "11"]);
    restored.history.replace("7", "11", "12");
    restored.merge([message(12)]);
    expect(restored.visible().map(m => m.id)).toEqual(["10", "12"]);
  });

  it("captures the recovery boundary before a new live message can advance it", async () => {
    const h = harness([message(100)]);
    h.history.focus("7");
    h.history.invalidate();
    h.merge([message(105)]);
    h.request.mockResolvedValueOnce(page([106, 105, 104])).mockResolvedValueOnce(page([103, 102, 101, 100]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.messages().map(m => m.id)).toContain("102");
  });

  it("retains unchanged message references through equivalent history refreshes", () => {
    const current = [message(100), message(101)];
    expect(upsertMessages(current, structuredClone(current))).toBe(current);
    const updated = upsertMessages(current, [{ ...message(100), content: { kind: "text", text: "edited" } }]);
    expect(updated[0]).not.toBe(current[0]);
    expect(updated[1]).toBe(current[1]);
  });

  it("limits stalled refresh retries and clears their ownership on an account reset", async () => {
    vi.useFakeTimers();
    const h = harness([message(100)]);
    h.request.mockResolvedValue({ messageIds: [], messages: [], loadedCount: 0, hasMore: true, stalled: true });
    await h.history.ensure("7");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.state().recovery).toBe("paused");
    h.history.clear();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.request).toHaveBeenCalledTimes(3);
    h.request.mockResolvedValue(page([101, 100]));
    await h.history.ensure("7");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state().recovery).toBe("complete");
  });

  it("does not clear the reader's loading state when a concurrent refresh finishes", async () => {
    const h = harness([message(100)]);
    h.request.mockResolvedValue(page([100, 99]));
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    h.history.invalidate();
    let resolve!: (page: ChatHistoryPage) => void;
    h.request.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(page([101, 100]));
    const reading = h.history.older("7");
    await h.history.ensure("7");
    await vi.waitFor(() => expect(h.state().recovery).toBe("complete"));
    expect(h.state().loading).toBe(true);
    resolve(page([98, 97]));
    await reading;
    expect(h.state().loading).toBe(false);
    expect(h.messages().map(m => m.id)).toEqual(["97", "98", "99", "100", "101"]);
  });

  it("saves and restores bounded context membership through the actual Store cache path", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const old = { ...message(1), id: "isolated-history", chatId: "chat-product" };
    vi.spyOn(transport, "getMessageContext").mockResolvedValue([old]);
    expect(await store.getState().loadMessage("chat-product", old.id, { forceContext: true })).toBe(true);
    expect(await store.getState().rebuildCachedSnapshot()).toBe(true);
    const snapshot = await transport.loadCachedSnapshot();
    expect(snapshot?.historyContexts).toContainEqual({ chatId: "chat-product", topicId: undefined, targetId: old.id, messageIds: [old.id] });
    const restored = createTelegramStore(new MockTelegramTransport({ cachedSnapshot: snapshot }));
    await restored.getState().initialize();
    const state = restored.getState();
    expect(state.messages.get("chat-product")?.some(m => m.id === old.id)).toBe(true);
    expect(projectHistoryWindow(state.messages.get("chat-product")!, state.histories.get("chat-product")?.view).some(m => m.id === old.id)).toBe(false);
    expect(migrateCachedSnapshot({ ...snapshot, historyContexts: [{ chatId: "chat-product", targetId: old.id, messageIds: [1] }] }))
      .toMatchObject({ health: "healthy", snapshot: { historyContexts: [] } });
  });

  it("isolates a single-message fallback when the context endpoint omits its target", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const old = { ...message(1), id: "fallback-target", chatId: "chat-product" };
    vi.spyOn(transport, "getMessageContext").mockResolvedValue([]);
    vi.spyOn(transport, "getMessage").mockResolvedValue(old);
    store.getState().focusHistoryWindow("chat-product", old.id);
    expect(await store.getState().loadMessage("chat-product", old.id)).toBe(true);
    expect(store.getState().histories.get("chat-product")?.view?.id).toBe(`context:${old.id}`);
    store.getState().focusHistoryWindow("chat-product");
    const state = store.getState();
    expect(projectHistoryWindow(state.messages.get("chat-product")!, state.histories.get("chat-product")?.view).some(m => m.id === old.id)).toBe(false);
  });
});
