import { expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import { FORUM_ALL_TOPIC_ID, type Message } from "../telegram/types";

it("clears the sidebar count after reading every topic without clearing other topics prematurely", async () => {
  const transport = new MockTelegramTransport();
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(0));
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "18")?.unreadCount).toBe(1);
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  const message: Message = { ...store.getState().messages.get("chat-forum")!.find(item => item.topicId === "12")!,
    id: "design-incoming", topicId: "18", sentAt: "2026-08-01T09:50:00+08:00" };
  store.setState({ messages: new Map(store.getState().messages).set("chat-forum", [
    ...store.getState().messages.get("chat-forum")!, message,
  ]) });
  // Give the mock server the same incoming message as the Store.
  (transport as unknown as { snapshot: { messages: Message[] } }).snapshot.messages.push(message);
  store.getState().selectForumTopic("18");
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0));
  await transport.disconnect();
});

it.each(["select", "reopen"])("reads the group in All through %s and clears its sidebar badge", async entry => {
  const transport = new MockTelegramTransport();
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "1" });
  await vi.waitFor(() => expect(store.getState().messages.get("chat-forum")?.some(message => message.topicId === "1")).toBe(true));
  if (entry === "select") store.getState().selectForumTopic(FORUM_ALL_TOPIC_ID);
  else {
    store.getState().selectChat("chat-mia");
    store.getState().selectChat("chat-forum", { forumTopicId: FORUM_ALL_TOPIC_ID });
  }
  await vi.waitFor(() => expect(chatReads).toHaveBeenCalledWith("chat-forum"));
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0);
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.every(topic => topic.unreadCount === 0)).toBe(true));
  await transport.disconnect();
});

it("does not treat a pending first topic selection as All", async () => {
  const transport = new MockTelegramTransport();
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.setState({ activeChatId: "chat-forum", activeTopicId: undefined, lastForumTopicIds: new Map() });
  await store.getState().markActiveChatRead();
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(4);
  await transport.disconnect();
});

it("does not erase newer unread messages arriving while a topic read is pending", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(0));
  let finish!: () => void;
  vi.spyOn(transport, "markForumTopicRead").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const topics = store.getState().forumTopics.get("chat-forum")!.map(topic => topic.id === "12" ? { ...topic, unreadCount: 1 } : topic);
  store.setState({ forumTopics: new Map(store.getState().forumTopics).set("chat-forum", topics) });
  const reading = store.getState().markActiveChatRead();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const newer = { ...store.getState().messages.get("chat-forum")!.find(message => message.topicId === "12")!,
    id: "new-incoming", sentAt: "2026-08-01T10:00:00+08:00" };
  store.setState({ messages: new Map(store.getState().messages).set("chat-forum", [...store.getState().messages.get("chat-forum")!, newer]) });
  finish();
  await reading;
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(1);
  await transport.disconnect();
});

it("settles an old count when TDLib acknowledges only the topic boundary before the request returns", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(0));
  store.setState({ forumTopics: new Map(store.getState().forumTopics).set("chat-forum",
    store.getState().forumTopics.get("chat-forum")!.map(topic => topic.id === "12"
      ? { ...topic, unreadCount: 1, lastReadInboxMessageId: undefined } : topic)) });
  vi.spyOn(transport, "markForumTopicRead").mockImplementationOnce(async (_chatId, _topicId, messageId) => {
    const forumTopics = new Map(store.getState().forumTopics);
    forumTopics.set("chat-forum", forumTopics.get("chat-forum")!.map(topic => topic.id === "12"
      ? { ...topic, lastReadInboxMessageId: messageId, unreadMentionCount: 2 } : topic));
    store.setState({ forumTopics });
  });
  await store.getState().markActiveChatRead();
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12"))
    .toMatchObject({ unreadCount: 0, unreadMentionCount: 2, lastReadInboxMessageId: "forum-release-1" });
  await transport.disconnect();
});
