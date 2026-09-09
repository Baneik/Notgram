import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { mockSnapshot } from "../telegram/mockData";
import type { TelegramEventListener } from "../telegram/transport";
import type { ChatHistoryPage, Message } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";
import { pendingCachedIdsAfterConfirmation, reachedCachedHistoryBoundary } from "./telegramStore.messages";

const message = (id: string): Message => ({
  ...structuredClone(mockSnapshot.messages.find((item) => item.chatId === "chat-product")!),
  id,
  sentAt: "2026-09-08T00:00:00.000Z",
});
class RecoveryTransport extends MockTelegramTransport {
  events?: TelegramEventListener;
  source = [message("before-sleep")];
  historyCalls = 0;
  failNext = false;
  listCalls = 0;
  override async connect(listener: TelegramEventListener) {
    this.events = listener;
    return super.connect(listener);
  }
  override async loadMoreChats() {
    this.listCalls += 1;
    return { hasMore: false, loadedCount: 0 };
  }
  override async loadChatHistory(chatId: string): Promise<ChatHistoryPage> {
    if (chatId !== "chat-product") return super.loadChatHistory(chatId);
    this.historyCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("history timeout");
    }
    return { messages: this.source, messageIds: this.source.map((item) => item.id), loadedCount: this.source.length, hasMore: false };
  }
}

