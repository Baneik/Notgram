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
  firstName?: string;
  lastName?: string;
  username?: string;
  phoneNumber?: string;
  isBot?: boolean;
  avatar: Avatar;
  presence: "online" | "offline" | "typing";
  lastSeenLabel?: string;
}

export type ProfileKind = "self" | "user" | "group" | "channel";
export type ProfileMemberRole = "owner" | "administrator" | "member";

export type ChatPermissionKey =
  | "canSendBasicMessages"
  | "canSendAudios"
  | "canSendDocuments"
  | "canSendPhotos"
  | "canSendVideos"
  | "canSendVideoNotes"
  | "canSendVoiceNotes"
  | "canSendPolls"
  | "canSendOtherMessages"
  | "canAddLinkPreviews"
  | "canReactToMessages"
  | "canEditTag"
  | "canChangeInfo"
  | "canInviteUsers"
  | "canPinMessages"
  | "canCreateTopics";

export type ChatPermissions = Record<ChatPermissionKey, boolean>;

export type ChatAdminRightKey =
  | "canManageChat"
  | "canChangeInfo"
  | "canPostMessages"
  | "canEditMessages"
  | "canDeleteMessages"
  | "canInviteUsers"
  | "canRestrictMembers"
  | "canPinMessages"
  | "canManageTopics"
  | "canPromoteMembers"
  | "canManageVideoChats"
  | "canPostStories"
  | "canEditStories"
  | "canDeleteStories"
  | "canManageDirectMessages"
  | "canManageTags"
  | "isAnonymous";

export type ChatAdminRights = Record<ChatAdminRightKey, boolean>;

export type ManagedMemberStatus = "owner" | "administrator" | "member" | "restricted" | "banned" | "left";

export interface ManagedChatMember extends ProfileMember {
  status: ManagedMemberStatus;
  adminRights?: ChatAdminRights;
  permissions?: ChatPermissions;
  untilDate?: number;
  customTitle?: string;
  canBeEdited?: boolean;
}

export type ManagedChatType = "basicGroup" | "supergroup" | "channel";

export interface ChatManagementCapabilities {
  chatType: ManagedChatType;
  status: ManagedMemberStatus;
  adminRights?: ChatAdminRights;
  canOpenManagement: boolean;
  canAddMembers: boolean;
  canPromoteMembers: boolean;
  canRestrictMembers: boolean;
  canManagePermissions: boolean;
  canManageSlowMode: boolean;
  canTransferOwnership: boolean;
  canManageInvites: boolean;
  canManageAllInvites: boolean;
  canViewEventLog: boolean;
  canChangeInfo: boolean;
  canManageTopics: boolean;
  canManageTags: boolean;
}

export interface OwnershipTransferAvailability {
  available: boolean;
  reason?: "passwordNeeded" | "passwordTooFresh" | "sessionTooFresh";
  retryAfter?: number;
}

export interface ChatManagement {
  chatId: string;
  members: ManagedChatMember[];
  memberCount?: number;
  administratorLabels?: Record<string, string>;
  permissions: ChatPermissions;
  slowModeDelay: number;
  capabilities: ChatManagementCapabilities;
  ownershipTransfer?: OwnershipTransferAvailability;
  memberOffset?: number;
  memberHasMore: boolean;
}

export type ChatMemberStatusInput =
  | { kind: "member" }
  | { kind: "administrator"; rights: ChatAdminRights }
  | { kind: "restricted"; permissions: ChatPermissions; untilDate?: number }
  | { kind: "banned"; untilDate?: number };

export interface SetChatMemberStatusInput {
  chatId: string;
  userId: string;
  status: ChatMemberStatusInput;
}

export interface ChatEventLogFilters {
  messageEdits: boolean;
  messageDeletions: boolean;
  messagePins: boolean;
  memberJoins: boolean;
  memberLeaves: boolean;
  memberInvites: boolean;
  memberPromotions: boolean;
  memberRestrictions: boolean;
  memberTagChanges: boolean;
  infoChanges: boolean;
  settingChanges: boolean;
  inviteLinkChanges: boolean;
  videoChatChanges: boolean;
  forumChanges: boolean;
  subscriptionExtensions: boolean;
}

export interface ChatEvent {
  id: string;
  date: string;
  actor?: User;
  summary: string;
  kind: string;
}

