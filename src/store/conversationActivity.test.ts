import { beforeEach, describe, expect, it } from "vitest";
import type { Chat } from "../telegram/types";
import {
  conversationActivityScore,
  conversationActivityStore,
  sortChatsByConversationActivity,
} from "./conversationActivity";

const chat = (id: string, updatedAt: string): Chat => ({
  id,
  title: id,
  kind: "direct",
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

  it("sorts within the active account and falls back to chat recency", () => {
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
      .toEqual(["active", "recent", "other-account"]);
  });
});
