import type { Message } from "./types";

export const replyTargetMessage = (message: Message, messagesById: ReadonlyMap<string, Message>) => {
  const reply = message.replyTo;
  if (reply?.kind !== "message" || !reply.messageId) return undefined;
  const target = messagesById.get(reply.messageId);
  // Message IDs are scoped to a chat, including replies carrying embedded content.
  return target?.chatId === (reply.chatId ?? message.chatId) ? target : undefined;
};
