import { describe, expect, it } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import { MockTelegramTransport } from "./mockTransport";
import type { TdObject } from "./tdlibMapper";

const raw = (id: number): TdObject => ({
  "@type": "message", id, chat_id: 7, date: 1_700_000_000 + id,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  content: { "@type": "messageText", text: { text: `message ${id}`, entities: [] } },
});

describe("independent history window cursors", () => {
  it.each([false, true].flatMap(forum => [false, true].map(inclusive => ({ forum, inclusive }))))(
    "keeps native older pages at 30 messages (forum: $forum, inclusive: $inclusive)", async ({ forum, inclusive }) => {
      const transport = new TauriTelegramTransport();
      const internal = transport as unknown as { request: (request: TdObject) => Promise<TdObject> };
      internal.request = async request => {
        const cursor = Number(request.from_message_id);
        const from = cursor ? cursor - Number(!inclusive) : 200;
        return { messages: Array.from({ length: Number(request.limit) }, (_, index) => raw(from - index)) };
      };
      const read = (request: import("./types").HistoryPageRequest) => forum
        ? transport.loadForumTopicHistory("7", "1", 30, request)
        : transport.loadChatHistory("7", 30, request);
      const first = await read({ purpose: "refresh" });
      expect(first.nextFromMessageId).toBe("171");
      let cursor = first.nextFromMessageId!;
      const ids = [...first.messageIds];
      for (let turn = 0; turn < 3; turn++) {
        const page = await read({ purpose: "older", fromMessageId: cursor });
        const olderIds = page.messageIds.filter(id => Number(id) < Number(cursor));
        expect(olderIds).toHaveLength(30);
        expect(page.nextFromMessageId).toBe(String(Number(cursor) - 30));
        ids.push(...olderIds);
        cursor = page.nextFromMessageId!;
      }
      expect(ids).toEqual(Array.from({ length: 120 }, (_, index) => String(200 - index)));
    },
  );

  it.each([false, true])("does not let refresh or context pagination consume another cursor (forum: %s)", async forum => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as { request: (request: TdObject) => Promise<TdObject> };
    internal.request = async request => {
      const from = Number(request.from_message_id) || 100;
      const count = Math.min(Number(request.limit), from);
      return { messages: Array.from({ length: count }, (_, index) => raw(from - index)) };
    };
    const read = (request?: import("./types").HistoryPageRequest) => forum
      ? transport.loadForumTopicHistory("7", "1", 3, request)
      : transport.loadChatHistory("7", 3, request);
    expect((await read()).nextFromMessageId).toBe("98");
    expect((await read({ purpose: "older", fromMessageId: "50" })).nextFromMessageId).toBe("47");
    expect((await read({ purpose: "refresh" })).nextFromMessageId).toBe("98");
    expect((await read()).nextFromMessageId).toBe("95");
    transport.resetSyncState();
    expect((await read({ purpose: "older", fromMessageId: "47" })).nextFromMessageId).toBe("44");
    expect((await read({ purpose: "refresh" })).nextFromMessageId).toBe("98");
  });

  it("isolates mock refresh pagination from the reader cursor", async () => {
    const transport = new MockTelegramTransport();
    const first = await transport.loadChatHistory("chat-product", 3);
    const refresh = await transport.loadChatHistory("chat-product", 3, { purpose: "refresh" });
    expect(refresh.messageIds).toEqual(first.messageIds);
    const second = await transport.loadChatHistory("chat-product", 3);
    expect(second.messageIds.some(id => first.messageIds.includes(id))).toBe(false);
    expect((await transport.loadChatHistory("chat-product", 3, {
      purpose: "older", fromMessageId: first.nextFromMessageId,
    })).messageIds).toEqual(second.messageIds);
  });
});
