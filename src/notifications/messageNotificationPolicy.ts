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
