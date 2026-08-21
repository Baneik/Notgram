import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { formatCompactCount, formatMessageDay, formatMessageTime, localDateKey } from "./formatters";
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

const localIso = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 7, day, hour, minute, second).toISOString();

describe("message grouping", () => {
  it("collects consecutive messages into sender-scoped groups", () => {
    const messages = [
      message("1", "alice", localIso(1, 9, 0)),
      message("2", "alice", localIso(1, 9, 1)),
      message("3", "self", localIso(1, 9, 2), true),
      message("4", "alice", localIso(1, 9, 3)),
    ];

    expect(groupConsecutiveMessages(messages).map((group) => group.map(({ id }) => id)))
      .toEqual([["1", "2"], ["3"], ["4"]]);
  });

  it("marks consecutive messages from one sender as first, middle, and last", () => {
    const messages = [
      message("1", "mia", localIso(1, 9, 18, 1)),
      message("2", "mia", localIso(1, 11, 32, 2)),
      message("3", "mia", localIso(1, 18, 45, 3)),
    ];

    expect(messages.map((_, index) => messageGroupPosition(messages, index)))
      .toEqual(["first", "middle", "last"]);
  });

  it("breaks groups when sender, direction, or local date changes", () => {
    const messages = [
      message("1", "mia", localIso(1, 23, 59, 58)),
      message("2", "mia", localIso(2, 0, 0, 1)),
      message("3", "mia", localIso(2, 0, 0, 2), true),
      message("4", "jules", localIso(2, 0, 0, 3), true),
    ];

    expect(messages.map((_, index) => messageGroupPosition(messages, index)))
      .toEqual(["single", "single", "single", "single"]);
  });

  it("keeps service notices separate from adjacent messages", () => {
    const service: Message = {
      ...message("service", "mia", localIso(1, 9, 1)),
      content: { kind: "service", text: "Mia 加入了群聊" },
    };
    const messages = [
      message("1", "mia", localIso(1, 9, 0)),
      service,
      message("2", "mia", localIso(1, 9, 2)),
    ];

    expect(groupConsecutiveMessages(messages).map((group) => group.map(({ id }) => id)))
      .toEqual([["1"], ["service"], ["2"]]);
    expect(messages.map((_, index) => messageGroupPosition(messages, index)))
      .toEqual(["single", "single", "single"]);
  });

  it("formats bubble timestamps with seconds", () => {
    expect(formatMessageTime("2026-08-01T09:18:07+08:00")).toMatch(/:\d{2}:07$/);
  });

  it("formats channel counters without locale-dependent compact notation", () => {
    expect(formatCompactCount(23)).toBe("23");
    expect(formatCompactCount(22_200)).toBe("22.2K");
    expect(formatCompactCount(1_240_000)).toBe("1.2M");
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
