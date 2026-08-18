export interface MessageNotificationContext {
  outgoing: boolean;
  notificationsEnabled: boolean;
  muted: boolean;
  messageId?: string;
  sentAt?: string;
  lastReadInboxMessageId?: string;
  notBeforeMs?: number;
}

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
  messageId,
  sentAt,
  lastReadInboxMessageId,
  notBeforeMs,
}: MessageNotificationContext) =>
  notificationsEnabled &&
  !outgoing &&
  !muted &&
  !isAtOrBeforeReadCursor(messageId, lastReadInboxMessageId) &&
  !predatesNotificationSession(sentAt, notBeforeMs);

export const notificationPresentation = ({
  showPreview,
  chatTitle,
  messageText,
}: {
  showPreview: boolean;
  chatTitle?: string;
  messageText: string;
}) => showPreview
  ? {
      title: chatTitle?.trim() || "Notgram",
      body: messageText.trim() || "收到一条新消息",
    }
  : {
      title: "Notgram",
      body: "收到一条新消息",
    };
