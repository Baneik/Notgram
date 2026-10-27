import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { preferencesStore } from "../store/preferencesStore";
import { createTelegramStore } from "../store/telegramStore";
import { mockSnapshot } from "./mockData";
import { MockTelegramTransport } from "./mockTransport";
import { compareReadCursors, LOCAL_READ_STATE_KEY, LocalReadState, readCursor } from "./localReadState";
import { withLocalReadState } from "./localReadTransport";
import { assertReadReceiptAllowed, ReadReceiptPolicyChanged } from "./readReceiptPolicy";
import type { TelegramEventListener } from "./transport";
import type { Chat, ForumTopic, Message, TelegramEvent, TelegramSnapshot } from "./types";

const sample = mockSnapshot.messages.find(message => !message.outgoing)!;
const message = (id: number, overrides: Partial<Message> = {}): Message => ({ ...sample,
  chatId: "7", id: String(id), sentAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
  outgoing: false, topicId: undefined, containsUnreadMention: false, containsUnreadReaction: false, ...overrides });
const chat = (unreadCount: number, overrides: Partial<Chat> = {}): Chat => ({ ...mockSnapshot.chats[0],
  id: "7", kind: "direct", isForum: false, unreadCount, unreadMentionCount: 0, unreadReactionCount: 0,
  lastReadInboxMessageId: "0", ...overrides });
const topic = (id: string, unreadCount: number): ForumTopic => ({ id, chatId: "7", name: id,
  iconColor: 0, createdAt: "", isGeneral: false, isOutgoing: false, isClosed: false, isHidden: false,
  isPinned: false, unreadCount, unreadMentionCount: 0, unreadReactionCount: 0, lastReadInboxMessageId: "0", order: id, muted: false });

class ReadingTransport extends MockTelegramTransport {
  rows: Message[] = [];
  rawChat = chat(0);
  rawTopics: ForumTopic[] = [];
  feed?: TelegramEventListener;
  override async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.feed = listener;
    listener({ type: "connection.changed", status: "online" });
    return { ...structuredClone(mockSnapshot), chats: [structuredClone(this.rawChat)], messages: [] };
  }
  override async disconnect() { this.feed = undefined; }
  override async getMessage(chatId: string, id: string) { return structuredClone(this.rows.find(row => row.chatId === chatId && row.id === id)); }
  override async getForumTopics() { return { topics: structuredClone(this.rawTopics), hasMore: false }; }
  override async getForumTopic(chatId: string, topicId: string) {
    return structuredClone(this.rawTopics.find(row => row.chatId === chatId && row.id === topicId));
  }
  override async loadChatHistory(chatId: string) {
    const page = await this.loadReadStatePage(chatId);
    return { ...page, loadedCount: page.messages.length, messageIds: page.messages.map(row => row.id) };
  }
  override async loadForumTopicHistory(chatId: string, topicId: string) {
    const page = await this.loadReadStatePage(chatId, topicId);
    return { ...page, loadedCount: page.messages.length, messageIds: page.messages.map(row => row.id) };
  }
  override async loadReadStatePage(chatId: string, topicId?: string, from?: string, filter?: "mention" | "reaction") {
    const rows = this.rows.filter(row => row.chatId === chatId && (!topicId || row.topicId === topicId) &&
      (!filter || (filter === "mention" ? row.containsUnreadMention : row.containsUnreadReaction)))
      .sort((a, b) => compareReadCursors(readCursor(b), readCursor(a)));
    const offset = from ? rows.findIndex(row => row.id === from) + 1 : 0;
    const page = structuredClone(rows.slice(offset, offset + 100));
    return { messages: page, hasMore: offset + page.length < rows.length, nextFromMessageId: page.at(-1)?.id };
  }
  update(patch: Partial<Chat> = {}) {
    this.rawChat = { ...this.rawChat, ...patch };
    this.feed?.({ type: "chat.upsert", chat: structuredClone(this.rawChat) });
  }
}

