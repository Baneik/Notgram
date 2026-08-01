export type ChatFolder = "main" | "archive";
export type ChatKind = "direct" | "group" | "channel" | "saved";
export type DeliveryState = "sending" | "sent" | "read";

export type AuthorizationState =
  | { kind: "preparing" }
  | { kind: "waitPhoneNumber" }
  | { kind: "waitCode"; phoneNumber?: string; codeLength?: number }
  | { kind: "waitPassword"; hint?: string }
  | { kind: "waitEmailAddress" }
  | { kind: "waitEmailCode"; emailPattern?: string; codeLength?: number }
  | { kind: "waitRegistration" }
  | { kind: "waitOtherDeviceConfirmation"; link: string }
  | { kind: "ready" }
  | { kind: "loggingOut" }
  | { kind: "closing" }
  | { kind: "closed" };

export interface Avatar {
  label: string;
  color: string;
}

export interface User {
  id: string;
  displayName: string;
  avatar: Avatar;
  presence: "online" | "offline" | "typing";
  lastSeenLabel?: string;
}

export interface Chat {
  id: string;
  kind: ChatKind;
  folder: ChatFolder;
  title: string;
  avatar: Avatar;
  peerId?: string;
  preview: string;
  updatedAt: string;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
}

export type MessageContent =
  | { kind: "text"; text: string }
  | { kind: "file"; fileName: string; sizeLabel: string };

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  outgoing: boolean;
  sentAt: string;
  delivery: DeliveryState;
  content: MessageContent;
}

export interface TelegramSnapshot {
  currentUserId: string;
  authorization: AuthorizationState;
  users: User[];
  chats: Chat[];
  messages: Message[];
}

export type TelegramEvent =
  | { type: "authorization.changed"; state: AuthorizationState }
  | { type: "currentUser.changed"; userId: string }
  | { type: "message.upsert"; message: Message }
  | { type: "message.remove"; chatId: string; messageId: string }
  | { type: "chat.upsert"; chat: Chat }
  | { type: "user.upsert"; user: User }
  | { type: "sync.error"; message: string };

export interface SendMessageInput {
  chatId: string;
  text: string;
}

export interface SendFileInput {
  chatId: string;
  file: File;
}

export type ProxyMode = "system" | "direct" | "custom";
export type ProxyType = "http" | "socks5" | "mtproto";

export interface ProxyEndpoint {
  type: ProxyType;
  server: string;
  port: number;
  username: string;
  password: string;
  secret: string;
  httpOnly: boolean;
}

export interface ProxySettings {
  mode: ProxyMode;
  custom: ProxyEndpoint;
  system?: ProxyEndpoint;
}

export type AuthorizationAction =
  | { kind: "qr" }
  | { kind: "phone"; phoneNumber: string }
  | { kind: "code"; code: string }
  | { kind: "password"; password: string }
  | { kind: "emailAddress"; emailAddress: string }
  | { kind: "emailCode"; code: string }
  | { kind: "registration"; firstName: string; lastName: string };
