import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { pinnedMessageForVisibleRange } from "./usePinnedMessages";

const pinnedMessage = (id: string, minute: number): Message => ({
  id,
  chatId: "chat-pinned",
  senderId: "user-pinned",
  outgoing: false,
  sentAt: `2026-08-09T10:${String(minute).padStart(2, "0")}:00+08:00`,
  delivery: "read",
  isPinned: true,
  content: { kind: "text", text: `置顶 ${id}` },
});

describe("pinnedMessageForVisibleRange", () => {
  const messages = [
    pinnedMessage("pin-1", 1),
    pinnedMessage("pin-2", 2),
    pinnedMessage("pin-3", 3),
  ];

  it("starts from the latest pin when no pinned source message is visible", () => {
    expect(pinnedMessageForVisibleRange(messages, new Set())?.id).toBe("pin-3");
  });

  it("advances to the pin before the earliest visible pinned source", () => {
    expect(pinnedMessageForVisibleRange(messages, new Set(["pin-3"]))?.id).toBe("pin-2");
    expect(pinnedMessageForVisibleRange(messages, new Set(["pin-2", "pin-3"]))?.id)
      .toBe("pin-1");
  });

  it("keeps the earliest pin displayed when its source is visible", () => {
    expect(pinnedMessageForVisibleRange(messages, new Set(["pin-1"]))?.id).toBe("pin-1");
  });
});