export interface ChatEventPage {
  events: ChatEvent[];
  nextEventId?: string;
  hasMore: boolean;
}

export interface ChatEventLogInput {
  chatId: string;
  query?: string;
  fromEventId?: string;
  limit?: number;
  filters?: ChatEventLogFilters;
}

export interface ChatInviteLink {
  inviteLink: string;
  name: string;
  creatorUserId?: string;
  createdAt: string;
  editedAt?: string;
  expiresAt?: string;
  memberLimit: number;
  memberCount: number;
  expiredMemberCount: number;
  pendingJoinRequestCount: number;
  createsJoinRequest: boolean;
  isPrimary: boolean;
  isRevoked: boolean;
  subscriptionStars?: number;
  subscriptionPeriod?: number;
}

export interface ChatInviteLinkPage {
  links: ChatInviteLink[];
  hasMore: boolean;
  nextOffsetDate?: number;
  nextOffsetLink?: string;
}

export interface CreateChatInviteLinkInput {
  chatId: string;
  name: string;
  expirationDate?: number;
  memberLimit?: number;
  createsJoinRequest?: boolean;
  subscriptionStars?: number;
}

export interface GetChatInviteLinksInput {
  chatId: string;
  creatorUserId?: string;
  revoked?: boolean;
  offsetDate?: number;
  offsetLink?: string;
  limit?: number;
}

export interface ChatJoinRequest {
  user: User;
  date: string;
  bio?: string;
  inviteLink?: string;
}

export interface ChatJoinRequestPage {
  requests: ChatJoinRequest[];
  totalCount: number;
  hasMore: boolean;
  nextOffsetUserId?: string;
  nextOffsetDate?: number;
}

export interface GetChatJoinRequestsInput {
  chatId: string;
  inviteLink?: string;
  query?: string;
  offsetUserId?: string;
  offsetDate?: number;
  limit?: number;
}

export interface BotCommandSuggestion {
  botUserId: string;
  botUsername: string;
  command: string;
  description: string;
}

export type MessageInlineKeyboardButton = {
  text: string;
  style: "default" | "primary" | "danger" | "success";
} & (
  | { kind: "callback"; data: string }
  | { kind: "url"; url: string }
  | { kind: "webApp"; url: string }
  | { kind: "user"; userId: string }
  | { kind: "copyText"; copyText: string }
  | { kind: "unsupported" }
);

export interface MessageInlineKeyboard {
  kind: "inlineKeyboard";
  rows: MessageInlineKeyboardButton[][];
}

export interface CallbackQueryAnswer {
  text?: string;
  showAlert: boolean;
  url?: string;
}

export interface InlineQueryResult {
  id: string;
  kind: "article" | "photo" | "video" | "file";
  title: string;
  description?: string;
  messageText: string;
  thumbnailUrl?: string;
  fileName?: string;
}

export interface InlineQueryResultPage {
  queryId: string;
  results: InlineQueryResult[];
  nextOffset?: string;
  hasMore: boolean;
}

export interface BlockedSender {
  id: string;
  kind: "user" | "chat";
  title: string;
  avatar: Avatar;
  blockedAt?: string;
}

export interface ReportOption {
  id: string;
  title: string;
  requiresText?: boolean;
}

export interface ChatReportOptions {
  title: string;
  options: ReportOption[];
}

export interface ReportChatInput {
  chatId: string;
  messageIds: string[];
  optionId: string;
  text?: string;
}

export interface DeviceSession {
  id: string;
  isCurrent: boolean;
  isPasswordPending: boolean;
  isUnconfirmed: boolean;
  canAcceptSecretChats: boolean;
  canAcceptCalls: boolean;
  applicationName: string;
  applicationVersion: string;
  deviceModel: string;
  platform: string;
  systemVersion: string;
  loggedInAt: string;
  lastActiveAt: string;
  ipAddress?: string;
  location?: string;
}

export type PrivacySettingKey = "showStatus" | "showPhoneNumber" | "showProfilePhoto" | "allowCalls" | "allowChatInvites" | "allowSecretChats";
export type PrivacyRuleKind = "allowAll" | "allowContacts" | "allowUsers" | "restrictAll" | "restrictContacts" | "restrictUsers";
export interface PrivacyRule { kind: PrivacyRuleKind; userIds?: string[]; }

