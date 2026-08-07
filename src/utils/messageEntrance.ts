import type { Message } from "../telegram/types";

export type MessageEntrance = "incoming" | "outgoing";

const ENTRANCE_LIFETIME_MS = 1_000;
const pendingEntrances = new Map<string, {
  kind: MessageEntrance;
  token: symbol;
}>();

const messageKey = (message: Pick<Message, "chatId" | "id">) =>
  `${message.chatId}:${message.id}`;

const setMessageEntrance = (
  message: Pick<Message, "chatId" | "id">,
  kind: MessageEntrance,
) => {
  const key = messageKey(message);
  const token = Symbol(key);
  pendingEntrances.set(key, {
    kind,
    token,
  });
  globalThis.setTimeout(() => {
    if (pendingEntrances.get(key)?.token === token) pendingEntrances.delete(key);
  }, ENTRANCE_LIFETIME_MS);
};

export const markMessageEntrance = (message: Message) => {
  setMessageEntrance(message, message.outgoing ? "outgoing" : "incoming");
};

export const transferMessageEntrance = (
  chatId: string,
  oldMessageId: string,
  message: Message,
) => {
  const oldKey = messageKey({ chatId, id: oldMessageId });
  const entrance = pendingEntrances.get(oldKey);
  if (!entrance) return;
  pendingEntrances.delete(oldKey);
  setMessageEntrance(message, entrance.kind);
};

export const messageEntranceFor = (message: Message) => {
  return pendingEntrances.get(messageKey(message))?.kind;
};

export const consumeMessageEntrance = (message: Message) => {
  pendingEntrances.delete(messageKey(message));
};