const instances: Array<ReturnType<typeof withLocalReadState>> = [];
const open = async (raw: ReadingTransport, counts: number[] = []) => {
  const wrapped = withLocalReadState(raw, () => undefined);
  instances.push(wrapped);
  await wrapped.getAccountState();
  const snapshot = await wrapped.connect(event => { if (event.type === "chat.upsert") counts.push(event.chat.unreadCount); });
  counts.push(snapshot.chats[0].unreadCount);
  return wrapped;
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  preferencesStore.setState({ blockReadReceipts: true });
});
afterEach(async () => {
  for (const wrapped of instances.splice(0)) await wrapped.disconnect();
  preferencesStore.setState({ blockReadReceipts: false });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps raw TDLib state untouched and blocks every public read entry, including false-force channel views", async () => {
  const raw = new ReadingTransport();
  raw.rows = [message(1, { containsUnreadMention: true, containsUnreadReaction: true })];
  raw.rawChat = chat(1, { unreadMentionCount: 1, unreadReactionCount: 1 });
  const methods = ["markChatRead", "markForumTopicRead", "markMessageThreadRead", "viewChannelMessages",
    "markMessageAttentionRead", "markAllChatReactionsRead"] as const;
  const spies = methods.map(method => vi.spyOn(raw, method));
  const wrapped = await open(raw);
  await wrapped.markChatRead("7");
  await wrapped.viewChannelMessages("7", ["1"]);
  await wrapped.markMessageThreadRead("7", ["1"]);
  await wrapped.markMessageAttentionRead("7", ["1"]);
  await wrapped.markAllChatReactionsRead("7");
  await wrapped.markForumTopicRead("7", "12", "1");
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(raw.rawChat).toMatchObject({ unreadCount: 1, unreadMentionCount: 1, unreadReactionCount: 1 });
  expect(await wrapped.getMessage("7", "1")).toMatchObject({ containsUnreadMention: false, containsUnreadReaction: false });
});

it("restores a read cursor after cache clearing and counts only offline arrivals across multiple pages", async () => {
  const raw = new ReadingTransport();
  raw.rows = Array.from({ length: 120 }, (_, id) => message(id + 1));
  raw.rawChat = chat(120);
  const wrapped = await open(raw);
  await wrapped.markChatRead("7");
  await wrapped.clearCachedSnapshot();
  await wrapped.disconnect();
  raw.rows.push(...Array.from({ length: 203 }, (_, id) => message(id + 121)));
  raw.rows.push(message(324, { outgoing: true }));
  raw.rawChat = chat(323);
  const counts: number[] = [];
  const restarted = await open(raw, counts);
  expect(counts).toEqual([0]);
  await vi.waitFor(() => expect(counts.at(-1)).toBe(203));
  expect(counts).not.toContain(323);
  raw.update({ unreadCount: 1, lastReadInboxMessageId: "322" });
  await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
  expect(await restarted.getMessage("7", "120")).toBeDefined();
});

it("preserves topic isolation and reconciles the group after a restart with stale server counts", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(5, { kind: "group", isForum: true });
  raw.rawTopics = [topic("12", 3), topic("18", 2)];
  raw.rows = [message(1, { topicId: "12" }), message(2, { topicId: "18" }), message(3, { topicId: "12" }),
    message(4, { topicId: "18" }), message(5, { topicId: "12" })];
  const counts: number[] = [];
  const wrapped = await open(raw, counts);
  await wrapped.getForumTopics({ chatId: "7" });
  await wrapped.markForumTopicRead("7", "12", "5");
  expect(counts.at(-1)).toBe(2);
  await wrapped.disconnect();
  const restarted = await open(raw, counts);
  const page = await restarted.getForumTopics({ chatId: "7" });
  expect(page.topics.map(row => row.unreadCount)).toEqual([0, 2]);
  await vi.waitFor(() => expect(counts.at(-1)).toBe(2));
  raw.rows.push(message(6, { topicId: "12" })); raw.rawTopics[0].unreadCount = 4;
  raw.update({ unreadCount: 6 });
  await vi.waitFor(() => expect(counts.at(-1)).toBe(3));
  const refreshed = await restarted.getForumTopics({ chatId: "7" });
  await vi.waitFor(async () => expect((await restarted.getForumTopics({ chatId: "7" })).topics[0].unreadCount).toBe(1));
  expect(refreshed.topics[1].unreadCount).toBe(2);
});

