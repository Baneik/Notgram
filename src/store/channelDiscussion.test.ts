import { describe, expect, it, vi } from "vitest";
import { createTelegramStore } from "./telegramStore";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { Message } from "../telegram/types";
import { channelDiscussionProjection } from "./telegramStore.messages";
import { attachmentOutbox } from "./attachmentOutbox";
import { cachedSnapshotFrom, migrateCachedSnapshot } from "./telegramStore.cache";

describe("channel discussion history", () => {
  it("restores separate local drafts for two posts sharing a discussion group", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.getState().updateThreadDraft("channel:discussion:post-1", "chat-product", "first post draft");
    store.getState().updateThreadDraft("channel:discussion:post-2", "chat-product", "second post draft");
    const snapshot = cachedSnapshotFrom(store.getState());
    const restoredTransport = new MockTelegramTransport({ cachedSnapshot: snapshot });
    const restored = createTelegramStore(restoredTransport);
    await restored.getState().initialize();
    expect(restored.getState().drafts.get("channel:discussion:post-1")?.text).toBe("first post draft");
    expect(restored.getState().drafts.get("channel:discussion:post-2")?.text).toBe("second post draft");
    transport.disconnect();
    restoredTransport.disconnect();
  });
  it("keeps offline replies and attachments in their thread, including persisted retry state", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-release");
    const source = store.getState().messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const post = { ...source, discussionThread: { chatId: "linked-group", messageId: "root" } };
    const comment: Message = { ...source, id: "comment", chatId: "linked-group", messageThreadId: "root", isChannelPost: false,
      replyTo: { kind: "message", chatId: "linked-group", messageId: "root" } };
    const messages = new Map(store.getState().messages);
    messages.set(post.chatId, [post]);
    messages.set(comment.chatId, [comment]);
    const groupDraft = { chatId: comment.chatId, text: "ordinary group draft", updatedAt: new Date().toISOString() };
    store.setState({ messages, connectionStatus: "offline", drafts: new Map([[comment.chatId, groupDraft]]) });
    const saved = vi.spyOn(transport, "saveCachedSnapshot");
    const put = vi.spyOn(attachmentOutbox, "put").mockResolvedValue(undefined);
    try {
      expect(await store.getState().sendMessageToThread(comment.chatId, comment.id, "offline nested reply", undefined, undefined, { disableNotification: true })).toBe(true);
      expect(await store.getState().sendFilesToThread(comment.chatId, comment.id,
        [{ kind: "document", file: new File(["file"], "reply.txt") }], "attachment caption", undefined, undefined, { threadId: "root" })).toBe(true);
      const projection = channelDiscussionProjection(post, store.getState().messages);
      expect(projection.comments.filter(message => message.id.startsWith("outbox:"))).toHaveLength(2);
      expect(store.getState().drafts.get(comment.chatId)).toEqual(groupDraft);
      expect(store.getState().outbox[0]).toMatchObject({ discussionThreadId: "root", replyToMessageId: "comment", clearDraft: false, disableNotification: true });
      const snapshot = migrateCachedSnapshot(saved.mock.calls.at(-1)![0]).snapshot!;
      expect(snapshot.outbox?.every(item => item.discussionThreadId === "root")).toBe(true);
      expect(snapshot.outbox?.[0].clearDraft).toBe(false);
    } finally { put.mockRestore(); transport.disconnect(); }
  });

  it("does not report an unaccepted discussion attachment as sent", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    vi.spyOn(transport, "sendFiles").mockResolvedValue(false);
    expect(await store.getState().sendFilesToThread("linked-group", "root", [{ kind: "document", file: new File(["file"], "file.txt") }])).toBe(false);
    transport.disconnect();
  });

  it("uses cached action permissions while offline instead of covering the composer with a lookup error", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-release");
    const permissions = { canReply: true, canEdit: false, canDeleteOnlyForSelf: true, canDeleteForAllUsers: false, canForward: true };
    const messages = new Map(store.getState().messages);
    messages.set("chat-release", messages.get("chat-release")!.map(message => ({ ...message, permissions })));
    store.setState({ messages, connectionStatus: "offline" });
    const request = vi.spyOn(transport, "getMessageProperties");
    expect(await store.getState().loadMessageProperties("chat-release", "release-post-1", true)).toEqual(permissions);
    expect(request).not.toHaveBeenCalled();
    transport.disconnect();
  });
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
