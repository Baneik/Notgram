import { describe, expect, it, vi } from "vitest";
import { createTelegramStore } from "./telegramStore";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { Message } from "../telegram/types";

describe("channel discussion history", () => {
  it("continues short pages from the resolved group cursor without marking the group read", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-release");
    const post = store.getState().messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const root: Message = { ...post, chatId: "linked-group", id: "thread-root", isChannelPost: false };
    const comments = Array.from({ length: 150 }, (_, index): Message => ({ ...root, id: String(1000-index),
      replyTo: { kind: "message", chatId: root.chatId, messageId: root.id } }));
    const resolve = vi.spyOn(transport, "getMessageThread").mockResolvedValue({ chatId: root.chatId, messageId: root.id, messages: [root] });
    const history = vi.spyOn(transport, "getMessageThreadHistory").mockImplementation(async (_chatId, _messageId, _limit, before) => {
      const start = before ? comments.findIndex(message => message.id === before) : 0;
      const messages = comments.slice(start, start + 20);
      const nextFromMessageId = messages.at(-1)?.id;
      return { messages, nextFromMessageId, hasMore: nextFromMessageId !== before };
    });
    const read = vi.spyOn(transport, "markChatRead");
    read.mockClear();
    const first = await store.getState().loadMessageThreadHistory(post.chatId, post.id);
    expect(first).toMatchObject({ chatId: root.chatId, messageId: root.id, hasMore: true, nextFromMessageId: "981" });
    const second = await store.getState().loadMessageThreadHistory(post.chatId, post.id, 100, first!.nextFromMessageId);
    expect(second).toMatchObject({ hasMore: true, nextFromMessageId: "962" });
    expect(history).toHaveBeenLastCalledWith(root.chatId, root.id, 100, "981");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(store.getState().messages.get(root.chatId)).toHaveLength(40);
    expect(read).not.toHaveBeenCalledWith(root.chatId);
    transport.disconnect();
  });

  it("reports a failed history page while retaining its resolved root for retry", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    vi.spyOn(transport, "getMessageThreadHistory").mockRejectedValue(new Error("temporary failure"));
    const result = await store.getState().loadMessageThreadHistory("chat-release", "release-post-1");
    expect(result).toMatchObject({ error: true, hasMore: true });
    expect(result?.messages.some(message => message.id === "release-post-1")).toBe(true);
    expect(store.getState().messages.get("chat-release")?.find(message => message.id === "release-post-1")?.discussionThread)
      .toEqual({ chatId: "chat-release", messageId: "release-post-1" });
    transport.disconnect();
  });
});