describe("Store recovery synchronization", () => {
  afterEach(() => vi.useRealTimers());

  it("stops backfilling past the cached range without inferring deletion of missing IDs", () => {
    const cached = new Set(["100", "110"]);
    const returned = new Set(["120", "110", "99"]);
    expect(reachedCachedHistoryBoundary(cached, new Set(["120", "110"]))).toBe(false);
    expect(reachedCachedHistoryBoundary(cached, returned)).toBe(true);
    expect(pendingCachedIdsAfterConfirmation(cached, returned)).toEqual(new Set(["100"]));
  });

  it("bridges more than one page of new forum messages back to the cached topic", async () => {
    class ForumRecoveryTransport extends RecoveryTransport {
      topicSource = [{ ...message("old-topic"), chatId: "chat-forum", topicId: "1" }];
      offset = 0;
      pages = 0;
      override resetSyncState() { super.resetSyncState(); this.offset = 0; }
      override async loadForumTopicHistory(chatId: string, topicId: string, limit = 30): Promise<ChatHistoryPage> {
        if (chatId !== "chat-forum" || topicId !== "1") return super.loadForumTopicHistory(chatId, topicId, limit);
        this.pages += 1;
        const messages = this.topicSource.slice(this.offset, this.offset + limit);
        this.offset += messages.length;
        return { messages, messageIds: messages.map((item) => item.id), loadedCount: messages.length, hasMore: this.offset < this.topicSource.length };
      }
    }
    const transport = new ForumRecoveryTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-forum");
    await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.length).toBeGreaterThan(0));
    await store.getState().selectForumTopic("1");
    await vi.waitFor(() => expect(store.getState().messages.get("chat-forum")?.some((item) => item.id === "old-topic")).toBe(true));
    const missed = Array.from({ length: 65 }, (_, index) => ({ ...message(`missed-${index}`), chatId: "chat-forum", topicId: "1" }));
    transport.topicSource = [...missed, ...transport.topicSource];
    transport.pages = 0;
    transport.setConnectionStatus("waitingForNetwork");
    transport.setConnectionStatus("online");
    await vi.waitFor(() => expect(store.getState().messages.get("chat-forum")?.filter((item) => item.id.startsWith("missed-"))).toHaveLength(65));
    expect(transport.pages).toBe(3);
    expect(store.getState().messages.get("chat-forum")?.some((item) => item.id === "old-topic")).toBe(true);
  });

  it.each(["reconnect", "wake"])("refreshes exhausted history and lists after %s without discarding visible messages", async (reason) => {
    const transport = new RecoveryTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().loadMoreChats();
    expect(store.getState().histories.get("chat-product")?.hasMore).toBe(false);
    const previousMessages = store.getState().messages;
    transport.source = [message("after-sleep"), ...transport.source];
    if (reason === "reconnect") {
      transport.setConnectionStatus("waitingForNetwork");
      transport.setConnectionStatus("online");
    } else {
      transport.events?.({ type: "sync.required" });
    }
    expect(store.getState().messages).toBe(previousMessages);
    await vi.waitFor(() => expect(store.getState().messages.get("chat-product")?.map((item) => item.id))
      .toEqual(expect.arrayContaining(["before-sleep", "after-sleep"])));
    expect(transport.historyCalls).toBe(2);
    expect(transport.listCalls).toBe(2);
  });

  it("does not let a pre-recovery page overwrite the new history state", async () => {
    const transport = new RecoveryTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.setState({ histories: new Map([["chat-product", { initialized: true, loading: false, hasMore: true }]]) });
    let finishOld!: (page: ChatHistoryPage) => void;
    vi.spyOn(transport, "loadChatHistory").mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const oldLoad = store.getState().loadMoreHistory("chat-product");
    transport.source = [message("after-sleep"), ...transport.source];
    transport.setConnectionStatus("waitingForNetwork");
    transport.setConnectionStatus("online");
    await vi.waitFor(() => expect(store.getState().messages.get("chat-product")?.some((item) => item.id === "after-sleep")).toBe(true));
    finishOld({ messages: [message("obsolete")], messageIds: ["obsolete"], loadedCount: 1, hasMore: true });
    await oldLoad;
    expect(store.getState().messages.get("chat-product")?.some((item) => item.id === "obsolete")).toBe(false);
    expect(store.getState().histories.get("chat-product")?.hasMore).toBe(false);
  });

  it.each(["chat-product", "chat-forum"])("keeps cached %s usable while deduplicating background refreshes", async (chatId) => {
    const transport = new RecoveryTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat(chatId);
    if (chatId === "chat-forum") {
      await vi.waitFor(() => expect(store.getState().activeTopicId).toBeDefined());
    }
    const topicId = store.getState().activeTopicId;
    const key = topicId ? `${chatId}:topic:${topicId}` : chatId;
    const history = () => (topicId ? store.getState().topicHistories : store.getState().histories).get(key);
    await vi.waitFor(() => expect(history()?.loading).toBe(false));
    let finish!: (page: ChatHistoryPage) => void;
    const request = vi.spyOn(transport, topicId ? "loadForumTopicHistory" : "loadChatHistory")
      .mockImplementationOnce(() => new Promise<ChatHistoryPage>((resolve) => { finish = resolve; }));
    const previous = store.getState().messages;
    transport.events?.({ type: "sync.required" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(history()).toMatchObject({ loading: true, background: true });
    expect(store.getState().messages).toBe(previous);
    const duplicate = store.getState().loadMoreHistory(chatId);
    expect(request).toHaveBeenCalledTimes(1);
    finish({ messages: [], messageIds: [], loadedCount: 0, hasMore: false });
    await duplicate;
    await vi.waitFor(() => expect(history()?.loading).toBe(false));
    expect(history()?.background).toBeFalsy();
  });

  it("retries a transient history error while the connection stays online", async () => {
    vi.useFakeTimers();
    const transport = new RecoveryTransport();
    transport.failNext = true;
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    expect(store.getState().operationError).toBe("history timeout");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.historyCalls).toBe(2);
    expect(store.getState().messages.get("chat-product")?.some((item) => item.id === "before-sleep")).toBe(true);
    expect(store.getState().histories.get("chat-product")?.loading).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.historyCalls).toBe(2);
  });

  it("refreshes the selected forum topic even after its history reached the end", async () => {
    const transport = new MockTelegramTransport();
    const history = vi.spyOn(transport, "loadForumTopicHistory");
    const topics = vi.spyOn(transport, "getForumTopics");
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-forum");
    await vi.waitFor(() => expect(store.getState().activeTopicId).toBeDefined());
    const topicId = store.getState().activeTopicId!;
    await vi.waitFor(() => expect(history).toHaveBeenCalled());
    history.mockClear();
    topics.mockClear();
    transport.setConnectionStatus("waitingForNetwork");
    transport.setConnectionStatus("online");
    await vi.waitFor(() => expect(history).toHaveBeenCalledWith("chat-forum", topicId, 30));
    expect(topics).toHaveBeenCalled();
    expect(store.getState().activeTopicId).toBe(topicId);
  });
});