export type TelegramLinkTarget =
  | { chatId: string; messageId?: string }
  | { kind: "user"; userId: string }
  | { kind: "unsupported"; reason: string; linkType?: string };

export interface ProfileMember {
  user: User;
  role: ProfileMemberRole;
}

export interface ChatProfileMembersPage {
  members: ProfileMember[];
  offset: number;
  hasMore: boolean;
}

export interface ChatProfile {
  id: string;
  kind: ProfileKind;
  chatId?: string;
  userId?: string;
  title: string;
  avatar: Avatar;
  statusLabel: string;
  bio?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phoneNumber?: string;
  dataCenterId?: number;
  dataCenterLocation?: string;
  memberCount?: number;
  members: ProfileMember[];
  canViewMembers: boolean;
  memberOffset?: number;
  memberHasMore?: boolean;
  groupInCommonCount?: number;
}

export interface UpdateCurrentUserProfileInput {
  firstName: string;
  lastName: string;
  username: string;
  bio: string;
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

export type EmojiPickerAssetKind = "sticker" | "animation";

export interface EmojiPickerAsset {
  id: string;
  kind: EmojiPickerAssetKind;
  fileId: number;
  previewFileId?: number;
  emoji?: string;
  fileName: string;
  mimeType?: string;
  previewMimeType?: string;
  localPath?: string;
  previewPath?: string;
  previewDataUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface StickerSetSummary {
  id: string;
  title: string;
  name: string;
  size: number;
  covers: EmojiPickerAsset[];
}

export interface StickerSet extends StickerSetSummary {
  stickers: EmojiPickerAsset[];
}

export interface EmojiPickerCatalog {
  recentStickers: EmojiPickerAsset[];
  stickerSets: StickerSetSummary[];
  savedAnimations: EmojiPickerAsset[];
}

export interface Chat {
  id: string;
  kind: ChatKind;
  isForum?: boolean;
  canCreateTopics?: boolean;
  management?: ChatManagementCapabilities;
  folderIds: string[];
  title: string;
  avatar: Avatar;
  peerId?: string;
  memberCount?: number;
  activeUserCount?: number;
  preview: string;
  previewSenderId?: string;
  updatedAt: string;
  unreadCount: number;
  unreadMentionCount: number;
  lastReadInboxMessageId?: string;
  pinned: boolean;
  pinnedFolderIds?: string[];
  listOrderByFolder?: Record<string, string>;
  muted: boolean;
  messageAutoDeleteTime?: number;
}

export type NewChatKind = "basicGroup" | "supergroup" | "channel";
export type ChatPermissionTemplate = "open" | "restricted";

export interface CreateChatInput {
  kind: NewChatKind;
  title: string;
  description?: string;
  memberUserIds: string[];
  isPublic?: boolean;
  username?: string;
  historyAvailable?: boolean;
  permissionTemplate?: ChatPermissionTemplate;
  selectPhoto?: boolean;
}

export interface MessageReplyQuote {
  text: string;
  position: number;
  /**
   * Formatting that belongs to the selected slice of the source message.
   * Telegram requires the formatting supported by text quotes to be kept.
   */
  entities?: MessageTextEntity[];
}

export interface ChatDraft {
  chatId: string;
  topicId?: string;
  text: string;
  replyToMessageId?: string;
  replyQuote?: MessageReplyQuote;
  updatedAt: string;
  pending?: boolean;
}

export type MessageTextEntityKind =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "customEmoji"
  | "dateTime"
  | "code"
  | "pre"
  | "blockquote"
  | "url"
  | "textUrl"
  | "email"
  | "phone";

export interface MessageDateTimeFormatting {
  unixTime: number;
  mode: "relative" | "absolute" | "original";
  timePrecision?: "none" | "short" | "long";
  datePrecision?: "none" | "short" | "long";
  showDayOfWeek?: boolean;
}

export interface MessageTextEntity {
  offset: number;
  length: number;
  kind: MessageTextEntityKind;
  href?: string;
  language?: string;
  customEmojiId?: string;
  dateTime?: MessageDateTimeFormatting;
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
  anchor?: { kind: "anchor" | "reference"; name: string };
  linkTarget?: { kind: "anchor" | "reference"; name: string };
  semantic?: "hashtag" | "cashtag" | "bankCard" | "botCommand";
  customEmojiId?: string;
  mathematicalExpression?: string;
  dateTime?: MessageDateTimeFormatting;
}

export interface MessageRichListItem {
  blocks: MessageRichBlock[];
  label?: string;
  hasCheckbox: boolean;
  checked: boolean;
  value?: number;
  type?: "a" | "A" | "i" | "I" | "1";
}

export interface MessageRichTableCell {
  text: MessageRichTextRun[];
  header: boolean;
  colspan: number;
  rowspan: number;
  visible: boolean;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
}

export interface MessageRichCaption {
  text: MessageRichTextRun[];
  credit?: MessageRichTextRun[];
}

export interface MessageRichMedia {
  mediaType: "photo" | "video" | "audio" | "voice" | "animation";
  fileName: string;
  sizeLabel: string;
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
  downloadedSize?: number;
  progress?: number;
  previewDataUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  hasSpoiler: boolean;
  autoplay: boolean;
  loop: boolean;
  caption?: MessageRichCaption;
  url?: string;
}

export interface MessagePollOption {
  id: string;
  position: number;
  text: string;
  entities?: MessageTextEntity[];
  voterCount: number;
  votePercentage: number;
  chosen: boolean;
  beingChosen: boolean;
  correct: boolean;
}

export interface MessagePollContent {
  kind: "poll";
  pollId: string;
  question: string;
  questionEntities?: MessageTextEntity[];
  options: MessagePollOption[];
  totalVoterCount: number;
  type: "regular" | "quiz";
  allowsMultipleAnswers: boolean;
  allowsRevoting: boolean;
  isAnonymous: boolean;
  isClosed: boolean;
  canSeeResults: boolean;
  restrictionReason?: string;
  explanation?: string;
  explanationEntities?: MessageTextEntity[];
}

export type MessageRichBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: MessageRichTextRun[] }
  | { kind: "paragraph"; text: MessageRichTextRun[] }
  | { kind: "preformatted"; text: MessageRichTextRun[]; language?: string }
  | { kind: "footer"; text: MessageRichTextRun[] }
  | { kind: "thinking"; text: MessageRichTextRun[] }
  | { kind: "mathematicalExpression"; expression: string }
  | { kind: "anchor"; name: string }
  | { kind: "list"; ordered: boolean; items: MessageRichListItem[] }
  | {
      kind: "quote";
      blocks: MessageRichBlock[];
      credit?: MessageRichTextRun[];
      pull: boolean;
    }
  | { kind: "details"; summary: MessageRichTextRun[]; blocks: MessageRichBlock[]; open: boolean }
  | {
      kind: "table";
      caption?: MessageRichTextRun[];
      rows: MessageRichTableCell[][];
      bordered: boolean;
      striped: boolean;
    }
  | { kind: "media"; media: MessageRichMedia }
  | {
      kind: "collection";
      layout: "collage" | "slideshow";
      blocks: MessageRichBlock[];
      caption?: MessageRichCaption;
    }
  | {
      kind: "map";
      latitude: number;
      longitude: number;
      horizontalAccuracy?: number;
      zoom: number;
      width: number;
      height: number;
      caption?: MessageRichCaption;
    }
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
  duration?: number;
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
  | { kind: "service"; text: string; memberUserIds?: string[] }
  | MessagePollContent
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
      senderId?: string;
      quote?: string;
      origin?: MessageOrigin;
      sentAt?: string;
      content?: MessageContent;
      outgoing?: boolean;
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
  canPin?: boolean;
}

