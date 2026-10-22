import { expect, it } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEventListener } from "./transport";

const rawMessage = (id: number, topic = false): TdObject => ({ "@type": "message", id, chat_id: 7,
  sender_id: { "@type": "messageSenderUser", user_id: 11 }, date: 1_700_000_000 + id,
  ...(topic ? { topic_id: { "@type": "messageTopicForum", forum_topic_id: 12 } } : {}),
  content: { "@type": "messageText", text: { "@type": "formattedText", text: "History", entities: [] } } });
type Internal = {
  request: (request: TdObject) => Promise<TdObject>;
  listener?: TelegramEventListener;
  rawMessages: Map<string, Map<string, TdObject>>;
  historyCursors: Map<string, number>;
};

it.each([undefined, "12"])("reads a private count page without emitting messages or moving history cursors (topic %s)", async topicId => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  const requests: TdObject[] = [];
  const events: unknown[] = [];
  internal.listener = event => events.push(event);
  internal.historyCursors.set("7", 999);
  internal.request = async request => {
    requests.push(request);
    return { "@type": "messages", messages: request.from_message_id === 0
      ? [rawMessage(3, Boolean(topicId)), rawMessage(2, Boolean(topicId))] : [] };
  };
  const page = await transport.loadReadStatePage("7", topicId);
  expect(page.messages.map(message => message.id)).toEqual(["3", "2"]);
  expect(page.hasMore).toBe(false);
  expect(events).toEqual([]);
  expect(internal.historyCursors.get("7")).toBe(999);
  expect(internal.rawMessages.size).toBe(0);
  expect(new Set(requests.map(request => request["@type"])))
    .toEqual(new Set([topicId ? "getForumTopicHistory" : "getChatHistory"]));
});
