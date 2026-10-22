import { describe, expect, it } from "vitest";
import { mockSnapshot } from "./mockData";
import type { CachedTelegramSnapshot, Message, User } from "./types";
import { prepareSnapshotCache, SNAPSHOT_CACHE_MAX_ITEMS, usersForSnapshot } from "./snapshotCache";
import { cachedSnapshotFrom, migrateCachedSnapshot } from "../store/telegramStore.cache";
import { createTelegramStore } from "../store/telegramStore";
import { MockTelegramTransport } from "./mockTransport";

const user = (id: string): User => ({ id, displayName: id, presence: "offline", avatar: { label: id, color: "blue" } });
const snapshot = (): CachedTelegramSnapshot => ({
  version: 4, savedAt: "2026-10-22T00:00:00Z", currentUserId: "self",
  users: [user("self")], chats: [], folders: [], messages: [],
  locallyDeletedMessages: [], drafts: [], localAttachmentDrafts: [], outbox: [],
});
const message = (id: string, senderId = "author"): Message => ({
  id, chatId: "chat", senderId, outgoing: false, sentAt: "2026-10-22T00:00:00Z",
  delivery: "read", content: { kind: "text", text: id },
});
const archive = (id: string): Message => ({ ...message(id), isLocallyDeleted: true, locallyDeletedAt: "2026-10-22T01:00:00Z" });

