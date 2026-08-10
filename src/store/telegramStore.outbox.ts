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
): Message => {
  const attachmentCount = item.attachments?.length ?? 0;
  const firstAttachment = item.attachments?.[0];
  const totalBytes = item.attachments?.reduce((sum, attachment) => sum + attachment.size, 0) ?? 0;
  return {
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
          quote: item.replyQuote?.text,
        }
      : undefined,
    content: firstAttachment
      ? {
          kind: "file",
          fileName: attachmentCount > 1
            ? `${firstAttachment.name} 等 ${attachmentCount} 个附件`
            : firstAttachment.name,
          sizeLabel: totalBytes >= 1024 * 1024
            ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.max(1, Math.ceil(totalBytes / 1024))} KB`,
          caption: item.caption,
          mimeType: firstAttachment.mimeType,
          size: totalBytes,
          isUploading: item.status === "queued",
          canDownload: false,
          progress: 0,
        }
      : { kind: "text", text: item.text },
  };
};

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