it("keeps other topics unread when enabling blocking after topics have already loaded", async () => {
  preferencesStore.setState({ blockReadReceipts: false });
  const raw = new ReadingTransport();
  raw.rawChat = chat(3, { kind: "group", isForum: true });
  raw.rawTopics = [topic("12", 1), topic("18", 2)];
  raw.rows = [message(1, { topicId: "12" }), message(2, { topicId: "18" }), message(3, { topicId: "18" })];
  const counts: number[] = [];
  const wrapped = await open(raw, counts);
  await wrapped.getForumTopics({ chatId: "7" });
  preferencesStore.setState({ blockReadReceipts: true });
  await wrapped.markForumTopicRead("7", "12", "1");
  expect(counts.at(-1)).toBe(2);
  expect((await wrapped.getForumTopics({ chatId: "7" })).topics.map(row => row.unreadCount)).toEqual([0, 2]);
});

it("projects stale topic updates before raw topics are loaded after restart", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(1, { kind: "group", isForum: true, unreadMentionCount: 1 });
  raw.rawTopics = [topic("12", 1)];
  raw.rows = [message(5, { topicId: "12", containsUnreadMention: true })];
  const wrapped = await open(raw);
  await wrapped.markForumTopicRead("7", "12", "5");
  await wrapped.markMessageAttentionRead("7", ["5"]);
  await wrapped.disconnect();
  const restarted = withLocalReadState(raw, () => undefined);
  instances.push(restarted);
  const updates: unknown[] = [];
  await restarted.getAccountState();
  await restarted.connect(event => { if (event.type === "forumTopics.changed") updates.push(event.topic); });
  raw.feed?.({ type: "forumTopics.changed", chatId: "7", topic: { id: "12", lastReadInboxMessageId: "0", unreadCount: 1 } });
  expect(updates.at(-1)).toEqual({ id: "12", lastReadInboxMessageId: "5", unreadCount: 0 });
});

it("keeps locally dismissed mentions dismissed in stale history and preserves unseen mentions after restart", async () => {
  const raw = new ReadingTransport();
  raw.rows = [1, 2, 3].map(id => message(id, { containsUnreadMention: true }));
  raw.rawChat = chat(3, { unreadMentionCount: 3 });
  const wrapped = await open(raw);
  await wrapped.markMessageAttentionRead("7", ["1", "1"]);
  expect(await wrapped.getMessage("7", "1")).toMatchObject({ containsUnreadMention: false });
  expect(await wrapped.getMessage("7", "2")).toMatchObject({ containsUnreadMention: true });
  await wrapped.disconnect();
  const restarted = await open(raw);
  await vi.waitFor(async () => {
    const state = new LocalReadState(); state.load("default");
    expect(state.project(raw.rawChat).unreadMentionCount).toBe(2);
  });
  raw.rows[0].containsUnreadMention = false;
  raw.rows.push(message(4, { containsUnreadMention: true }));
  raw.update({ unreadMentionCount: 3 });
  await vi.waitFor(async () => {
    const state = new LocalReadState(); state.load("default");
    expect(state.project(raw.rawChat).unreadMentionCount).toBe(3);
  });
  expect(await restarted.getMessage("7", "1")).toMatchObject({ containsUnreadMention: false });
});

it("recognizes a new reaction on an already locally acknowledged message", async () => {
  const raw = new ReadingTransport();
  raw.rows = [message(1, { containsUnreadReaction: true, unreadReactions: [{ senderId: "a", type: { kind: "emoji", emoji: "👍" } }] })];
  raw.rawChat = chat(0, { unreadReactionCount: 1 });
  const wrapped = await open(raw);
  await wrapped.markAllChatReactionsRead("7");
  expect((await wrapped.getMessage("7", "1"))?.containsUnreadReaction).toBe(false);
  raw.rows[0].unreadReactions = [{ senderId: "b", type: { kind: "emoji", emoji: "🔥" } }];
  raw.feed?.({ type: "message.upsert", message: structuredClone(raw.rows[0]) });
  await vi.waitFor(async () => {
    const state = new LocalReadState(); state.load("default");
    expect(state.project(raw.rawChat).unreadReactionCount).toBe(1);
  });
  expect((await wrapped.getMessage("7", "1"))?.containsUnreadReaction).toBe(true);
});

