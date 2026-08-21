import { beforeEach, describe, expect, it } from "vitest";
import type { Chat } from "../telegram/types";
import {
  conversationActivityScore,
  conversationActivityStore,
  quickForwardChatsAt,
  sortChatsByConversationActivity,
} from "./conversationActivity";

const chat = (id: string, updatedAt: string, kind: Chat["kind"] = "direct"): Chat => ({
  id,
  title: id,
  kind,
  avatar: { label: id[0] ?? "?", color: "#567" },
  preview: "",
  updatedAt,
  unreadCount: 0,
  unreadMentionCount: 0,
  muted: false,
  pinned: false,
  folderIds: ["main"],
});

describe("conversation activity", () => {
  beforeEach(() => {
    conversationActivityStore.setState({ records: [] });
  });

  it("combines local sends and foreground dwell time", () => {
    conversationActivityStore.getState().recordSentMessages("account-a", "chat-a", 2);
    conversationActivityStore.getState().addActiveDuration("account-a", "chat-a", 30_000);

    const record = conversationActivityStore.getState().records[0];
    expect(record).toMatchObject({
      accountId: "account-a",
      chatId: "chat-a",
      sentMessageCount: 2,
      activeDurationMs: 30_000,
    });
    expect(conversationActivityScore(record)).toBe(150_000);
  });

  it("sorts only by local activity within the active account", () => {
    const chats = [
      chat("recent", "2026-08-22T10:00:00Z"),
      chat("active", "2026-08-20T10:00:00Z"),
      chat("other-account", "2026-08-21T10:00:00Z"),
    ];
    const records = [
      { accountId: "account-a", chatId: "active", sentMessageCount: 1, activeDurationMs: 0, updatedAt: "2026-08-22T10:00:00Z" },
      { accountId: "account-b", chatId: "other-account", sentMessageCount: 99, activeDurationMs: 999_000, updatedAt: "2026-08-22T10:00:00Z" },
    ];

    expect(sortChatsByConversationActivity(chats, "account-a", records).map(({ id }) => id))
      .toEqual(["active", "other-account", "recent"]);
  });

  it("limits quick forwarding to the ten most active groups", () => {
    const chats = Array.from({ length: 11 }, (_, index) =>
      chat(`group-${index}`, `2026-08-01T${String(index).padStart(2, "0")}:00:00Z`, "group"));
    chats.push(chat("private", "2026-08-23T10:00:00Z"));
    const records = chats.map((candidate, index) => ({
      accountId: "account-a",
      chatId: candidate.id,
      sentMessageCount: 11 - index,
      activeDurationMs: 0,
      updatedAt: "2026-08-22T10:00:00Z",
    }));

    expect(quickForwardChatsAt(chats, "account-a", records).map(({ id }) => id))
      .toEqual(Array.from({ length: 10 }, (_, index) => `group-${index}`));
  });
});