export interface MessageSendFailure {
  code?: number;
  message?: string;
  needAnotherReplyQuote?: boolean;
  needDropReply?: boolean;
  needAnotherSender?: boolean;
  requiredPaidMessageStarCount?: string;
  retryAfter?: number;
}

export interface Message {
  id: string;
  renderKey?: string;
  chatId: string;
  topicId?: string;
  mediaAlbumId?: string;
  senderId: string;
  senderTag?: string;
  authorSignature?: string;
  isChannelPost?: boolean;
  outgoing: boolean;
  sentAt: string;
  delivery: DeliveryState;
  canRetry?: boolean;
  sendFailure?: MessageSendFailure;
  editedAt?: string;
  replyTo?: MessageReplyTarget;
  forwardInfo?: MessageForwardInfo;
  interaction?: MessageInteraction;
  isPinned?: boolean;
  permissions?: MessagePermissions;
  isRemoving?: boolean;
  isPending?: boolean;
  containsUnreadMention?: boolean;
  replyMarkup?: MessageInlineKeyboard;
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
  version: 1 | 2 | 3;
  savedAt: string;
  currentUserId: string;
  users: User[];
  folders: ChatFolder[];
  chats: Chat[];
  messages: Message[];
  drafts?: ChatDraft[];
  outbox?: QueuedOutgoingMessage[];
  activeChatId?: string;
  chatFilter?: string;
  profiles?: ChatProfile[];
  forumTopics?: Array<{ chatId: string; topics: ForumTopic[] }>;
  lastForumTopicIds?: Array<{ chatId: string; topicId: string }>;
}

