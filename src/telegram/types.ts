export type ChatKind = "direct" | "group" | "channel" | "saved";
export type DeliveryState = "sending" | "sent" | "read" | "failed";

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
  imagePath?: string;
}

export interface ChatFolder {
  id: string;
  title: string;
  iconName: string;
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
  folderIds: string[];
  title: string;
  avatar: Avatar;
  peerId?: string;
  preview: string;
  updatedAt: string;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
}

interface TransferableMessageContent {
  fileName: string;
  sizeLabel: string;
  caption?: string;
  mimeType?: string;
  fileId?: number;
  size?: number;
  localPath?: string;
  thumbnailPath?: string;
  canDownload?: boolean;
  isDownloading?: boolean;
  isDownloaded?: boolean;
  isUploading?: boolean;
  downloadedSize?: number;
  uploadedSize?: number;
  progress?: number;
  width?: number;
  height?: number;
}

export type MessageContent =
  | { kind: "text"; text: string }
  | ({ kind: "file" } & TransferableMessageContent)
  | ({
      kind: "media";
      mediaType: "photo" | "video" | "audio" | "voice" | "animation" | "sticker";
      previewDataUrl?: string;
    } & TransferableMessageContent);

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  outgoing: boolean;
  sentAt: string;
  delivery: DeliveryState;
  canRetry?: boolean;
  content: MessageContent;
}

export interface TelegramSnapshot {
  currentUserId: string;
  authorization: AuthorizationState;
  users: User[];
  folders: ChatFolder[];
  chats: Chat[];
  messages: Message[];
}

export interface CachedTelegramSnapshot {
  version: 1;
  savedAt: string;
  currentUserId: string;
  users: User[];
  folders: ChatFolder[];
  chats: Chat[];
  messages: Message[];
  activeChatId?: string;
  chatFilter?: string;
}

export type TelegramEvent =
  | { type: "authorization.changed"; state: AuthorizationState }
  | { type: "currentUser.changed"; userId: string }
  | { type: "message.upsert"; message: Message }
  | { type: "message.remove"; chatId: string; messageId: string }
  | { type: "folders.replaced"; folders: ChatFolder[] }
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

export interface ChatHistoryPage {
  loadedCount: number;
  hasMore: boolean;
  messageIds: string[];
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

export interface StorageSettings {
  cachePath: string;
  downloadPath: string;
  defaultCachePath: string;
  defaultDownloadPath: string;
}

export type AuthorizationAction =
  | { kind: "qr" }
  | { kind: "phone"; phoneNumber: string }
  | { kind: "code"; code: string }
  | { kind: "password"; password: string }
  | { kind: "emailAddress"; emailAddress: string }
  | { kind: "emailCode"; code: string }
  | { kind: "registration"; firstName: string; lastName: string };
