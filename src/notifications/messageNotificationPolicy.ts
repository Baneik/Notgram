import type { Message } from "../telegram/types";

export const isMessageStreaming = (message: Pick<Message, "isPending" | "content">) =>
  message.isPending === true || (
    message.content.kind === "rich" && !message.content.isFull
  );

const notificationMessageKey = (
  accountId: string,
  message: Pick<Message, "chatId" | "id">,
) => `${accountId}:${message.chatId}:${message.id}`;

export class MessageNotificationStreamTracker {
  private readonly deferred = new Set<string>();

  consume(accountId: string, message: Message, live: boolean) {
    const key = notificationMessageKey(accountId, message);
    if (isMessageStreaming(message)) {
      if (live) this.deferred.add(key);
      return false;
    }
    const wasDeferred = this.deferred.delete(key);
    return live || wasDeferred;
  }

  remove(accountId: string, chatId: string, messageIds: readonly string[]) {
    for (const messageId of messageIds) {
      this.deferred.delete(notificationMessageKey(accountId, { chatId, id: messageId }));
    }
  }

  reset() {
    this.deferred.clear();
  }
}

export interface MessageNotificationContext {
  outgoing: boolean;
  notificationsEnabled: boolean;
  muted: boolean;
  activeConversation: boolean;
  appVisible: boolean;
  messageId?: string;
  sentAt?: string;
  lastReadInboxMessageId?: string;
  notBeforeMs?: number;
  streaming?: boolean;
}

export const isMessageInActiveConversation = ({
  messageChatId,
  messageTopicId,
  activeChatId,
  activeTopicId,
  forum,
}: {
  messageChatId: string;
  messageTopicId?: string;
  activeChatId?: string;
  activeTopicId?: string;
  forum: boolean;
}) => messageChatId === activeChatId && (
  !forum || (Boolean(activeTopicId) && messageTopicId === activeTopicId)
);

export const isMessageConversationMuted = ({
  chatMuted,
  topic,
}: {
  chatMuted: boolean;
  topic?: { muted: boolean; useDefaultMuteFor?: boolean };
}) => {
  if (!topic) return chatMuted;
  if (topic.muted) return true;
  return topic.useDefaultMuteFor === false ? false : chatMuted;
};

const isAtOrBeforeReadCursor = (messageId?: string, lastReadMessageId?: string) => {
  if (!messageId || !lastReadMessageId) return false;
  if (messageId === lastReadMessageId) return true;
  if (!/^\d+$/.test(messageId) || !/^\d+$/.test(lastReadMessageId)) return false;
  return BigInt(messageId) <= BigInt(lastReadMessageId);
};

const predatesNotificationSession = (sentAt?: string, notBeforeMs?: number) => {
  if (!sentAt || notBeforeMs === undefined) return false;
  const sentAtMs = Date.parse(sentAt);
  return Number.isFinite(sentAtMs) && sentAtMs < notBeforeMs;
};

export const shouldNotifyMessage = ({
  outgoing,
  notificationsEnabled,
  muted,
  activeConversation,
  appVisible,
  messageId,
  sentAt,
  lastReadInboxMessageId,
  notBeforeMs,
  streaming,
}: MessageNotificationContext) =>
  notificationsEnabled &&
  !outgoing &&
  !streaming &&
  !muted &&
  !(activeConversation && appVisible) &&
  !isAtOrBeforeReadCursor(messageId, lastReadInboxMessageId) &&
  !predatesNotificationSession(sentAt, notBeforeMs);

export const notificationPresentation = ({
  showPreview,
  chatTitle,
  topicTitle,
  senderName,
  messageText,
}: {
  showPreview: boolean;
  chatTitle?: string;
  topicTitle?: string;
  senderName?: string;
  messageText: string;
}) => {
  if (!showPreview) return { title: "Notgram", body: "收到一条新消息" };
  const titleParts = [chatTitle, topicTitle]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const message = messageText.trim() || "收到一条新消息";
  const sender = senderName?.trim();
  return {
    title: titleParts.join(" · ") || "Notgram",
    body: sender ? `${sender}：${message}` : message,
  };
};
