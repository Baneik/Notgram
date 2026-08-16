import type { Message } from "../telegram/types";
import { motionLifecycleTiming } from "./motionTokens";

export type MessageEntrance = "incoming" | "outgoing";

export const MESSAGE_ENTRANCE_LIFETIME_MS = motionLifecycleTiming.messageEntranceClaim;
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
  }, MESSAGE_ENTRANCE_LIFETIME_MS);
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
  const key = messageKey(message);
  const entrance = pendingEntrances.get(key)?.kind;
  pendingEntrances.delete(key);
  return entrance;
};
