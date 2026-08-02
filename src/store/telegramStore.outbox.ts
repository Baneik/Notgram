import type { Message, QueuedOutgoingMessage } from "../telegram/types";

const OUTBOX_MESSAGE_PREFIX = "outbox:";

export const outboxMessageId = (itemId: string) => `${OUTBOX_MESSAGE_PREFIX}${itemId}`;

export const isOutboxMessageId = (messageId: string) =>
  messageId.startsWith(OUTBOX_MESSAGE_PREFIX);

export const outboxItemId = (messageId: string) =>
  isOutboxMessageId(messageId) ? messageId.slice(OUTBOX_MESSAGE_PREFIX.length) : undefined;

export const messageFromOutbox = (
  item: QueuedOutgoingMessage,
  currentUserId: string,
): Message => ({
  id: outboxMessageId(item.id),
  chatId: item.chatId,
  senderId: currentUserId,
  outgoing: true,
  sentAt: item.createdAt,
  delivery: item.status === "failed" ? "failed" : "sending",
  canRetry: item.status === "failed",
  replyTo: item.replyToMessageId
    ? {
        kind: "message",
        chatId: item.chatId,
        messageId: item.replyToMessageId,
      }
    : undefined,
  content: { kind: "text", text: item.text },
});

export const messagesWithOutbox = (
  messages: Map<string, Message[]>,
  outbox: QueuedOutgoingMessage[],
  currentUserId: string,
) => {
  const itemIds = new Set(outbox.map((item) => item.id));
  const next = new Map<string, Message[]>();
  for (const [chatId, chatMessages] of messages) {
    next.set(chatId, chatMessages.filter((message) => {
      const itemId = outboxItemId(message.id);
      return itemId === undefined || itemIds.has(itemId);
    }));
  }
  for (const item of outbox) {
    const chatMessages = next.get(item.chatId) ?? [];
    const optimistic = messageFromOutbox(item, currentUserId);
    const index = chatMessages.findIndex((message) => message.id === optimistic.id);
    const updated = [...chatMessages];
    if (index >= 0) updated[index] = optimistic;
    else updated.push(optimistic);
    updated.sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
    next.set(item.chatId, updated);
  }
  return next;
};
