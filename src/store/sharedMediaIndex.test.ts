import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { SharedMediaIndex } from "./sharedMediaIndex";

const message = (id: string, sentAt: string): Message => ({
  id,
  chatId: "7",
  senderId: "8",
  outgoing: false,
  sentAt,
  delivery: "sent",
  content: { kind: "text", text: id },
});

describe("SharedMediaIndex", () => {
  it("merges pages, reuses fresh entries, and removes deleted messages", () => {
    const index = new SharedMediaIndex(1000);
    index.merge({ chatId: "7", category: "media" }, {
      messages: [message("2", "2026-01-02T00:00:00Z")],
      totalCount: 2,
      nextFromMessageId: "2",
      hasMore: true,
    }, true, 100);
    const merged = index.merge({ chatId: "7", category: "media", fromMessageId: "2" }, {
      messages: [message("1", "2026-01-01T00:00:00Z")],
      totalCount: 2,
      nextFromMessageId: "1",
      hasMore: false,
    }, false, 200);
    expect(merged.messages.map((item) => item.id)).toEqual(["2", "1"]);
    expect(index.read({ chatId: "7", category: "media" }, 300)?.cached).toBe(true);
    index.remove("7", ["2"]);
    expect(index.read({ chatId: "7", category: "media" }, 400)?.messages.map((item) => item.id)).toEqual(["1"]);
    expect(index.read({ chatId: "7", category: "media" }, 1301)).toBeUndefined();
  });
});
