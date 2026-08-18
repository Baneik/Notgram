export interface MessageNotificationContext {
  outgoing: boolean;
  notificationsEnabled: boolean;
  muted: boolean;
}

export const shouldNotifyMessage = ({
  outgoing,
  notificationsEnabled,
  muted,
}: MessageNotificationContext) =>
  notificationsEnabled &&
  !outgoing &&
  !muted;

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
