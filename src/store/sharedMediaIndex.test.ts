import { describe, expect, it } from "vitest";
import type { Message, SharedMediaPage } from "../telegram/types";
import { SharedMediaIndex } from "./sharedMediaIndex";
import { setMemoryBackground } from "../media/memoryCacheBudget";

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
  it("enforces aggregate bytes and reclaims idle entries without another read", () => {
    const index = new SharedMediaIndex();
    const large = { ...message("large", "2026-01-01"), content: { kind: "text" as const, text: "x".repeat(700_000) } };
    for (let id = 0; id < 10; id++) index.merge({ chatId: String(id), category: "media" }, { messages: [large], hasMore: false }, true);
    expect(index.memoryCache.read().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(index.read({ chatId: "0", category: "media" })).toBeUndefined();
    expect(index.read({ chatId: "9", category: "media" })?.messages).toHaveLength(1);
    try {
      setMemoryBackground(true); index.memoryCache.trim(-Infinity);
      expect(index.memoryCache.read().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      index.memoryCache.trim(Date.now() + 1);
      expect(index.memoryCache.read()).toEqual({ entries: 0, bytes: 0 });
    } finally { setMemoryBackground(false); }
  });

  it("caps aggregate rows across chats and preserves independently owned results", () => {
    const index = new SharedMediaIndex();
    const rows = Array.from({ length: 3000 }, (_, id) => message(String(id), "2026-01-01"));
    const first = index.merge({ chatId: "1", category: "media" }, { messages: rows, hasMore: true, nextFromMessageId: "cursor" }, true);
    index.merge({ chatId: "2", category: "media" }, { messages: rows, hasMore: false }, true);
    expect(index.memoryCache.read().entries).toBeLessThanOrEqual(5000);
    expect(index.read({ chatId: "1", category: "media" })).toBeUndefined();
    expect(first.messages).toHaveLength(3000);
    expect(first.nextFromMessageId).toBe("cursor");
    index.remove("2", ["1", "2"]);
    expect(index.memoryCache.read().entries).toBe(2998);
    index.clearChat("2"); expect(index.memoryCache.read().bytes).toBe(0);
  });
  it("retains paged results beyond the old 500-row cutoff", () => {
    const index = new SharedMediaIndex();
    let page: SharedMediaPage = { messages: [], hasMore: true };
    for (let offset = 0; offset < 600; offset += 40) {
      const messages = Array.from({ length: 40 }, (_, index) => message(String(600 - offset - index), String(600 - offset - index)));
      page = index.merge({ chatId: "large", category: "media", ...(offset ? { fromMessageId: String(601 - offset) } : {}) }, { messages, hasMore: offset < 560, nextFromMessageId: messages.at(-1)?.id }, offset === 0);
    }
    expect(page.messages).toHaveLength(600);
    expect(page.hasMore).toBe(false);
  });
  it("clears a session and evicts least recently read entries", () => {
    const index = new SharedMediaIndex(1000, 2);
    const page = { messages: [], hasMore: false };
    index.merge({ chatId: "1", category: "media" }, page, true, 1);
    index.merge({ chatId: "2", category: "media" }, page, true, 2);
    index.read({ chatId: "1", category: "media" }, 3);
    index.merge({ chatId: "3", category: "media" }, page, true, 4);
    expect(index.read({ chatId: "2", category: "media" }, 5)).toBeUndefined();
    expect(index.read({ chatId: "1", category: "media" }, 5)).toBeDefined();
    index.clear();
    expect(index.read({ chatId: "1", category: "media" }, 5)).toBeUndefined();
  });
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
