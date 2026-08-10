import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import type { ChatDraft, Message, QueuedOutgoingMessage } from "../telegram/types";
import { deriveChatManagementCapabilities } from "../telegram/chatManagement";
import {
  accountStatePatch,
  currentAccountRegistration,
  shouldDiscardUnregisteredAccount,
} from "./telegramStore.accounts";
import { cachedSnapshotFrom, migrateCachedSnapshot } from "./telegramStore.cache";
import { DraftSyncController } from "./telegramStore.drafts";
import {
  pendingCachedIdsAfterConfirmation,
  replaceMessage,
  upsertMessage,
  upsertMessages,
  withEmojiReaction,
} from "./telegramStore.messages";
import { messagesWithOutbox, outboxMessageId } from "./telegramStore.outbox";
import type { TelegramState } from "./telegramStore.types";

const message = (id: string, sentAt = `2026-08-02T08:00:${id.padStart(2, "0")}Z`): Message => ({
  id,
  chatId: "chat-product",
  senderId: "self",
  outgoing: true,
  sentAt,
  delivery: "sent",
  content: { kind: "text", text: id },
});

afterEach(() => vi.useRealTimers());

describe("telegram store message state", () => {
  it("renders restored outbox entries idempotently and marks failed entries retryable", () => {
    const item: QueuedOutgoingMessage = {
      id: "queued-1",
      chatId: "chat-product",
      text: "send after reconnect",
      createdAt: "2026-08-02T08:00:00Z",
      status: "queued",
    };
    const restored = messagesWithOutbox(new Map(), [item], "self");
    const repeated = messagesWithOutbox(restored, [item], "self");

    expect(repeated.get(item.chatId)).toMatchObject([{
      id: outboxMessageId(item.id),
      delivery: "sending",
      content: { kind: "text", text: item.text },
    }]);
    expect(messagesWithOutbox(repeated, [{ ...item, status: "failed" }], "self")
      .get(item.chatId)?.[0]).toMatchObject({ delivery: "failed", canRetry: true });
  });

  it("merges a history page in one chronological batch", () => {
    const original = [message("10"), message("12")];
    const replacement = { ...message("12"), delivery: "read" as const };
    const result = upsertMessages(original, [replacement, message("11"), message("9")]);

    expect(result.map(({ id }) => id)).toEqual(["9", "10", "11", "12"]);
    expect(result.at(-1)).toBe(replacement);
  });

  it("orders numeric Telegram messages deterministically within the same second", () => {
    const sentAt = "2026-08-02T08:00:00Z";
    const result = upsertMessages(
      [message("12", sentAt)],
      [message("11", sentAt), message("13", sentAt), message("10", sentAt)],
    );

    expect(result.map(({ id }) => id)).toEqual(["10", "11", "12", "13"]);
  });

  it("atomically replaces a temporary outgoing id while preserving its render identity", () => {
    const temporary = {
      ...message("-100", "2026-08-02T08:00:00Z"),
      delivery: "sending" as const,
    };
    const confirmed = {
      ...message("900", "2026-08-02T08:00:00Z"),
      content: { kind: "text" as const, text: "confirmed" },
    };
    const replaced = replaceMessage([
      message("800", "2026-08-02T07:59:00Z"),
      temporary,
    ], temporary.id, confirmed);

    expect(replaced.map(({ id }) => id)).toEqual(["800", "900"]);
    expect(replaced.filter(({ content }) =>
      content.kind === "text" && content.text === "confirmed",
    )).toHaveLength(1);
    expect(replaced[1]).toMatchObject({ id: "900", renderKey: "-100", delivery: "sent" });
    expect(upsertMessage(replaced, { ...confirmed, delivery: "read" }))
      .toContainEqual(expect.objectContaining({ id: "900", renderKey: "-100", delivery: "read" }));
  });

  it("upserts in chronological order and applies reversible emoji reactions", () => {
    const ordered = upsertMessage([message("2")], message("1"));
    expect(ordered.map(({ id }) => id)).toEqual(["1", "2"]);

    const reacted = withEmojiReaction(ordered[0], "👍", true);
    expect(reacted.interaction?.reactions).toMatchObject([
      { type: { kind: "emoji", emoji: "👍" }, totalCount: 1, chosen: true },
    ]);
    expect(withEmojiReaction(reacted, "👍", false).interaction?.reactions).toEqual([]);
  });

  it("acknowledges confirmed cache entries without inferring deletion from gaps", () => {
    const result = pendingCachedIdsAfterConfirmation(
      new Set(["8", "9", "10", "11"]),
      new Set(["9", "11"]),
    );

    expect([...result]).toEqual(["8", "10"]);
  });
});

