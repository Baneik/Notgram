import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../telegram/types";
import {
  consumeMessageEntrance,
  markMessageEntrance,
  messageEntranceFor,
  transferMessageEntrance,
} from "./messageEntrance";

const message = (id: string, outgoing = false): Message => ({
  id,
  chatId: "chat",
  senderId: outgoing ? "self" : "sender",
  outgoing,
  sentAt: "2026-08-07T08:40:00+08:00",
  delivery: "sent",
  content: { kind: "text", text: id },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("message entrance registry", () => {
  it("classifies each newly routed message and consumes it once", () => {
    const incoming = message("incoming");
    const outgoing = message("outgoing", true);
    markMessageEntrance(incoming);
    markMessageEntrance(outgoing);

    expect(messageEntranceFor(incoming)).toBe("incoming");
    expect(messageEntranceFor(outgoing)).toBe("outgoing");
    expect(consumeMessageEntrance(incoming)).toBe("incoming");
    expect(consumeMessageEntrance(outgoing)).toBe("outgoing");
    expect(consumeMessageEntrance(incoming)).toBeUndefined();
    expect(messageEntranceFor(incoming)).toBeUndefined();
    expect(messageEntranceFor(outgoing)).toBeUndefined();
  });

  it("does not let an older expiry clear a freshly marked entrance", async () => {
    vi.useFakeTimers();
    const incoming = message("repeated");
    markMessageEntrance(incoming);
    await vi.advanceTimersByTimeAsync(900);
    markMessageEntrance(incoming);
    await vi.advanceTimersByTimeAsync(200);

    expect(messageEntranceFor(incoming)).toBe("incoming");
    consumeMessageEntrance(incoming);
  });

  it("keeps an outgoing entrance when Telegram replaces the temporary id", () => {
    const pending = message("temporary", true);
    const sent = message("server", true);
    markMessageEntrance(pending);

    transferMessageEntrance(pending.chatId, pending.id, sent);

    expect(messageEntranceFor(pending)).toBeUndefined();
    expect(messageEntranceFor(sent)).toBe("outgoing");
    consumeMessageEntrance(sent);
  });
});
