import { describe, expect, it, vi } from "vitest";
import { ChatViewSession } from "./chatViewSession";
import type { TdObject } from "./tdlibMapper";

const deferred = () => {
  let resolve!: (value: TdObject) => void;
  const promise = new Promise<TdObject>(ok => { resolve = ok; });
  return { promise, resolve };
};

describe("TDLib chat view sessions", () => {
  it("opens before viewing, deduplicates ids, closes on departure, and refreshes on reentry", async () => {
    const request = vi.fn(async (_request: TdObject) => ({ "@type": "ok" }));
    const session = new ChatViewSession(request);
    session.focus("-7");
    await session.view("-7", [12, 11, 12]);
    session.focus("8");
    await session.view("8", [20]);
    session.focus("-7");
    await session.view("-7", [12]);
    expect(request.mock.calls.map(([value]) => value)).toEqual([
      { "@type": "openChat", chat_id: -7 },
      { "@type": "viewMessages", chat_id: -7, message_ids: [12, 11], source: { "@type": "messageSourceChatHistory" }, force_read: false },
      { "@type": "closeChat", chat_id: -7 }, { "@type": "openChat", chat_id: 8 },
      { "@type": "viewMessages", chat_id: 8, message_ids: [20], source: { "@type": "messageSourceChatHistory" }, force_read: false },
      { "@type": "closeChat", chat_id: 8 }, { "@type": "openChat", chat_id: -7 },
      { "@type": "viewMessages", chat_id: -7, message_ids: [12], source: { "@type": "messageSourceChatHistory" }, force_read: false },
    ]);
  });

  it("serializes navigation during a slow open and skips superseded destinations and views", async () => {
    const gate = deferred();
    const request = vi.fn(async (value: TdObject) => value["@type"] === "openChat" && value.chat_id === 7
      ? gate.promise : { "@type": "ok" });
    const session = new ChatViewSession(request);
    session.focus("7");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const oldView = session.view("7", [1]);
    session.focus("8");
    session.focus("9");
    const currentView = session.view("9", [2]);
    gate.resolve({ "@type": "ok" });
    await Promise.all([oldView, currentView]);
    expect(request.mock.calls.map(([value]) => value["@type"])).toEqual(["openChat", "closeChat", "openChat", "viewMessages"]);
    expect(request.mock.calls[2][0].chat_id).toBe(9);
    expect(request.mock.calls[3][0].chat_id).toBe(9);
  });

  it("isolates a delayed old account open from a new account session", async () => {
    const gate = deferred();
    let first = true;
    const request = vi.fn(async (_value: TdObject) => {
      if (first) { first = false; return gate.promise; }
      return { "@type": "ok" };
    });
    const session = new ChatViewSession(request);
    session.focus("7");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    session.reset();
    session.focus("8");
    await session.view("8", [2]);
    gate.resolve({ "@type": "ok" });
    await session.view("8", [3]);
    expect(request.mock.calls.filter(([value]) => value["@type"] === "closeChat")).toHaveLength(0);
    expect(request.mock.calls.filter(([value]) => value["@type"] === "openChat")).toHaveLength(2);
  });

  it("retries a failed open before reporting a view", async () => {
    const request = vi.fn(async (_value: TdObject) => ({ "@type": "ok" }))
      .mockRejectedValueOnce(new Error("offline"));
    const session = new ChatViewSession(request);
    session.focus("7");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await session.view("7", [3]);
    expect(request.mock.calls.map(([value]) => value["@type"])).toEqual(["openChat", "openChat", "viewMessages"]);
  });
});