describe("telegram store cache and accounts", () => {
  it("migrates version 1 snapshots and safely rejects damaged cache data", () => {
    const managedLegacyChat = {
      ...mockSnapshot.chats[0],
      unreadMentionCount: undefined,
      canCreateTopics: true,
      management: deriveChatManagementCapabilities("supergroup", "owner"),
    };
    const legacy = {
      version: 1,
      savedAt: "2026-08-01T10:00:00Z",
      currentUserId: mockSnapshot.currentUserId,
      users: mockSnapshot.users,
      folders: mockSnapshot.folders,
      chats: [managedLegacyChat, ...mockSnapshot.chats.slice(1)],
      messages: mockSnapshot.messages.slice(0, 2),
    };

    expect(migrateCachedSnapshot(legacy)).toMatchObject({
      health: "migrated",
      snapshot: { version: 3, currentUserId: mockSnapshot.currentUserId },
    });
    expect(migrateCachedSnapshot(legacy).snapshot?.chats[0]).not.toHaveProperty("management");
    expect(migrateCachedSnapshot(legacy).snapshot?.chats[0]).not.toHaveProperty("canCreateTopics");
    expect(migrateCachedSnapshot(legacy).snapshot?.chats[0]?.unreadMentionCount).toBe(0);
    expect(migrateCachedSnapshot({ ...legacy, version: 99 })).toEqual({ health: "invalid" });
    expect(migrateCachedSnapshot({ ...legacy, chats: [{ title: "missing id" }] }))
      .toEqual({ health: "invalid" });
  });

  it("strips transient permissions and oversized inline previews from snapshots", () => {
    const media: Message = {
      ...message("20"),
      renderKey: "temporary-20",
      permissions: {
        canReply: true,
        canEdit: true,
        canDeleteOnlyForSelf: true,
        canDeleteForAllUsers: true,
        canForward: true,
      },
      content: {
        kind: "media",
        mediaType: "photo",
        fileName: "large.jpg",
        sizeLabel: "1 MB",
        previewDataUrl: `data:image/jpeg;base64,${"a".repeat(40_000)}`,
      },
    };
    const chat = mockSnapshot.chats.find(({ id }) => id === media.chatId)!;
    const managedChat = {
      ...chat,
      canCreateTopics: true,
      management: deriveChatManagementCapabilities("supergroup", "owner"),
    };
    const snapshot = cachedSnapshotFrom({
      currentUserId: mockSnapshot.currentUserId,
      users: new Map(mockSnapshot.users.map((user) => [user.id, user])),
      folders: mockSnapshot.folders,
      chats: new Map([[managedChat.id, managedChat]]),
      messages: new Map([[chat.id, [media]]]),
      drafts: new Map(),
      activeChatId: chat.id,
      chatFilter: "main",
    } as TelegramState);

    expect(snapshot.messages[0]).not.toHaveProperty("permissions");
    expect(snapshot.messages[0]).not.toHaveProperty("renderKey");
    expect(
      snapshot.messages[0].content.kind === "media"
        ? snapshot.messages[0].content.previewDataUrl
        : "unexpected content",
    ).toBeUndefined();
  });

  it("derives stable account registration and transition decisions", () => {
    const user = mockSnapshot.users[0];
    const registration = currentAccountRegistration({
      activeAccountId: "default",
      authorization: { kind: "ready" },
      currentUserId: user.id,
      users: new Map([[user.id, user]]),
    });

    expect(registration?.account).toEqual({
      userId: user.id,
      displayName: user.displayName,
      avatar: user.avatar,
    });
    expect(accountStatePatch({ activeAccountId: "two", accounts: [] }))
      .toMatchObject({ activeAccountId: "two", accountPending: false });
    expect(shouldDiscardUnregisteredAccount([], "temporary", "default")).toBe(true);
    expect(shouldDiscardUnregisteredAccount([
      { id: "saved", userId: "1", displayName: "Saved", avatar: user.avatar },
    ], "saved", "default")).toBe(false);
  });
});

describe("draft sync controller", () => {
  it("debounces transport writes and ignores stale server acknowledgements", async () => {
    vi.useFakeTimers();
    let drafts = new Map<string, ChatDraft>();
    const sent: Array<{ chatId: string; draft?: ChatDraft }> = [];
    const controller = new DraftSyncController({
      isReady: () => true,
      getDrafts: () => drafts,
      setDrafts: (next) => { drafts = next; },
      sendDraft: async (chatId, draft) => { sent.push({ chatId, draft }); },
      reportError: vi.fn(),
      scheduleCacheWrite: vi.fn(),
    });
    const local: ChatDraft = {
      chatId: "chat-product",
      text: "local",
      updatedAt: "2026-08-02T08:00:00Z",
      pending: true,
    };
    drafts.set(local.chatId, local);
    controller.expect(local.chatId, local, 450);

    await vi.advanceTimersByTimeAsync(449);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toMatchObject([{ chatId: local.chatId, draft: { text: "local" } }]);

    expect(controller.acceptServerDraft(local.chatId, { ...local, text: "stale" })).toBe(false);
    expect(drafts.get(local.chatId)?.text).toBe("local");
    expect(controller.acceptServerDraft(local.chatId, { ...local, pending: false })).toBe(true);
    expect(drafts.get(local.chatId)?.pending).toBe(false);
    controller.clear();
  });
});
