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
