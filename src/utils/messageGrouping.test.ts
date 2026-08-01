import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { formatMessageDay, formatMessageTime, localDateKey } from "./formatters";
import { groupConsecutiveMessages, messageGroupPosition } from "./messageGrouping";

const message = (
  id: string,
  senderId: string,
  sentAt: string,
  outgoing = false,
): Message => ({
  id,
  chatId: "chat",
  senderId,
  outgoing,
  sentAt,
  delivery: "sent",
  content: { kind: "text", text: id },
});

describe("message grouping", () => {
  it("collects consecutive messages into sender-scoped groups", () => {
    const messages = [
      message("1", "alice", "2026-08-01T09:00:00+08:00"),
      message("2", "alice", "2026-08-01T09:01:00+08:00"),
      message("3", "self", "2026-08-01T09:02:00+08:00", true),
      message("4", "alice", "2026-08-01T09:03:00+08:00"),
    ];

    expect(groupConsecutiveMessages(messages).map((group) => group.map(({ id }) => id)))
      .toEqual([["1", "2"], ["3"], ["4"]]);
  });

  it("marks consecutive messages from one sender as first, middle, and last", () => {
    const messages = [
      message("1", "mia", "2026-08-01T09:18:01+08:00"),
      message("2", "mia", "2026-08-01T11:32:02+08:00"),
      message("3", "mia", "2026-08-01T18:45:03+08:00"),
    ];

    expect(messages.map((_, index) => messageGroupPosition(messages, index)))
      .toEqual(["first", "middle", "last"]);
  });

  it("breaks groups when sender, direction, or local date changes", () => {
    const messages = [
      message("1", "mia", "2026-08-01T23:59:58+08:00"),
      message("2", "mia", "2026-08-02T00:00:01+08:00"),
      message("3", "mia", "2026-08-02T00:00:02+08:00", true),
      message("4", "jules", "2026-08-02T00:00:03+08:00", true),
    ];

    expect(messages.map((_, index) => messageGroupPosition(messages, index)))
      .toEqual(["single", "single", "single", "single"]);
  });

  it("formats bubble timestamps with seconds", () => {
    expect(formatMessageTime("2026-08-01T09:18:07+08:00")).toMatch(/:\d{2}:07$/);
  });

  it("formats message day separators against the local calendar", () => {
    const now = new Date(2026, 7, 2, 12, 0, 0);

    expect(formatMessageDay(new Date(2026, 7, 2, 1).toISOString(), now)).toBe("今天");
    expect(formatMessageDay(new Date(2026, 7, 1, 23).toISOString(), now)).toBe("昨天");
    expect(formatMessageDay(new Date(2026, 6, 30, 10).toISOString(), now)).toBe("7月30日");
    expect(formatMessageDay(new Date(2025, 11, 31, 10).toISOString(), now))
      .toBe("2025年12月31日");
    expect(localDateKey(new Date(2026, 7, 2, 23).toISOString()))
      .toBe(localDateKey(new Date(2026, 7, 2, 1).toISOString()));
  });
});
