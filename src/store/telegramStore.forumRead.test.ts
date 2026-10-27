import { expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import { FORUM_ALL_TOPIC_ID, type Message, type TelegramEvent } from "../telegram/types";

const emit = (transport: MockTelegramTransport, event: TelegramEvent) => {
  (transport as unknown as { listener: (event: TelegramEvent) => void }).listener(event);
};

it("applies local topic counts without scheduling a remote topic refresh", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  const getTopics = vi.spyOn(transport, "getForumTopics");
  await store.getState().initialize();
  await store.getState().loadForumTopics("chat-forum");
  getTopics.mockClear();
  try {
    emit(transport, { type: "forumTopics.changed", chatId: "chat-forum", source: "local",
      topic: { id: "12", unreadCount: 0, lastReadInboxMessageId: "local-boundary" } });
    expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12"))
      .toMatchObject({ unreadCount: 0, lastReadInboxMessageId: "local-boundary" });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(getTopics).not.toHaveBeenCalled();
    emit(transport, { type: "forumTopics.changed", chatId: "chat-forum" });
    await vi.waitFor(() => expect(getTopics).toHaveBeenCalled());
  } finally { await transport.disconnect(); }
});

it("repairs a restarted forum badge despite metadata updates during the complete topic fetch", async () => {
  const transport = new MockTelegramTransport();
  const getTopics = transport.getForumTopics.bind(transport);
  vi.spyOn(transport, "getForumTopics").mockImplementation(async input => {
    const page = await getTopics(input);
    emit(transport, { type: "chat.upsert", chat: {
      ...store.getState().chats.get("chat-forum")!, title: "Updated forum metadata",
    } });
    return { ...page, topics: page.topics.map(topic => ({ ...topic, unreadCount: 0 })) };
  });
  const topicReads = vi.spyOn(transport, "markForumTopicRead");
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "1" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.every(topic => topic.unreadCount === 0)).toBe(true));
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0));
  expect(store.getState().chats.get("chat-forum")?.title).toBe("Updated forum metadata");
  expect(topicReads).not.toHaveBeenCalled();
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  await transport.disconnect();
});

it("repairs a group count arriving after the topic read without reopening All", async () => {
  const transport = new MockTelegramTransport();
  const server = transport as unknown as {
    snapshot: { chats: Array<{ id: string; unreadCount: number }>; messages: Message[] };
    ensureForumTopics: (chatId: string) => Array<{ id: string; unreadCount: number; lastReadInboxMessageId?: string }>;
  };
  server.snapshot.chats.find(chat => chat.id === "chat-forum")!.unreadCount = 3;
  server.ensureForumTopics("chat-forum").find(topic => topic.id === "18")!.unreadCount = 0;
  vi.spyOn(transport, "markForumTopicRead").mockImplementation(async (chatId, topicId, messageId) => {
    const topic = server.ensureForumTopics(chatId).find(topic => topic.id === topicId)!;
    topic.unreadCount = 0;
    topic.lastReadInboxMessageId = messageId;
    emit(transport, { type: "forumTopics.changed", chatId, topic: {
      id: topicId, lastReadInboxMessageId: messageId, muted: false,
      unreadMentionCount: 0, unreadReactionCount: 0,
    } });
  });
  const store = createTelegramStore(transport);
  const chatReads = vi.spyOn(transport, "markChatRead");
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0));
  const source = store.getState().messages.get("chat-forum")!.find(message => message.topicId === "12")!;
  emit(transport, { type: "message.upsert", message: {
    ...source, id: "read-before-group-count", sentAt: "2026-08-01T10:00:00+08:00",
  }, animateEntrance: true });
  await store.getState().markActiveChatRead();
  emit(transport, { type: "chat.upsert", chat: { ...store.getState().chats.get("chat-forum")!, unreadCount: 4 } });
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0), { timeout: 2_000 });
  expect(store.getState().activeTopicId).toBe("12");
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "18")?.unreadCount).toBe(0);
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  await transport.disconnect();
});