it("does not upload suppressed receipts when switching the setting off", async () => {
  const raw = new ReadingTransport(); raw.rows = [message(1)]; raw.rawChat = chat(1);
  const send = vi.spyOn(raw, "markChatRead");
  const wrapped = await open(raw);
  await wrapped.markChatRead("7");
  preferencesStore.setState({ blockReadReceipts: false });
  expect(send).not.toHaveBeenCalled();
  await wrapped.markChatRead("7");
  expect(send).toHaveBeenCalledOnce();
});

it("clears every topic locally when reading the whole forum without a topic read leaking out", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(2, { kind: "group", isForum: true });
  raw.rawTopics = [topic("12", 1), topic("18", 1)];
  raw.rows = [message(1, { topicId: "12" }), message(2, { topicId: "18" })];
  raw.rawTopics.forEach((row, index) => { row.lastMessage = raw.rows[index]; });
  const wrapped = await open(raw);
  await wrapped.getForumTopics({ chatId: "7" });
  await wrapped.markChatRead("7");
  expect((await wrapped.getForumTopics({ chatId: "7" })).topics.map(row => row.unreadCount)).toEqual([0, 0]);
});

it("does not apply a delayed old-account read to the new account", async () => {
  const raw = new ReadingTransport(); raw.rawChat = chat(1); raw.rows = [message(1)];
  const wrapped = await open(raw);
  let release!: (page: Awaited<ReturnType<ReadingTransport["loadReadStatePage"]>>) => void;
  vi.spyOn(raw, "loadReadStatePage").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const reading = wrapped.markChatRead("7");
  await wrapped.selectAccount("second");
  release({ messages: [message(1)], hasMore: false, nextFromMessageId: "1" });
  await reading;
  const state = new LocalReadState(); state.load("second");
  expect(state.has("7")).toBe(false);
});

it("retires an asynchronously prepared remote read when blocking becomes enabled", async () => {
  const raw = new ReadingTransport(); raw.rawChat = chat(1); raw.rows = [message(1)];
  preferencesStore.setState({ blockReadReceipts: false });
  let release!: () => void;
  vi.spyOn(raw, "markChatRead").mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    assertReadReceiptAllowed({ "@type": "viewMessages", force_read: true });
  });
  const wrapped = await open(raw);
  const reading = wrapped.markChatRead("7");
  preferencesStore.setState({ blockReadReceipts: true });
  release(); await reading;
  const state = new LocalReadState(); state.load("default");
  expect(state.isRead(message(1))).toBe(true);
  expect(raw.rawChat.unreadCount).toBe(1);
});

it.each(["viewMessages", "openMessageContent", "readAllChatReactions", "readAllForumTopicReactions",
  "readAllChatMentions", "readAllForumTopicMentions"])("guards %s at dispatch even when force_read is false", type => {
  expect(() => assertReadReceiptAllowed({ "@type": type, force_read: false })).toThrow(ReadReceiptPolicyChanged);
  expect(() => assertReadReceiptAllowed({ "@type": "getChatHistory" })).not.toThrow();
  expect(() => assertReadReceiptAllowed({ "@type": "openChat" })).not.toThrow();
});

it("reconciles deletions without treating a new message or a duplicate update as two unreads", async () => {
  const raw = new ReadingTransport(); raw.rows = [message(1)]; raw.rawChat = chat(1);
  const counts: number[] = [];
  const wrapped = await open(raw, counts);
  await wrapped.markChatRead("7");
  raw.rows.push(message(2), message(3)); raw.update({ unreadCount: 3 });
  await vi.waitFor(() => expect(counts.at(-1)).toBe(2));
  raw.rows = raw.rows.filter(row => row.id !== "2"); raw.update({ unreadCount: 2 });
  raw.feed?.({ type: "message.remove", chatId: "7", messageId: "2", permanent: true });
  raw.update(); raw.update();
  await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
});

it("restores normal Store topic counts without double deductions", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(4, { kind: "group", isForum: true });
  raw.rawTopics = [topic("12", 3), topic("18", 1)];
  raw.rows = [message(1, { topicId: "12" }), message(2, { topicId: "12" }),
    message(3, { topicId: "18" }), message(4, { topicId: "12" })];
  const send = vi.spyOn(raw, "markForumTopicRead");
  const store = createTelegramStore(raw);
  await store.getState().initialize();
  store.getState().selectChat("7", { forumTopicId: "12" });
  await vi.waitFor(() => expect(store.getState().forumTopics.get("7")?.find(row => row.id === "12")?.unreadCount).toBe(0));
  await vi.waitFor(() => expect(store.getState().chats.get("7")?.unreadCount).toBe(1));
  expect(store.getState().forumTopics.get("7")?.find(row => row.id === "18")?.unreadCount).toBe(1);
  expect(send).not.toHaveBeenCalled();
});

