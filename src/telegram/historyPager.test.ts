import { describe, expect, it, vi } from "vitest";
import { loadHistoryWindow } from "./historyPager";
import type { TdObject } from "./tdlibMapper";

const raw = (id: number): TdObject => ({ "@type": "message", chat_id: 7, id });
const load = (request: (query: TdObject) => Promise<TdObject>, cursor = 0) => loadHistoryWindow({
  chatId: "7", targetCount: 3, cursor, request, knownMessages: new Map(), emitMessage: () => {},
});

describe("history continuity", () => {
  it.each([undefined, "1"])("walks short newer pages back to their boundary before emitting (topic: %s)", async topicId => {
    const emitted: number[] = [];
    const queries: TdObject[] = [];
    const result = await loadHistoryWindow({
      chatId: "7", topicId, direction: "newer", cursor: 100, targetCount: 30, knownMessages: new Map(),
      request: async query => {
        queries.push(query);
        const from = Number(query.from_message_id) - Number(query.offset);
        return { messages: Array.from({ length: 7 }, (_, index) => raw(from - index)) };
      },
      emitMessage: message => emitted.push(Number(message.id)),
    });
    expect(queries[0]).toMatchObject({ offset: -30, from_message_id: 100 });
    expect(result).toMatchObject({ cursor: 130, loadedCount: 30, stalled: false });
    expect(emitted).toEqual(Array.from({ length: 30 }, (_, index) => index + 101));
  });

  it("never commits a newer page above an unfilled boundary or claims exhaustion after one empty response", async () => {
    const emit = vi.fn();
    const stalled = await loadHistoryWindow({ chatId: "7", direction: "newer", cursor: 100, targetCount: 30,
      knownMessages: new Map(), request: async () => ({ messages: [raw(130)] }), emitMessage: emit });
    expect(stalled).toMatchObject({ cursor: 100, stalled: true, exhausted: false });
    expect(emit).not.toHaveBeenCalled();
    const request = vi.fn().mockResolvedValueOnce({ messages: [] }).mockResolvedValue({ messages: [raw(102), raw(101), raw(100)] });
    const result = await loadHistoryWindow({ chatId: "7", direction: "newer", cursor: 100, targetCount: 30,
      knownMessages: new Map(), request, emitMessage: emit });
    expect(result).toMatchObject({ cursor: 102, messageIds: ["101", "102"], exhausted: false });
  });
  it.each([false, true])("keeps repeated pages at the requested size without skipping overflow (inclusive: %s)", async inclusive => {
    const knownMessages = new Map<string, TdObject>([["1000", raw(1000)]]);
    let cursor = 1000;
    const emitted: number[] = [];
    for (let turn = 0; turn < 5; turn++) {
      const result = await loadHistoryWindow({
        chatId: "7", targetCount: 30, cursor, knownMessages,
        request: async query => {
          const from = Number(query.from_message_id) - Number(!inclusive);
          return { messages: Array.from({ length: Number(query.limit) }, (_, index) => raw(from - index)) };
        },
        emitMessage: message => emitted.push(Number(message.id)),
      });
      expect(result).toMatchObject({ loadedCount: 30, cursor: cursor - 30, exhausted: false, stalled: false });
      expect(result.messageIds.filter(id => Number(id) < cursor)).toHaveLength(30);
      cursor = result.cursor;
    }
    expect([...new Set(emitted)].filter(id => id < 1000).sort((left, right) => right - left))
      .toEqual(Array.from({ length: 150 }, (_, index) => 999 - index));
  });

  it("bounds a window assembled from short strict-older responses", async () => {
    const emitted: number[] = [];
    const result = await loadHistoryWindow({
      chatId: "7", targetCount: 30, cursor: 100, knownMessages: new Map(),
      request: async query => ({ messages: Array.from({ length: Math.min(7, Number(query.limit)) },
        (_, index) => raw(Number(query.from_message_id) - 1 - index)) }),
      emitMessage: message => emitted.push(Number(message.id)),
    });
    expect(result).toMatchObject({ loadedCount: 30, cursor: 70, stalled: false });
    expect(emitted).toEqual(Array.from({ length: 30 }, (_, index) => 99 - index));
  });

  it("rechecks an empty page caused by a concurrent deletion before declaring the end", async () => {
    const request = vi.fn().mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({ messages: [raw(8), raw(7), raw(6)] });
    expect(await load(request, 9)).toMatchObject({ exhausted: false, messageIds: ["8", "7", "6"], cursor: 6 });
  });

  it("confirms a real empty boundary with a second read", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    expect(await load(request, 9)).toMatchObject({ exhausted: true, cursor: 9 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not move the older cursor forward when TDLib repeats a newer window", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [raw(12), raw(11), raw(10)] });
    expect(await load(request, 9)).toMatchObject({ exhausted: false, cursor: 9, stalled: true });
    expect(request.mock.calls.every(([query]) => query.from_message_id === 9)).toBe(true);
  });

  it("reports a boundary-only stall for background retry", async () => {
    expect(await load(async () => ({ messages: [raw(9)] }), 9))
      .toMatchObject({ exhausted: false, cursor: 9, stalled: true });
  });
});
