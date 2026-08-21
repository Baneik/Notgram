import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { localBlockedMessageGroups, replySenderId } from "./localBlockedMessages";

const message = (id: string, senderId: string, overrides: Partial<Message> = {}): Message => ({
  id,
  chatId: "group",
  senderId,
  outgoing: false,
  sentAt: "2026-08-21T10:00:00.000Z",
  delivery: "sent",
  content: { kind: "text", text: id },
  ...overrides,
});

describe("local blocked message groups", () => {
  it("keeps every uninterrupted message from one sender in the same product group", () => {
    const messages = Array.from({ length: 9 }, (_, index) => message(String(index + 1), "blocked"));
    const groups = localBlockedMessageGroups(messages, new Set(["blocked"]));

    expect(new Set([...groups.values()].map(({ id }) => id))).toEqual(new Set(["blocked:1"]));
    expect(groups.get("9")?.messageIds).toHaveLength(9);
  });

  it("starts a new group after any other sender interrupts the sequence", () => {
    const groups = localBlockedMessageGroups([
      message("1", "blocked"),
      message("2", "visible"),
      message("3", "blocked"),
    ], new Set(["blocked"]));

    expect(groups.get("1")?.id).toBe("blocked:1");
    expect(groups.get("3")?.id).toBe("blocked:3");
  });

  it("resolves hydrated and embedded reply senders", () => {
    const target = message("target", "blocked");
    expect(replySenderId(message("reply", "visible", {
      replyTo: { kind: "message", messageId: "target", senderId: "stale" },
    }), new Map([[target.id, target]]))).toBe("blocked");
    expect(replySenderId(message("remote", "visible", {
      replyTo: { kind: "message", messageId: "outside", senderId: "embedded" },
    }), new Map())).toBe("embedded");
  });
});