it("preserves the last complete count if offline reconciliation fails or stalls", async () => {
  const raw = new ReadingTransport(); raw.rows = [message(1)]; raw.rawChat = chat(1);
  const wrapped = await open(raw);
  await wrapped.markChatRead("7");
  const fail = vi.spyOn(raw, "loadReadStatePage").mockRejectedValue(new Error("offline"));
  raw.update({ unreadCount: 20 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const state = new LocalReadState(); state.load("default");
  expect(state.project(raw.rawChat).unreadCount).toBe(0);
  fail.mockRestore();
  raw.rows.push(message(2)); raw.update({ unreadCount: 2 });
  await vi.waitFor(() => { state.load("default"); expect(state.project(raw.rawChat).unreadCount).toBe(1); });
});

it("isolates account cursors and rejects corrupted records without overwriting them", async () => {
  const state = new LocalReadState(); state.load("one"); state.read("7", readCursor(message(5))); state.save();
  state.load("two"); expect(state.isRead(message(5))).toBe(false);
  state.read("7", readCursor(message(3))); state.save();
  state.load("one"); expect(state.isRead(message(5))).toBe(true);
  expect(compareReadCursors({ id: "6917529027641081857", sentAt: "" }, { id: "6917529027641081856", sentAt: "" })).toBe(1);
  localStorage.setItem(LOCAL_READ_STATE_KEY, "{broken");
  expect(() => state.load("one")).toThrow();
  expect(localStorage.getItem(LOCAL_READ_STATE_KEY)).toBe("{broken");
});

it("updates Store mention flags and counts together without awaiting a server read update", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(1, { unreadMentionCount: 1 }); raw.rows = [message(1, { containsUnreadMention: true })];
  const store = createTelegramStore(raw);
  await store.getState().initialize();
  raw.feed?.({ type: "message.upsert", message: raw.rows[0] });
  store.getState().dismissMessageAttention("7", ["1"]);
  await vi.waitFor(() => expect(store.getState().chats.get("7")?.unreadMentionCount).toBe(0));
  expect(store.getState().messages.get("7")?.find(row => row.id === "1")?.containsUnreadMention).toBe(false);
});

it("identifies local topic projections without asking the server to refresh them", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(1, { kind: "group", isForum: true });
  raw.rawTopics = [topic("12", 1)];
  raw.rows = [message(1, { topicId: "12" })];
  const wrapped = withLocalReadState(raw, () => undefined);
  instances.push(wrapped);
  const events: TelegramEvent[] = [];
  await wrapped.getAccountState();
  await wrapped.connect(event => events.push(event));
  await wrapped.getForumTopics({ chatId: "7" });
  await wrapped.markForumTopicRead("7", "12", "1");
  expect(events.filter(event => event.type === "forumTopics.changed").at(-1)).toMatchObject({
    source: "local", topic: { id: "12", unreadCount: 0, lastReadInboxMessageId: "1" },
  });
});

it("does not republish unchanged counts after reply metadata updates", async () => {
  const raw = new ReadingTransport();
  raw.rawChat = chat(1);
  raw.rows = [message(1)];
  const counts: number[] = [];
  const wrapped = await open(raw, counts);
  await wrapped.markChatRead("7");
  await new Promise(resolve => setTimeout(resolve, 100));
  counts.length = 0;
  raw.feed?.({ type: "message.upsert", message: { ...raw.rows[0],
    content: { kind: "text", text: "Updated reply presentation" } } });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(counts).toEqual([]);
});

it("writes durable read state only when its stored value changes", () => {
  const state = new LocalReadState();
  state.load("unchanged-state");
  state.read("7", readCursor(message(1)));
  state.save();
  const writes = vi.spyOn(localStorage, "setItem");
  state.save();
  state.read("7", readCursor(message(1)));
  state.save();
  expect(writes).not.toHaveBeenCalled();
  state.read("7", readCursor(message(2)));
  state.save();
  expect(writes).toHaveBeenCalledOnce();
});
