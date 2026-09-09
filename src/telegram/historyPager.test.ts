import { describe, expect, it, vi } from "vitest";
import { loadHistoryWindow } from "./historyPager";
import type { TdObject } from "./tdlibMapper";

const raw = (id: number): TdObject => ({ "@type": "message", chat_id: 7, id });
const load = (request: (query: TdObject) => Promise<TdObject>, cursor = 0) => loadHistoryWindow({
  chatId: "7", targetCount: 3, cursor, request, knownMessages: new Map(), emitMessage: () => {},
});

describe("history continuity", () => {
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
