export interface MessageNotificationContext {
  outgoing: boolean;
  notificationsEnabled: boolean;
  muted: boolean;
  activeChat: boolean;
  appVisible: boolean;
}

export const shouldNotifyMessage = ({
  outgoing,
  notificationsEnabled,
  muted,
  activeChat,
  appVisible,
}: MessageNotificationContext) =>
  notificationsEnabled &&
  !outgoing &&
  !muted &&
  !(activeChat && appVisible);

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
