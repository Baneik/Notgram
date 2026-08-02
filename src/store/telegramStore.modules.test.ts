import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import type { ChatDraft, Message } from "../telegram/types";
import {
  accountStatePatch,
  currentAccountRegistration,
  shouldDiscardUnregisteredAccount,
} from "./telegramStore.accounts";
import { cachedSnapshotFrom } from "./telegramStore.cache";
import { DraftSyncController } from "./telegramStore.drafts";
import {
  reconcileCachedMessageWindow,
  upsertMessage,
  upsertMessages,
  withEmojiReaction,
} from "./telegramStore.messages";
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
  it("merges a history page in one chronological batch", () => {
    const original = [message("10"), message("12")];
    const replacement = { ...message("12"), delivery: "read" as const };
    const result = upsertMessages(original, [replacement, message("11"), message("9")]);

    expect(result.map(({ id }) => id)).toEqual(["9", "10", "11", "12"]);
    expect(result.at(-1)).toBe(replacement);
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

  it("only removes cached messages covered by the confirmed numeric window", () => {
    const result = reconcileCachedMessageWindow(
      [message("8"), message("9"), message("10"), message("11")],
      new Set(["8", "9", "10", "11"]),
      new Set(["9", "11"]),
    );

    expect(result.messages.map(({ id }) => id)).toEqual(["8", "9", "11"]);
    expect([...result.pendingCachedIds]).toEqual(["8"]);
  });
});

describe("telegram store cache and accounts", () => {
  it("strips transient permissions and oversized inline previews from snapshots", () => {
    const media: Message = {
      ...message("20"),
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
    const snapshot = cachedSnapshotFrom({
      currentUserId: mockSnapshot.currentUserId,
      users: new Map(mockSnapshot.users.map((user) => [user.id, user])),
      folders: mockSnapshot.folders,
      chats: new Map([[chat.id, chat]]),
      messages: new Map([[chat.id, [media]]]),
      drafts: new Map(),
      activeChatId: chat.id,
      chatFilter: "main",
    } as TelegramState);

    expect(snapshot.messages[0]).not.toHaveProperty("permissions");
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
