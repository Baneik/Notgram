import { expect, it } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEventListener } from "./transport";

const raw = (id: number): TdObject => ({ "@type": "message", id, chat_id: 7,
  sender_id: { "@type": "messageSenderUser", user_id: 11 }, date: 1_700_000_000,
  content: { "@type": "messageText", text: { "@type": "formattedText", text: `message ${id}`, entities: [] } },
});
type Internals = {
  listener?: TelegramEventListener;
  emitMessage: (message: TdObject) => void;
  handleUpdate: (update: TdObject) => void;
  request: (request: TdObject) => Promise<TdObject>;
  resetSessionState: () => void;
};

it("does not resurrect a permanent deletion while committing a staged history window", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internals;
  internal.emitMessage(raw(9));
  internal.request = async () => {
    internal.handleUpdate({ "@type": "updateDeleteMessages", chat_id: 7, message_ids: [9], is_permanent: true, from_cache: false });
    return { messages: [raw(10), raw(9), raw(8)] };
  };
  const page = await transport.loadChatHistory("7", 3);
  expect(page.messages?.map(message => message.id)).toEqual(["10", "8"]);
  // Deletion does not prevent the protocol cursor from crossing this page.
  expect(page.messageIds).toEqual(["10", "9", "8"]);
});

it("does not replay a sent temporary message from history after its final ID arrives", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internals;
  const pending = { ...raw(9), is_outgoing: true, sending_state: { "@type": "messageSendingStatePending" } };
  internal.emitMessage(pending);
  internal.request = async () => {
    internal.handleUpdate({ "@type": "updateMessageSendSucceeded", old_message_id: 9, message: { ...raw(11), is_outgoing: true } });
    return { messages: [raw(10), pending, raw(8)] };
  };
  expect((await transport.loadChatHistory("7", 3)).messages?.map(message => message.id)).toEqual(["10", "8"]);
});

it("applies deletion facts to context reads too and keeps them across a sync reset", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internals;
  internal.emitMessage(raw(9));
  internal.handleUpdate({ "@type": "updateDeleteMessages", chat_id: 7, message_ids: [9], is_permanent: true, from_cache: false });
  transport.resetSyncState();
  internal.request = async () => ({ messages: [raw(10), raw(9), raw(8)] });
  expect((await transport.getMessageContext("7", "10")).map(message => message.id)).toEqual(["10", "8"]);
});

it("keeps a live edit when an older history response arrives afterward", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internals;
  internal.emitMessage(raw(9));
  internal.request = async () => {
    internal.handleUpdate({ "@type": "updateMessageContent", chat_id: 7, message_id: 9,
      new_content: { "@type": "messageText", text: { text: "edited while loading", entities: [] } } });
    internal.handleUpdate({ "@type": "updateMessageEdited", chat_id: 7, message_id: 9, edit_date: 1_700_000_500 });
    return { messages: [raw(10), raw(9), raw(8)] };
  };
  expect((await transport.loadChatHistory("7", 3)).messages?.find(message => message.id === "9"))
    .toMatchObject({ content: { text: "edited while loading" }, editedAt: "2023-11-14T22:21:40.000Z" });
  internal.request = async query => query["@type"] === "getMessage" ? raw(9) : { messages: [raw(9)] };
  expect(await transport.getMessage("7", "9")).toMatchObject({ content: { text: "edited while loading" } });
  expect((await transport.getMessageContext("7", "9"))[0]).toMatchObject({ content: { text: "edited while loading" } });
});

it("isolates permanent deletion facts by chat and clears them for a new account session", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internals;
  internal.handleUpdate({ "@type": "updateDeleteMessages", chat_id: 7, message_ids: [9], is_permanent: true, from_cache: false });
  internal.request = async query => ({ messages: [{ ...raw(9), chat_id: query.chat_id }] });
  expect((await transport.loadChatHistory("8", 1)).messages?.map(message => message.id)).toEqual(["9"]);
  internal.resetSessionState();
  expect((await transport.loadChatHistory("7", 1)).messages?.map(message => message.id)).toEqual(["9"]);
});

it("removes the temporary outgoing copy if its final message is deleted before send confirmation", () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internals;
  const removed: string[] = [];
  internal.listener = event => { if (event.type === "message.remove") removed.push(event.messageId); };
  internal.emitMessage({ ...raw(9), is_outgoing: true, sending_state: { "@type": "messageSendingStatePending" } });
  internal.handleUpdate({ "@type": "updateDeleteMessages", chat_id: 7, message_ids: [11], is_permanent: true, from_cache: false });
  internal.handleUpdate({ "@type": "updateMessageSendSucceeded", old_message_id: 9, message: { ...raw(11), is_outgoing: true } });
  expect(removed).toEqual(["11", "9"]);
});
