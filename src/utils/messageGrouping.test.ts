import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { formatMessageTime } from "./formatters";
import { messageGroupPosition } from "./messageGrouping";

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
});