export interface QueuedOutgoingMessage {
  id: string;
  chatId: string;
  topicId?: string;
  text: string;
  replyToMessageId?: string;
  replyQuote?: MessageReplyQuote;
  createdAt: string;
  status: "queued" | "failed";
  kind?: "text" | "attachments";
  caption?: string;
  attachments?: QueuedOutgoingAttachment[];
  error?: string;
}

export interface QueuedOutgoingAttachment {
  storageId: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  fingerprint: string;
  kind: OutgoingAttachmentKind;
  width?: number;
  height?: number;
  duration?: number;
  title?: string;
  performer?: string;
  thumbnailStorageId?: string;
  hasSpoiler?: boolean;
  showCaptionAboveMedia?: boolean;
}

export type TelegramEvent =
  | { type: "authorization.changed"; state: AuthorizationState }
  | { type: "connection.changed"; status: ConnectionStatus }
  | { type: "currentUser.changed"; userId: string }
  | { type: "message.upsert"; message: Message; animateEntrance?: boolean }
  | { type: "message.replace"; oldMessageId: string; message: Message }
  | { type: "messages.upserted"; messages: Message[] }
  | { type: "message.remove"; chatId: string; messageId: string; immediate?: boolean }
  | { type: "folders.replaced"; folders: ChatFolder[] }
  | { type: "chats.upserted"; chats: Chat[] }
  | { type: "chat.upsert"; chat: Chat }
  | { type: "drafts.replaced"; drafts: ChatDraft[]; chatIds: string[] }
  | { type: "chat.draftChanged"; chatId: string; draft?: ChatDraft }
  | { type: "chat.typingChanged"; chatId: string; senderId: string; typing: boolean }
  | { type: "forumTopics.changed"; chatId: string }
  | { type: "user.upsert"; user: User }
  | { type: "sync.error"; message: string; fatal?: boolean };

export interface SendMessageInput {
  chatId: string;
  topicId?: string;
  text: string;
  replyToMessageId?: string;
  replyQuote?: MessageReplyQuote;
  clearDraft?: boolean;
}

export interface SendEmojiAssetInput {
  chatId: string;
  topicId?: string;
  asset: EmojiPickerAsset;
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
  toTopicId?: string;
  messageIds: string[];
}

export interface ForwardMessagesResult {
  forwardedCount: number;
  failedMessageIds: string[];
}

export interface SetChatDraftInput {
  chatId: string;
  topicId?: string;
  text: string;
  replyToMessageId?: string;
  replyQuote?: MessageReplyQuote;
}

export interface SetMessageReactionInput {
  chatId: string;
  messageId: string;
  emoji: string;
  chosen: boolean;
}

export interface SetPollAnswerInput {
  chatId: string;
  messageId: string;
  optionPositions: number[];
}

export interface PinMessageInput {
  chatId: string;
  messageId: string;
  disableNotification: boolean;
  onlyForSelf: boolean;
}

export interface SetChatMessageAutoDeleteTimeInput {
  chatId: string;
  messageAutoDeleteTime: number;
}

export interface SendFileInput {
  chatId: string;
  topicId?: string;
  file?: File;
}

export type OutgoingAttachmentKind = "photo" | "video" | "audio" | "animation" | "document";

export interface OutgoingAttachment {
  file: File;
  kind: OutgoingAttachmentKind;
  width?: number;
  height?: number;
  duration?: number;
  title?: string;
  performer?: string;
  thumbnail?: File;
  hasSpoiler?: boolean;
  showCaptionAboveMedia?: boolean;
}

