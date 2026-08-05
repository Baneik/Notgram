import type { Message } from "../telegram/types";

export type MessageEntrance = "incoming" | "outgoing";

const ENTRANCE_LIFETIME_MS = 1_000;
const pendingEntrances = new Map<string, MessageEntrance>();

const messageKey = (message: Pick<Message, "chatId" | "id">) =>
  `${message.chatId}:${message.id}`;

export const markMessageEntrance = (message: Message) => {
  const key = messageKey(message);
  pendingEntrances.set(key, message.outgoing ? "outgoing" : "incoming");
  globalThis.setTimeout(() => pendingEntrances.delete(key), ENTRANCE_LIFETIME_MS);
};

export const messageEntranceFor = (message: Message) =>
  pendingEntrances.get(messageKey(message));
