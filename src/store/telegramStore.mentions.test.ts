import { describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { ChatMessageSearchInput, ChatMessageSearchPage, Message, TelegramEvent } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";
import { cachedSnapshotFrom } from "./telegramStore.cache";

class MentionTransport extends MockTelegramTransport {
  private events?: TelegramEventListener;
  search = vi.fn<(input: ChatMessageSearchInput) => Promise<ChatMessageSearchPage>>()
    .mockResolvedValue({ messages: [], hasMore: false });
  reads = vi.fn<(chatId: string, ids: string[]) => Promise<void>>().mockResolvedValue();

  override async connect(listener: TelegramEventListener) {
    this.events = listener;
    return super.connect(listener);
  }
  override searchChatMessages(input: ChatMessageSearchInput) {
    return input.filter === "unreadMention" ? this.search(input) : super.searchChatMessages(input);
  }
  override markMessageAttentionRead(chatId: string, ids: string[]) {
    return this.reads(chatId, ids);
  }
  dispatch(event: TelegramEvent) { this.events?.(event); }
}

const setup = async () => {
  const transport = new MentionTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  await vi.waitFor(() => expect(store.getState().messages.get("chat-product")?.length).toBeGreaterThan(0));
  const template = store.getState().messages.get("chat-product")![0];
  const mention = (id: string, extra: Partial<Message> = {}): Message => ({
    ...template, id, outgoing: false, containsUnreadMention: true, containsUnreadReaction: false,
    sentAt: "2026-07-01T00:00:00Z", replyTo: undefined, ...extra,
  });
  const count = (unreadMentionCount: number) => transport.dispatch({ type: "chat.upsert",
    chat: { ...store.getState().chats.get("chat-product")!, unreadMentionCount } });
  const ids = () => store.getState().unreadAttentionMessageIds.get("chat-product") ?? [];
  return { transport, store, mention, count, ids };
};

describe("unread mention recovery", () => {
  it("indexes historical unread mentions but not already read replies", async () => {
    const { transport, mention, ids } = await setup();
    transport.dispatch({ type: "messages.upserted", messages: [mention("old-mention"),
      mention("old-read-reply", { containsUnreadMention: false,
        replyTo: { kind: "message", messageId: "own-message", outgoing: true } })] });
    expect(ids()).toEqual(["old-mention"]);
  });

  it("restores cached mention IDs before the connection finishes", async () => {
    const { transport, store, mention } = await setup();
    transport.dispatch({ type: "messages.upserted", messages: [mention("cached-mention", {
      sentAt: "2026-09-01T00:00:00Z",
    })] });
    const cachedSnapshot = cachedSnapshotFrom(store.getState());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    class DelayedTransport extends MentionTransport {
      override async connect(listener: TelegramEventListener) {
        await gate;
        return super.connect(listener);
      }
    }
    const restored = createTelegramStore(new DelayedTransport({ cachedSnapshot }));
    const initialization = restored.getState().initialize();
    try {
      await vi.waitFor(() => expect(restored.getState().unreadAttentionMessageIds.get("chat-product"))
        .toContain("cached-mention"));
    } finally {
      release();
      await initialization;
    }
  });

  it("recovers missing IDs across pages without changing the history window or marking them read", async () => {
    const { transport, store, mention, count, ids } = await setup();
    count(2);
    const history = store.getState().histories.get("chat-product");
    transport.search.mockResolvedValueOnce({ messages: [mention("newer")], hasMore: true, nextFromMessageId: "newer" })
      .mockResolvedValueOnce({ messages: [mention("older")], hasMore: false });
    await Promise.all([store.getState().refreshUnreadMentions("chat-product"),
      store.getState().refreshUnreadMentions("chat-product")]);
    expect(transport.search).toHaveBeenCalledTimes(2);
    expect(transport.search.mock.calls[1][0].fromMessageId).toBe("newer");
    expect(new Set(ids())).toEqual(new Set(["newer", "older"]));
    expect(store.getState().histories.get("chat-product")).toBe(history);
    expect(transport.reads).not.toHaveBeenCalled();
  });

  it("waits for authoritative mention reads and consumes only the visible IDs", async () => {
    const { transport, store, mention, count, ids } = await setup();
    count(2);
    const first = mention("first", { replyTo: { kind: "message", messageId: "own", outgoing: true } });
    const second = mention("second");
    transport.dispatch({ type: "messages.upserted", messages: [first, second] });
    store.getState().dismissMessageAttention("chat-product", [first.id]);
    await vi.waitFor(() => expect(transport.reads).toHaveBeenCalledOnce());
    expect(ids()).toEqual([first.id, second.id]);
    store.getState().dismissMessageAttention("chat-product", [first.id]);
    expect(transport.reads).toHaveBeenCalledOnce();
    count(1);
    transport.dispatch({ type: "message.upsert", message: { ...first, containsUnreadMention: false } });
    expect(ids()).toEqual([second.id]);
    expect(transport.reads).toHaveBeenCalledWith("chat-product", [first.id]);
    count(0);
    expect(ids()).toEqual([]);
    expect(store.getState().messages.get("chat-product")?.find(message => message.id === second.id)
      ?.containsUnreadMention).toBe(false);
  });

  it("keeps unrelated local replies when the server clears its mention count", async () => {
    const { transport, mention, count, ids } = await setup();
    count(1);
    transport.dispatch({ type: "message.upsert", message: mention("local-reply", {
      containsUnreadMention: false, replyTo: { kind: "message", messageId: "own", outgoing: true },
    }), animateEntrance: true });
    transport.dispatch({ type: "messages.upserted", messages: [mention("server-mention")] });
    count(0);
    expect(ids()).toEqual(["local-reply"]);
  });

  for (const update of ["read", "deleted", "account", "count-zero", "count-decreased"] as const) {
    it(`ignores a delayed search after ${update}`, async () => {
      const { transport, store, mention, count, ids } = await setup();
      count(2);
      const message = mention("stale");
      let release!: (page: ChatMessageSearchPage) => void;
      transport.search.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const refresh = store.getState().refreshUnreadMentions("chat-product");
      if (update === "read") {
        transport.dispatch({ type: "message.upsert", message: { ...message, containsUnreadMention: false } });
      } else if (update === "deleted") {
        transport.dispatch({ type: "message.remove", chatId: "chat-product", messageId: message.id,
          source: "remote", permanent: true });
      } else if (update === "account") {
        transport.dispatch({ type: "authorization.changed", state: { kind: "closed" } });
      } else count(update === "count-decreased" ? 1 : 0);
      release({ messages: [message], hasMore: false });
      await refresh;
      expect(ids()).not.toContain(message.id);
      expect(store.getState().messages.get("chat-product")?.find(item => item.id === message.id)
        ?.containsUnreadMention).not.toBe(true);
    });
  }

  it("preserves the count on failure and allows an explicit retry", async () => {
    const { transport, store, mention, count, ids } = await setup();
    count(1);
    transport.search.mockRejectedValueOnce(new Error("Search unavailable"))
      .mockResolvedValueOnce({ messages: [mention("retry")], hasMore: false });
    await store.getState().refreshUnreadMentions("chat-product");
    expect(store.getState().chats.get("chat-product")?.unreadMentionCount).toBe(1);
    expect(store.getState().operationError).toBe("Search unavailable");
    await store.getState().refreshUnreadMentions("chat-product");
    expect(ids()).toEqual(["retry"]);
    expect(store.getState().operationError).toBeUndefined();
  });

  it("preserves offline mention counts and recovers when online again", async () => {
    const { transport, store, mention, count, ids } = await setup();
    count(1);
    transport.search.mockResolvedValue({ messages: [mention("reconnected")], hasMore: false });
    transport.dispatch({ type: "connection.changed", status: "offline" });
    await store.getState().refreshUnreadMentions("chat-product");
    expect(transport.search).not.toHaveBeenCalled();
    expect(store.getState().chats.get("chat-product")?.unreadMentionCount).toBe(1);
    transport.dispatch({ type: "connection.changed", status: "online" });
    await store.getState().refreshUnreadMentions("chat-product");
    expect(ids()).toContain("reconnected");
  });

  it("retries a failed visible read without consuming its unread state", async () => {
    const { transport, store, mention, count, ids } = await setup();
    count(1);
    transport.dispatch({ type: "messages.upserted", messages: [mention("visible")] });
    transport.reads.mockRejectedValueOnce(new Error("Read unavailable"));
    store.getState().dismissMessageAttention("chat-product", ["visible"]);
    await vi.waitFor(() => expect(store.getState().operationError).toBe("Read unavailable"));
    expect(ids()).toEqual(["visible"]);
    expect(store.getState().chats.get("chat-product")?.unreadMentionCount).toBe(1);
    store.getState().dismissMessageAttention("chat-product", ["visible"]);
    await vi.waitFor(() => expect(transport.reads).toHaveBeenCalledTimes(2));
    expect(ids()).toEqual(["visible"]);
    count(0);
    expect(ids()).toEqual([]);
  });

  it("does not restore attention from locally retained deleted messages", async () => {
    const { transport, mention, ids } = await setup();
    transport.dispatch({ type: "messages.upserted", messages: [mention("archived", { isLocallyDeleted: true })] });
    expect(ids()).toEqual([]);
  });
});