describe("snapshot identity and capacity", () => {
  it("retains every persisted identity source while omitting unrelated users", () => {
    const source = snapshot();
    source.chats = [{ ...mockSnapshot.chats[0], peerId: "peer", previewSenderId: "preview" }];
    source.messages = [{ ...message("ordinary"),
      replyTo: { kind: "message", senderId: "reply", origin: { kind: "user", userId: "reply-origin" },
        content: { kind: "text", text: "nested", entities: [{ offset: 0, length: 1, kind: "mentionName", userId: "reply-mention" }] } },
      forwardInfo: { origin: { kind: "user", userId: "forward" }, source: { senderId: "forward-source", outgoing: false } },
      interaction: { viewCount: 1, forwardCount: 0, replyCount: 0,
        reactions: [{ type: { kind: "emoji", emoji: "👍" }, chosen: false, totalCount: 1, recentSenderIds: ["reactor"] }] },
    }, { ...message("service"), content: { kind: "service", text: "members", memberUserIds: ["member"],
      event: { type: "membersAdded", actorId: "actor", recipientId: "recipient", memberIds: ["event-member"] } } }];
    source.locallyDeletedMessages = [{ ...archive("retained"), senderId: "retained-author" }];
    source.drafts = [{ chatId: "chat", text: "draft", updatedAt: source.savedAt,
      entities: [{ offset: 0, length: 1, kind: "mentionName", userId: "draft-mention" }] }];
    source.outbox = [{ id: "queued", chatId: "chat", text: "outbox", createdAt: source.savedAt, status: "queued",
      replyQuote: { text: "quote", position: 0, entities: [{ offset: 0, length: 1, kind: "mentionName", userId: "outbox-mention" }] } }];
    source.forumTopics = [{ chatId: "chat", topics: [{ id: "topic", chatId: "chat", name: "topic", unreadCount: 0,
      unreadMentionCount: 0, unreadReactionCount: 0, isPinned: false, isClosed: false, isHidden: false,
      iconColor: 0, createdAt: source.savedAt, isGeneral: false, isOutgoing: false, order: "1", muted: false,
      lastMessage: message("topic-message", "topic-author") }] }];
    const expected = ["self", "peer", "preview", "author", "reply", "reply-origin", "reply-mention", "forward",
      "forward-source", "reactor", "member", "actor", "recipient", "event-member", "retained-author", "draft-mention", "outbox-mention", "topic-author"];
    const users = [...expected, "unrelated"].map(user);
    expect(usersForSnapshot(source, users).map(value => value.id)).toEqual(expected);
  });

  it("shrinks a long-lived user catalog without dropping archive authors or mutating live state", () => {
    const store = createTelegramStore(new MockTelegramTransport());
    const users = new Map(Array.from({ length: 50_100 }, (_, index) => [String(index), user(String(index))]));
    users.set("self", user("self"));
    store.setState({ currentUserId: "self", users, messages: new Map([["chat", [{ ...archive("old"), senderId: "50100" }]]]) });
    users.set("50100", user("50100"));
    const cached = cachedSnapshotFrom(store.getState());
    expect(cached.users.map(value => value.id)).toEqual(["self", "50100"]);
    expect(cached.locallyDeletedMessages).toHaveLength(1);
    expect(store.getState().users.size).toBe(50_102);
    expect(migrateCachedSnapshot(cached).snapshot?.users.map(value => value.id)).toEqual(["self", "50100"]);
  });

  it("fits a previously failing 50k snapshot by dropping unrelated users before IPC", async () => {
    const source = snapshot();
    source.users.push(...Array.from({ length: 38_400 }, (_, index) => user(`unused-${index}`)), user("author"));
    source.locallyDeletedMessages = Array.from({ length: 12_000 }, (_, index) => archive(String(index)));
    const prepared = await prepareSnapshotCache(source);
    expect(prepared.users.map(value => value.id)).toEqual(["self", "author"]);
    expect(prepared.locallyDeletedMessages).toBe(source.locallyDeletedMessages);
    expect(source.users).toHaveLength(38_402);
  });

  it("yields rebuildable sections to necessary records at the native item boundary", async () => {
    const source = snapshot();
    source.locallyDeletedMessages = Array.from({ length: SNAPSHOT_CACHE_MAX_ITEMS - 2 }, (_, index) => archive(String(index)));
    source.users.push(user("author"));
    source.messages = [message("reloadable")];
    source.historyContexts = [{ chatId: "chat", targetId: "reloadable", messageIds: ["reloadable"] }];
    const prepared = await prepareSnapshotCache(source);
    expect(prepared.messages).toEqual([]);
    expect(prepared.historyContexts).toEqual([]);
    expect(prepared.locallyDeletedMessages).toHaveLength(SNAPSHOT_CACHE_MAX_ITEMS - 2);
    expect(source.messages).toHaveLength(1);
    expect(source.historyContexts).toHaveLength(1);
  });

  it("drops rebuildable previews before history under a UTF-8 byte budget", async () => {
    const source = snapshot();
    source.users.push(user("author"));
    source.messages = [message("你好 😀")];
    source.emojiPickerPreviews = [{ key: "preview", dataUrl: "x".repeat(2_000) }];
    const prepared = await prepareSnapshotCache(source, { items: 100, bytes: 1_000 });
    expect(prepared.emojiPickerPreviews).toEqual([]);
    expect(prepared.messages).toEqual(source.messages);
    expect(source.emojiPickerPreviews).toHaveLength(1);
  });

  it("releases identities belonging only to discarded metadata, preserving retained message authors", async () => {
    const source = snapshot();
    source.users.push(user("author"), user("optional-preview"));
    source.locallyDeletedMessages = [archive("retained")];
    source.forumTopics = [{ chatId: "chat", topics: [{ id: "topic", chatId: "chat", name: "topic", unreadCount: 0,
      unreadMentionCount: 0, unreadReactionCount: 0, isPinned: false, isClosed: false, isHidden: false,
      iconColor: 0, createdAt: source.savedAt, isGeneral: false, isOutgoing: false, order: "1", muted: false,
      lastMessage: message("last", "optional-preview") }] }];
    const prepared = await prepareSnapshotCache(source, { items: 3, bytes: 100_000 });
    expect(prepared.forumTopics).toEqual([]);
    expect(prepared.users.map(value => value.id)).toEqual(["self", "author"]);
    expect(prepared.locallyDeletedMessages).toEqual(source.locallyDeletedMessages);
  });

  it("counts UTF-8 bytes rather than JavaScript string length for protected text", async () => {
    const source = snapshot();
    source.drafts = [{ chatId: "chat", text: "汉😀".repeat(200), updatedAt: source.savedAt }];
    const stringLengthBudget = JSON.stringify(source).length + 64;
    await expect(prepareSnapshotCache(source, { items: 100, bytes: stringLengthBudget }))
      .rejects.toThrow("UI cache byte limit exceeded");
    expect(source.drafts[0].text).toBe("汉😀".repeat(200));
  });

  it.each(["items", "bytes"])("rejects protected %s overflow without silently truncating local data", async kind => {
    const source = snapshot();
    source.locallyDeletedMessages = [archive("retained")];
    source.drafts = [{ chatId: "chat", text: "unsent", updatedAt: source.savedAt }];
    source.outbox = [{ id: "queued", chatId: "chat", text: "unsent", createdAt: source.savedAt, status: "queued" }];
    const before = structuredClone(source);
    await expect(prepareSnapshotCache(source, { items: kind === "items" ? 1 : 100, bytes: kind === "bytes" ? 1 : 100_000 }))
      .rejects.toThrow(`UI cache ${kind === "items" ? "record" : "byte"} limit exceeded`);
    expect(source).toEqual(before);
  });
});
