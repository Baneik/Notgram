import { describe, expect, it } from "vitest";
import type { TelegramEventListener } from "./transport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";

type TestableTransport = {
  listener?: TelegramEventListener;
  request: (request: TdObject) => Promise<TdObject>;
};

const rawMessage = (id: number): TdObject => ({
  "@type": "message",
  id,
  chat_id: 7,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  date: 1_700_000_000 + id,
  content: {
    "@type": "messageText",
    text: { "@type": "formattedText", text: `message ${id}`, entities: [] },
  },
});

describe("TauriTelegramTransport history", () => {
  it("keeps loading small TDLib pages until 30 unique messages are available", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const emittedIds: string[] = [];
    const cursors: number[] = [];

    internal.listener = (event) => {
      if (event.type === "message.upsert") emittedIds.push(event.message.id);
    };
    internal.request = async (request) => {
      const cursor = Number(request.from_message_id);
      cursors.push(cursor);
      const newest = cursor === 0 ? 100 : cursor;
      return {
        "@type": "messages",
        total_count: -1,
        messages: [rawMessage(newest), rawMessage(newest - 1)],
      };
    };

    const page = await transport.loadChatHistory("7", 30);

    expect(page).toEqual({ loadedCount: 30, hasMore: true });
    expect(new Set(emittedIds)).toHaveLength(30);
    expect(cursors).toHaveLength(29);
    expect(cursors.slice(0, 3)).toEqual([0, 99, 98]);
  });

  it("marks history complete only when the cursor can no longer move", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    let requestCount = 0;

    internal.listener = () => undefined;
    internal.request = async (request) => {
      requestCount += 1;
      const cursor = Number(request.from_message_id);
      return {
        "@type": "messages",
        total_count: -1,
        messages: cursor === 0
          ? [rawMessage(10), rawMessage(9)]
          : [rawMessage(cursor)],
      };
    };

    const page = await transport.loadChatHistory("7", 30);

    expect(page).toEqual({ loadedCount: 2, hasMore: false });
    expect(requestCount).toBe(2);
  });
});