export interface SendFilesInput {
  chatId: string;
  topicId?: string;
  attachments: OutgoingAttachment[];
  caption?: string;
}

export const TELEGRAM_ALBUM_MAX_ITEMS = 10;

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

export interface ForumTopic {
  id: string;
  chatId: string;
  name: string;
  iconColor: number;
  iconCustomEmojiId?: string;
  createdAt: string;
  isGeneral: boolean;
  isOutgoing: boolean;
  isClosed: boolean;
  isHidden: boolean;
  isPinned: boolean;
  unreadCount: number;
  unreadMentionCount: number;
  unreadReactionCount: number;
  lastReadInboxMessageId?: string;
  lastReadOutboxMessageId?: string;
  lastMessage?: Message;
  order: string;
  muted: boolean;
  draft?: ChatDraft;
}

export interface ForumTopicPage {
  topics: ForumTopic[];
  totalCount?: number;
  nextOffsetDate?: number;
  nextOffsetMessageId?: string;
  nextOffsetTopicId?: string;
  hasMore: boolean;
}

export interface GetForumTopicsInput {
  chatId: string;
  query?: string;
  offsetDate?: number;
  offsetMessageId?: string;
  offsetTopicId?: string;
  limit?: number;
}

export interface CreateForumTopicInput {
  chatId: string;
  name: string;
  iconColor?: number;
}

export interface ChatListPage {
  loadedCount: number;
  hasMore: boolean;
}

export type ChatMessageSearchFilter =
  | "all"
  | "animation"
  | "audio"
  | "document"
  | "photo"
  | "poll"
  | "video"
  | "voiceNote"
  | "photoAndVideo"
  | "url"
  | "chatPhoto"
  | "videoNote"
  | "voiceAndVideoNote"
  | "mention"
  | "unreadMention"
  | "unreadReaction"
  | "unreadPollVote"
  | "failedToSend"
  | "pinned";

export interface ChatMessageSearchInput {
  chatId: string;
  topicId?: string;
  query?: string;
  senderId?: string;
  filter?: ChatMessageSearchFilter;
  fromMessageId?: string;
  minDate?: number;
  maxDate?: number;
  limit?: number;
}

export interface ChatMessageSearchPage {
  messages: Message[];
  totalCount?: number;
  nextFromMessageId?: string;
  hasMore: boolean;
}

export type GlobalSearchFilter = "all" | "message" | "media" | "file" | "link";

export interface GlobalSearchInput {
  query: string;
  filter: GlobalSearchFilter;
  offset?: string;
  limit?: number;
}

export interface GlobalSearchPage {
  chats: Chat[];
  messages: Message[];
  totalCount?: number;
  nextOffset?: string;
}

export type SharedMediaCategory = "media" | "file" | "link" | "audio";

export interface SharedMediaSearchInput {
  chatId: string;
  category: SharedMediaCategory;
  query?: string;
  fromMessageId?: string;
  limit?: number;
}

export interface SharedMediaPage {
  messages: Message[];
  totalCount?: number;
  nextFromMessageId?: string;
  hasMore: boolean;
  cached?: boolean;
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

export type CacheCategory = "image" | "video" | "audio" | "document" | "other";

export interface CacheUsageItem {
  bytes: number;
  files: number;
}

export interface CacheUsage {
  total: CacheUsageItem;
  images: CacheUsageItem;
  videos: CacheUsageItem;
  audio: CacheUsageItem;
  documents: CacheUsageItem;
  other: CacheUsageItem;
}

export interface CacheCleanupInput {
  categories: CacheCategory[];
  olderThanDays?: number;
  protectedPaths: string[];
}

export interface CacheCleanupResult {
  removedBytes: number;
  removedFiles: number;
  skippedProtectedFiles: number;
  failedFiles: number;
  usage: CacheUsage;
}

export type AuthorizationAction =
  | { kind: "qr" }
  | { kind: "phone"; phoneNumber: string }
  | { kind: "code"; code: string }
  | { kind: "password"; password: string }
  | { kind: "emailAddress"; emailAddress: string }
  | { kind: "emailCode"; code: string }
  | { kind: "registration"; firstName: string; lastName: string };