it("rejects complete topic totals captured before an incoming message even when the group count has not changed", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const getTopics = transport.getForumTopics.bind(transport);
  let release!: () => void;
  vi.spyOn(transport, "getForumTopics").mockImplementationOnce(async input => {
    const page = await getTopics(input);
    await new Promise<void>(resolve => { release = resolve; });
    return { ...page, topics: page.topics.map(topic => ({ ...topic, unreadCount: 0 })) };
  });
  const loading = store.getState().loadForumTopics("chat-forum");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const source = store.getState().messages.get("chat-forum")?.find(message => message.topicId === "12") ??
    (transport as unknown as { snapshot: { messages: Message[] } }).snapshot.messages.find(message => message.topicId === "12")!;
  emit(transport, { type: "message.upsert", message: {
    ...source, id: "incoming-during-topic-fetch", sentAt: "2026-08-01T10:00:00+08:00",
  }, animateEntrance: true });
  release();
  await loading;
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(4);
  await transport.disconnect();
});

it("cancels a queued forum unread refresh when the account changes", async () => {
  const transport = new MockTelegramTransport();
  const getTopics = vi.spyOn(transport, "getForumTopics");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "1" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.length).toBe(3));
  emit(transport, { type: "forumTopics.changed", chatId: "chat-forum" });
  await store.getState().switchAccount("account-secondary");
  getTopics.mockClear();
  await new Promise(resolve => globalThis.setTimeout(resolve, 650));
  expect(getTopics).not.toHaveBeenCalled();
  await transport.disconnect();
});

it.each(["boundary", "refreshed-count"])("deducts an acknowledged read while preserving a newer incoming message (%s)", async update => {
  const transport = new MockTelegramTransport();
  let finish!: () => void;
  vi.spyOn(transport, "markForumTopicRead")
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const previous = store.getState().messages.get("chat-forum")!.find(message => message.topicId === "12")!;
  const newer = { ...previous, id: "pending-read-incoming", sentAt: "2026-08-01T10:00:00+08:00" };
  emit(transport, { type: "chat.upsert", chat: { ...store.getState().chats.get("chat-forum")!, unreadCount: 5 } });
  // Mirror TDLib's boundary update and a possible server count refresh, without
  // its independent group count ever reporting the topic read.
  emit(transport, { type: "forumTopics.changed", chatId: "chat-forum", topic: {
    id: "12", lastReadInboxMessageId: previous.id, muted: false, unreadMentionCount: 0, unreadReactionCount: 0,
    ...(update === "refreshed-count" ? { unreadCount: 1 } : {}),
  } });
  // Avoid the automatic read timer so the first acknowledgement is observable.
  store.setState({ messages: new Map(store.getState().messages).set("chat-forum", [
    ...store.getState().messages.get("chat-forum")!, newer,
  ]) });
  finish();
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(2));
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount)
    .toBe(update === "refreshed-count" ? 1 : 3);
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "18")?.unreadCount).toBe(1);
  await store.getState().markActiveChatRead();
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(0);
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  await transport.disconnect();
});

it("deducts a successful topic read even when an unrelated topic update changes its metadata", async () => {
  const transport = new MockTelegramTransport();
  let finish!: () => void;
  vi.spyOn(transport, "markForumTopicRead").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  emit(transport, { type: "forumTopics.changed", chatId: "chat-forum", topic: {
    id: "12", muted: true, unreadMentionCount: 0, unreadReactionCount: 0,
  } });
  finish();
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1));
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.muted).toBe(true);
  await transport.disconnect();
});

it("does not apply a retired topic acknowledgement to another account", async () => {
  const transport = new MockTelegramTransport();
  let finish!: () => void;
  vi.spyOn(transport, "markForumTopicRead").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const accountChat = { ...store.getState().chats.get("chat-forum")!, unreadCount: 7 };
  const reading = store.getState().markActiveChatRead();
  await store.getState().switchAccount("account-secondary");
  store.setState({ chats: new Map([[accountChat.id, accountChat]]) });
  finish();
  await reading;
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(7);
  expect(store.getState().activeAccountId).toBe("account-secondary");
  await transport.disconnect();
});

