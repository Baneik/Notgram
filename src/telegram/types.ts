export type ChatKind = "direct" | "group" | "channel" | "saved";
export type DeliveryState = "sending" | "sent" | "read" | "failed";
export type ConnectionStatus =
  | "connecting"
  | "syncing"
  | "online"
  | "waitingForNetwork"
  | "proxyError"
  | "offline";

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
  fileId?: number;
  canDownload?: boolean;
  isDownloading?: boolean;
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

export interface TelegramAccount {
  id: string;
  userId: string;
  displayName: string;
  avatar: Avatar;
}

export interface TelegramAccountState {
  activeAccountId: string;
  accounts: TelegramAccount[];
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
  pinnedFolderIds?: string[];
  listOrderByFolder?: Record<string, string>;
  muted: boolean;
}

export interface ChatDraft {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  updatedAt: string;
  pending?: boolean;
}

export type MessageTextEntityKind =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "code"
  | "pre"
  | "blockquote"
  | "url"
  | "textUrl"
  | "email"
  | "phone";

export interface MessageTextEntity {
  offset: number;
  length: number;
  kind: MessageTextEntityKind;
  href?: string;
  language?: string;
}

export interface MessageRichTextRun {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  spoiler?: true;
  code?: true;
  subscript?: true;
  superscript?: true;
  marked?: true;
  href?: string;
}

export interface MessageRichListItem {
  blocks: MessageRichBlock[];
  label?: string;
  hasCheckbox: boolean;
  checked: boolean;
  value?: number;
}

export interface MessageRichTableCell {
  text: MessageRichTextRun[];
  header: boolean;
  colspan: number;
  rowspan: number;
}

export type MessageRichBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: MessageRichTextRun[] }
  | { kind: "paragraph"; text: MessageRichTextRun[] }
  | { kind: "preformatted"; text: MessageRichTextRun[]; language?: string }
  | { kind: "list"; ordered: boolean; items: MessageRichListItem[] }
  | { kind: "quote"; blocks: MessageRichBlock[]; credit?: MessageRichTextRun[] }
  | { kind: "details"; summary: MessageRichTextRun[]; blocks: MessageRichBlock[]; open: boolean }
  | { kind: "table"; caption?: MessageRichTextRun[]; rows: MessageRichTableCell[][] }
  | { kind: "divider" };

interface TransferableMessageContent {
  fileName: string;
  sizeLabel: string;
  caption?: string;
  captionEntities?: MessageTextEntity[];
  mimeType?: string;
  fileId?: number;
  size?: number;
  localPath?: string;
  thumbnailPath?: string;
  thumbnailFileId?: number;
  thumbnailCanDownload?: boolean;
  thumbnailIsDownloading?: boolean;
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
  | { kind: "text"; text: string; entities?: MessageTextEntity[] }
  | {
      kind: "rich";
      blocks: MessageRichBlock[];
      text: string;
      isRtl: boolean;
      isFull: boolean;
    }
  | { kind: "service"; text: string }
  | { kind: "unsupported"; type: string; text: string; raw: string }
  | ({ kind: "file" } & TransferableMessageContent)
  | ({
      kind: "media";
      mediaType: "photo" | "video" | "videoNote" | "audio" | "voice" | "animation" | "sticker";
      previewDataUrl?: string;
    } & TransferableMessageContent);

export type MessageOrigin =
  | { kind: "user"; userId: string }
  | { kind: "hiddenUser"; senderName: string }
  | { kind: "chat"; chatId: string; authorSignature?: string }
  | { kind: "channel"; chatId: string; messageId?: string; authorSignature?: string };

export type MessageReplyTarget =
  | {
      kind: "message";
      chatId?: string;
      messageId?: string;
      quote?: string;
      origin?: MessageOrigin;
      sentAt?: string;
      content?: MessageContent;
    }
  | { kind: "story"; chatId: string; storyId: number };

export interface MessageForwardSource {
  chatId?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  sentAt?: string;
  outgoing: boolean;
}

export interface MessageForwardInfo {
  origin?: MessageOrigin;
  sentAt?: string;
  source?: MessageForwardSource;
  publicServiceAnnouncementType?: string;
}

export type MessageReactionType =
  | { kind: "emoji"; emoji: string }
  | { kind: "customEmoji"; customEmojiId: string }
  | { kind: "paid" };

export interface MessageReaction {
  type: MessageReactionType;
  totalCount: number;
  chosen: boolean;
  recentSenderIds: string[];
}

export interface MessageInteraction {
  viewCount: number;
  forwardCount: number;
  replyCount: number;
  reactions: MessageReaction[];
}

export interface MessagePermissions {
  canReply: boolean;
  canEdit: boolean;
  canDeleteOnlyForSelf: boolean;
  canDeleteForAllUsers: boolean;
  canForward: boolean;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  outgoing: boolean;
  sentAt: string;
  delivery: DeliveryState;
  canRetry?: boolean;
  editedAt?: string;
  replyTo?: MessageReplyTarget;
  forwardInfo?: MessageForwardInfo;
  interaction?: MessageInteraction;
  permissions?: MessagePermissions;
  content: MessageContent;
}

export interface TelegramSnapshot {
  currentUserId: string;
  authorization: AuthorizationState;
  users: User[];
  folders: ChatFolder[];
  chats: Chat[];
  messages: Message[];
  drafts?: ChatDraft[];
}

export interface CachedTelegramSnapshot {
  version: 1;
  savedAt: string;
  currentUserId: string;
  users: User[];
  folders: ChatFolder[];
  chats: Chat[];
  messages: Message[];
  drafts?: ChatDraft[];
  activeChatId?: string;
  chatFilter?: string;
}

export type TelegramEvent =
  | { type: "authorization.changed"; state: AuthorizationState }
  | { type: "connection.changed"; status: ConnectionStatus }
  | { type: "currentUser.changed"; userId: string }
  | { type: "message.upsert"; message: Message }
  | { type: "messages.upserted"; messages: Message[] }
  | { type: "message.remove"; chatId: string; messageId: string }
  | { type: "folders.replaced"; folders: ChatFolder[] }
  | { type: "chats.upserted"; chats: Chat[] }
  | { type: "chat.upsert"; chat: Chat }
  | { type: "drafts.replaced"; drafts: ChatDraft[]; chatIds: string[] }
  | { type: "chat.draftChanged"; chatId: string; draft?: ChatDraft }
  | { type: "user.upsert"; user: User }
  | { type: "sync.error"; message: string; fatal?: boolean };

export interface SendMessageInput {
  chatId: string;
  text: string;
  replyToMessageId?: string;
}

export interface EditMessageInput {
  chatId: string;
  messageId: string;
  text: string;
}

export interface DeleteMessageInput {
  chatId: string;
  messageId: string;
  revoke: boolean;
}

export interface ForwardMessagesInput {
  fromChatId: string;
  toChatId: string;
  messageIds: string[];
}

export interface ForwardMessagesResult {
  forwardedCount: number;
  failedMessageIds: string[];
}

export interface SetChatDraftInput {
  chatId: string;
  text: string;
  replyToMessageId?: string;
}

export interface SetMessageReactionInput {
  chatId: string;
  messageId: string;
  emoji: string;
  chosen: boolean;
}

export interface SendFileInput {
  chatId: string;
  file?: File;
}

export interface StreamFileInput {
  fileId: number;
  size: number;
  mimeType?: string;
}

export interface ChatHistoryPage {
  loadedCount: number;
  hasMore: boolean;
  messageIds: string[];
}

export interface ChatListPage {
  loadedCount: number;
  hasMore: boolean;
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
