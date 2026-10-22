import { afterEach, beforeEach, expect, it, vi } from "vitest";
import policy from "../../src-tauri/src/telegram/security.rs?raw";
import { preferencesStore } from "../store/preferencesStore";
import { withLocalReadState } from "./localReadTransport";
import { TauriTelegramTransport } from "./tauriTransport";
import { TdRequestBroker } from "./tdRequestBroker";
import type { TdObject } from "./tdlibMapper";

// Use the shipped native policy, so a mock transport cannot hide a missing bridge entry.
const entries = policy.match(/const WEBVIEW_TDLIB_REQUESTS[^=]*=\s*&\[([\s\S]*?)\];/)![1];
const allowed = new Set([...entries.matchAll(/"(\w+)"/g)].map(match => match[1]));
const message = (id = 31, topic = false): TdObject => ({
  "@type": "message", id, chat_id: 7, date: 1_700_000_000 + id,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  contains_unread_mention: true,
  ...(topic ? { topic_id: { "@type": "messageTopicForum", forum_topic_id: 12 } } : {}),
  content: { "@type": "messageText", text: { "@type": "formattedText", text: "Hello", entities: [] } },
});
const setup = (respond: (request: TdObject) => TdObject = () => message()) => {
  const base = new TauriTelegramTransport();
  const requests: TdObject[] = [];
  let broker: TdRequestBroker;
  broker = new TdRequestBroker(async (command, args) => {
    expect(command).toBe("telegram_send");
    const request = args!.request as TdObject;
    requests.push(request);
    if (!allowed.has(String(request["@type"]))) throw new Error(`TDLib request type is not allowed: ${request["@type"]}`);
    broker.settle({ ...respond(request), "@extra": request["@extra"] });
  });
  (base as unknown as { requestBroker: TdRequestBroker }).requestBroker = broker;
  return { base, transport: withLocalReadState(base, () => undefined), requests };
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  preferencesStore.setState({ blockReadReceipts: true });
});
afterEach(() => {
  preferencesStore.setState({ blockReadReceipts: false });
  vi.unstubAllGlobals();
});

it("sends text and locally acknowledges a mention through the native request contract", async () => {
  const { transport, requests } = setup(request => request["@type"] === "sendMessage"
    ? { ...message(32), is_outgoing: true, contains_unread_mention: false } : message());
  await transport.sendMessage({ chatId: "7", text: "Test" });
  await transport.markMessageAttentionRead("7", ["31"]);
  expect((await transport.getMessage("7", "31"))?.containsUnreadMention).toBe(false);
  expect(requests.map(request => request["@type"])).toEqual(["sendMessage", "getMessage", "getMessage"]);
});

it("keeps an @ target reachable and dismisses it locally without a remote view", async () => {
  const { transport, requests } = setup(request => request["@type"] === "getChatHistory"
    ? { "@type": "messages", messages: [message()] } : message());
  expect((await transport.getMessageContext("7", "31")).map(row => row.id)).toContain("31");
  await transport.markMessageAttentionRead("7", ["31"]);
  expect((await transport.getMessage("7", "31"))?.containsUnreadMention).toBe(false);
  expect(requests.map(request => request["@type"])).toEqual(["getChatHistory", "getMessage", "getMessage"]);
});

it("allows a topic read to resolve its target through the native contract", async () => {
  const { transport, requests } = setup(request => request["@type"] === "getForumTopic"
    ? { "@type": "forumTopic", info: { chat_id: 7, forum_topic_id: 12, name: "Topic" }, unread_count: 1 }
    : message(31, true));
  await transport.markForumTopicRead("7", "12", "31");
  expect(requests.map(request => request["@type"])).toEqual(["getForumTopic", "getMessage"]);
});

it("acknowledges discussion mentions through the native contract", async () => {
  const { transport, requests } = setup();
  await transport.markMessageThreadRead("7", ["31"]);
  expect((await transport.getMessage("7", "31"))?.containsUnreadMention).toBe(false);
  expect(requests.map(request => request["@type"])).toEqual(["getMessage", "getMessage"]);
});

it("restores an authored user reference when sending a name mention through the native contract", async () => {
  let restored = false;
  const { base, transport, requests } = setup(request => {
    if (request["@type"] === "getUser") return { "@type": "user", id: 11, have_access: restored };
    if (request["@type"] === "getMessage") { restored = true; return message(); }
    return { ...message(32), is_outgoing: true };
  });
  (base as unknown as { rawMessages: Map<string, Map<string, TdObject>> }).rawMessages.set("7", new Map([["31", message()]]));
  await transport.sendMessage({ chatId: "7", text: "Alice", entities: [{ kind: "mentionName", offset: 0, length: 5, userId: "11" }] });
  expect(requests.map(request => request["@type"])).toEqual(["getUser", "getMessage", "getUser", "sendMessage"]);
});