it("updates the sidebar from topic acknowledgements when TDLib leaves the group count unchanged", async () => {
  const transport = new MockTelegramTransport();
  vi.spyOn(transport, "markForumTopicRead").mockResolvedValue(undefined);
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(0));
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "18")?.unreadCount).toBe(1);

  const message: Message = { ...store.getState().messages.get("chat-forum")!.find(item => item.topicId === "12")!,
    id: "design-incoming", topicId: "18", sentAt: "2026-08-01T09:50:00+08:00" };
  store.setState({ messages: new Map(store.getState().messages).set("chat-forum", [
    ...store.getState().messages.get("chat-forum")!, message,
  ]) });
  (transport as unknown as { snapshot: { messages: Message[] } }).snapshot.messages.push(message);
  store.getState().selectForumTopic("18");
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0));
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  await transport.disconnect();
});

it("repairs a stale group badge when the complete forum list already reports every topic as read", async () => {
  const transport = new MockTelegramTransport();
  const getTopics = transport.getForumTopics.bind(transport);
  vi.spyOn(transport, "getForumTopics").mockImplementation(async input => {
    const page = await getTopics(input);
    return { ...page, topics: page.topics.map(topic => ({ ...topic, unreadCount: 0 })) };
  });
  const topicReads = vi.spyOn(transport, "markForumTopicRead");
  const chatReads = vi.spyOn(transport, "markChatRead");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(0));
  expect(topicReads).not.toHaveBeenCalled();
  expect(chatReads).not.toHaveBeenCalledWith("chat-forum");
  await transport.disconnect();
});

it.each(["filtered", "partial"])("keeps group unread counts when a %s topic list cannot cover the group", async mode => {
  const transport = new MockTelegramTransport();
  const getTopics = transport.getForumTopics.bind(transport);
  vi.spyOn(transport, "getForumTopics").mockImplementation(async input => {
    const page = await getTopics(input);
    return { ...page, topics: page.topics.filter(topic => topic.id === "1"), hasMore: mode === "partial" };
  });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  await store.getState().loadForumTopics("chat-forum", mode === "filtered" ? "常规" : undefined);
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(4);
  await transport.disconnect();
});

it("does not apply old topic totals after a new group count arrives during the list request", async () => {
  const transport = new MockTelegramTransport();
  let release!: () => void;
  const getTopics = transport.getForumTopics.bind(transport);
  vi.spyOn(transport, "getForumTopics").mockImplementationOnce(async input => {
    const page = await getTopics(input);
    await new Promise<void>(resolve => { release = resolve; });
    return { ...page, topics: page.topics.map(topic => ({ ...topic, unreadCount: 0 })) };
  });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const loading = store.getState().loadForumTopics("chat-forum");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  store.setState({ chats: new Map(store.getState().chats).set("chat-forum", {
    ...store.getState().chats.get("chat-forum")!, unreadCount: 5,
  }) });
  release();
  await loading;
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(5);
  await transport.disconnect();
});

it("keeps another topic unread after new arrivals, stale topic lists and repeated group snapshots", async () => {
  const transport = new MockTelegramTransport();
  vi.spyOn(transport, "markForumTopicRead").mockResolvedValue(undefined);
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1));
  const rawChat = { ...store.getState().chats.get("chat-forum")!, unreadCount: 4 };
  emit(transport, { type: "chat.upsert", chat: rawChat });
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  await store.getState().loadForumTopics("chat-forum");
  const newer = { ...store.getState().messages.get("chat-forum")!.find(message => message.topicId === "12")!,
    id: "new-topic-message", sentAt: "2026-08-01T10:00:00+08:00" };
  emit(transport, { type: "chat.upsert", chat: { ...rawChat, unreadCount: 5 } });
  emit(transport, { type: "message.upsert", message: newer, animateEntrance: true });
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(2);
  await store.getState().markActiveChatRead();
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "18")?.unreadCount).toBe(1);
  emit(transport, { type: "chat.upsert", chat: { ...rawChat, unreadCount: 1 } });
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  await transport.disconnect();
});

it("keeps both badges on a failed topic read and removes only that topic after retry", async () => {
  const transport = new MockTelegramTransport();
  vi.spyOn(transport, "markForumTopicRead").mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(undefined);
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat("chat-forum", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().operationError).toBe("read failed"));
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(4);
  expect(store.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount).toBe(3);
  await store.getState().markActiveChatRead();
  expect(store.getState().chats.get("chat-forum")?.unreadCount).toBe(1);
  await transport.disconnect();
});

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
