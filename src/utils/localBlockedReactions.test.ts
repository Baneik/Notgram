import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import {
  messageHasUnreadLocalBlockedReaction,
  visibleMessageReactions,
} from "./localBlockedReactions";

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "message",
  chatId: "chat",
  senderId: "self",
  outgoing: true,
  sentAt: "2026-08-21T10:00:00.000Z",
  delivery: "read",
  interaction: {
    viewCount: 0,
    forwardCount: 0,
    replyCount: 0,
    reactions: [
      { type: { kind: "emoji", emoji: "👍" }, totalCount: 2, chosen: true, recentSenderIds: ["self", "blocked"] },
      { type: { kind: "emoji", emoji: "🔥" }, totalCount: 1, chosen: false, recentSenderIds: ["visible"] },
    ],
  },
  content: { kind: "text", text: "hello" },
  ...overrides,
});

describe("local blocked reactions", () => {
  it("removes blocked senders from a reaction aggregate", () => {
    expect(visibleMessageReactions(message(), new Set(["blocked"])).map((reaction) => reaction.type))
      .toEqual([
        { kind: "emoji", emoji: "👍" },
        { kind: "emoji", emoji: "🔥" },
      ]);
    expect(visibleMessageReactions(message(), new Set(["blocked"]))[0]).toMatchObject({
      totalCount: 1,
      recentSenderIds: ["self"],
    });
  });

  it("uses unread reaction metadata when the sender is not in recent senders", () => {
    const value = message({
      containsUnreadReaction: true,
      interaction: {
        viewCount: 0,
        forwardCount: 0,
        replyCount: 0,
        reactions: [{ type: { kind: "emoji", emoji: "🔥" }, totalCount: 1, chosen: false, recentSenderIds: ["visible"] }],
      },
      unreadReactions: [{ senderId: "blocked", type: { kind: "emoji", emoji: "🔥" } }],
    });
    expect(visibleMessageReactions(value, new Set(["blocked"]))).toHaveLength(0);
    expect(messageHasUnreadLocalBlockedReaction(value, new Set(["blocked"]))).toBe(true);
  });

  it("does not request a remote read for unrelated unread reactions", () => {
    const value = message({
      containsUnreadReaction: true,
      interaction: {
        viewCount: 0,
        forwardCount: 0,
        replyCount: 0,
        reactions: [{ type: { kind: "emoji", emoji: "🔥" }, totalCount: 1, chosen: false, recentSenderIds: ["visible"] }],
      },
      unreadReactions: [{ senderId: "visible", type: { kind: "emoji", emoji: "🔥" } }],
    });
    expect(messageHasUnreadLocalBlockedReaction(value, new Set(["blocked"]))).toBe(false);
  });
});
