import type { TelegramTransport } from "../telegram/transport";
import type { CacheHealth } from "./telegramStore.cache";
import type { GlobalSearchState } from "./globalSearchState";
import type { ChatMessageSearchState } from "./chatMessageSearchState";
import type { ProfileState } from "./profileState";
import type {
  AuthorizationAction,
  AuthorizationState,
  Chat,
  ChatEventLogInput,
  ChatEventPage,
  ChatInviteLink,
  ChatInviteLinkPage,
  ChatJoinRequestPage,
  BotCommandSuggestion,
  CallbackQueryAnswer,
  InlineQueryResultPage,
  BlockedSender,
  ChatReportOptions,
  ReportChatInput,
  DeviceSession,
  PrivacyRule,
  PrivacySettingKey,
  ChatManagement,
  ChatMemberStatusInput,
  ChatPermissions,
  ChatDraft,
  ChatFolder,
  CacheCategory,
  CacheCleanupResult,
  CacheUsage,
  ConnectionStatus,
  CreateChatInput,
  CreateChatInviteLinkInput,
  ForwardMessagesResult,
  ForumTopic,
  ForumTopicPage,
  EmojiPickerAsset,
  EmojiPickerCatalog,
  GlobalSearchFilter,
  ChatMessageSearchInput,
  GetChatInviteLinksInput,
  GetChatJoinRequestsInput,
  LocalAttachmentDraft,
  Message,
  MessagePermissions,
  MessageReactionSenderPage,
  MessageReactionType,
  MessageReplyQuote,
  MessageTextEntity,
  ProxySettings,
  QueuedOutgoingMessage,
  SharedMediaPage,
  SharedMediaSearchInput,
  StorageSettings,
  StickerSet,
  TelegramAccount,
  UpdateCurrentUserProfileInput,
  User,
} from "../telegram/types";

export type ChatFilter = string;
export type RuntimePhase = "idle" | "loading" | "ready" | "error";

export interface HistoryState {
  loading: boolean;
  hasMore: boolean;
  initialized: boolean;
}

export interface ChatListState {
  loading: boolean;
  hasMore: boolean;
}

export type MessageChangeEvent =
  | { type: "reset"; messages: ReadonlyMap<string, Message[]> }
  | { type: "upsert"; messages: readonly Message[]; liveMessages: readonly Message[] }
  | { type: "replace"; oldMessageId: string; message: Message }
  | { type: "remove"; chatId: string; messageIds: readonly string[] };

export type MessageChangeListener = (event: MessageChangeEvent) => void;

export interface TelegramState {
  phase: RuntimePhase;
  error?: string;
  operationError?: string;
  transportKind: TelegramTransport["kind"];
  transportLabel: string;
  connectionStatus: ConnectionStatus;
  currentUserId?: string;
  authorization: AuthorizationState;
  authorizationPending: boolean;
  authorizationError?: string;
  proxySettings?: ProxySettings;
  proxyPending: boolean;
  proxyError?: string;
  proxyLatencyMs?: number;
  storageSettings?: StorageSettings;
  cacheUsage?: CacheUsage;
  cacheCleanupResult?: CacheCleanupResult;
  storagePending: boolean;
  storageError?: string;
  cacheHealth: CacheHealth;
  accounts: TelegramAccount[];
  activeAccountId: string;
  accountPending: boolean;
  accountError?: string;
  users: Map<string, User>;
  userIdsByUsername: Map<string, string>;
  folders: ChatFolder[];
  chats: Map<string, Chat>;
  chatListReady: boolean;
  chatLists: Map<string, ChatListState>;
  messages: Map<string, Message[]>;
  subscribeMessageChanges: (listener: MessageChangeListener) => () => void;
  removingMessages: Map<string, Message[]>;
  unreadAttentionMessageIds: Map<string, string[]>;
  drafts: Map<string, ChatDraft>;
  localAttachmentDrafts: Map<string, LocalAttachmentDraft>;
  typingUserIds: Map<string, string[]>;
  outbox: QueuedOutgoingMessage[];
  histories: Map<string, HistoryState>;
  forumTopics: Map<string, ForumTopic[]>;
  forumTopicsLoading: Set<string>;
  topicHistories: Map<string, HistoryState>;
  lastForumTopicIds: Map<string, string>;
  activeChatId?: string;
  activeTopicId?: string;
  searchQuery: string;
  chatFilter: ChatFilter;
  globalSearch: GlobalSearchState;
  chatMessageSearch: ChatMessageSearchState;
  accountProfile: ProfileState;
  profile: ProfileState;
  contacts: User[];
  contactsLoading: boolean;
  contactsError?: string;
  contactPendingUserId?: string;
  chatManagementPending: Set<string>;
  folderManagementPending: boolean;
  chatCreationPending: boolean;
  groupManagement?: ChatManagement;
  groupManagementLoading: boolean;
  groupManagementError?: string;
  blockedSenders: BlockedSender[];
  blockedSendersLoading: boolean;
  initialize: (options?: { settingsOnly?: boolean }) => Promise<void>;
  authenticate: (action: AuthorizationAction) => Promise<void>;
  loadProxySettings: () => Promise<void>;
  saveProxySettings: (settings: ProxySettings) => Promise<boolean>;
  testProxy: (settings: ProxySettings) => Promise<void>;
  loadStorageSettings: () => Promise<void>;
  saveStorageSettings: (settings: StorageSettings) => Promise<boolean>;
  loadCacheUsage: () => Promise<void>;
  clearMediaCache: (categories: CacheCategory[], olderThanDays?: number) => Promise<boolean>;
  rebuildCachedSnapshot: () => Promise<boolean>;
  addAccount: () => Promise<boolean>;
  switchAccount: (accountId: string) => Promise<boolean>;
  logOutCurrentAccount: () => Promise<boolean>;
  /** Selection commits synchronously; history/read work continues in the background. */
  selectChat: (chatId: string, options?: { forumTopicId?: string }) => void;
  selectForumTopic: (topicId?: string) => void;
  loadForumTopics: (chatId: string, query?: string) => Promise<ForumTopicPage | undefined>;
  resolveForumTopic: (chatId: string, topicId: string) => Promise<ForumTopic | undefined>;
  createForumTopic: (chatId: string, name: string) => Promise<ForumTopic | undefined>;
  editForumTopic: (chatId: string, topicId: string, name: string) => Promise<boolean>;
  setForumTopicClosed: (chatId: string, topicId: string, closed: boolean) => Promise<boolean>;
  setForumTopicPinned: (chatId: string, topicId: string, pinned: boolean) => Promise<boolean>;
  resolveTelegramLink: (url: string) => Promise<import("../telegram/types").TelegramLinkTarget | undefined>;
  loadMoreChats: (chatListId?: string) => Promise<void>;
  setChatPinned: (chatListId: string, chatId: string, pinned: boolean) => Promise<boolean>;
  reorderPinnedChats: (chatListId: string, chatIds: string[]) => Promise<boolean>;
  setChatMuted: (chatId: string, muted: boolean) => Promise<boolean>;
  setChatArchived: (chatId: string, archived: boolean) => Promise<boolean>;
  leaveGroup: (chatId: string) => Promise<boolean>;
  createChatFolder: (title: string, chatIds: string[]) => Promise<string | undefined>;
  renameChatFolder: (folderId: string, title: string) => Promise<boolean>;
  deleteChatFolder: (folderId: string) => Promise<boolean>;
  reorderChatFolders: (folderIds: string[]) => Promise<boolean>;
  setChatFolderMembership: (
    folderId: string,
    chatId: string,
    included: boolean,
  ) => Promise<boolean>;
  markChatFolderRead: (folderId: string) => Promise<boolean>;
  loadMoreHistory: (chatId: string) => Promise<void>;
  loadMessage: (chatId: string, messageId: string, options?: { forceContext?: boolean }) => Promise<boolean>;
  markActiveChatRead: () => Promise<void>;
  dismissMessageAttention: (chatId: string, messageIds: string[]) => void;
  loadMessageProperties: (
    chatId: string,
    messageId: string,
    force?: boolean,
  ) => Promise<MessagePermissions | undefined>;
  searchChatMessages: (input: ChatMessageSearchInput) => Promise<void>;
  loadMoreChatMessages: () => Promise<void>;
  cancelChatMessageSearch: () => void;
  clearChatMessageSearch: () => void;
  searchGlobal: (query: string, filter?: GlobalSearchFilter) => Promise<void>;
  loadMoreGlobalSearch: () => Promise<void>;
  cancelGlobalSearch: () => void;
  clearGlobalSearch: () => void;
  loadCurrentUserProfile: () => Promise<void>;
  updateCurrentUserProfile: (input: UpdateCurrentUserProfileInput) => Promise<boolean>;
  changeCurrentUserAvatar: (file?: File) => Promise<boolean>;
  loadChatProfile: (chatId: string) => Promise<void>;
  loadMoreChatProfileMembers: (chatId: string) => Promise<boolean>;
  loadUserProfile: (userId: string) => Promise<void>;
  clearProfile: () => void;
  loadContacts: () => Promise<void>;
  startPrivateChat: (userId: string) => Promise<string | undefined>;
  createChat: (input: CreateChatInput) => Promise<string | undefined>;
  loadChatManagement: (chatId: string, memberOffset?: number) => Promise<ChatManagement | undefined>;
  addChatMembers: (chatId: string, userIds: string[]) => Promise<boolean>;
  setChatMemberStatus: (chatId: string, userId: string, status: ChatMemberStatusInput) => Promise<boolean>;
  setChatMemberTag: (chatId: string, userId: string, tag: string) => Promise<boolean>;
  setChatPermissions: (chatId: string, permissions: ChatPermissions) => Promise<boolean>;
  setChatSlowModeDelay: (chatId: string, delaySeconds: number) => Promise<boolean>;
  transferChatOwnership: (chatId: string, userId: string, password: string) => Promise<boolean>;
  loadChatEventLog: (input: ChatEventLogInput) => Promise<ChatEventPage | undefined>;
  getChatInviteLinks: (input: GetChatInviteLinksInput) => Promise<ChatInviteLinkPage | undefined>;
  createChatInviteLink: (input: CreateChatInviteLinkInput) => Promise<ChatInviteLink | undefined>;
  editChatInviteLink: (input: CreateChatInviteLinkInput & { inviteLink: string }) => Promise<ChatInviteLink | undefined>;
  revokeChatInviteLink: (chatId: string, inviteLink: string) => Promise<boolean>;
  getChatJoinRequests: (input: GetChatJoinRequestsInput) => Promise<ChatJoinRequestPage | undefined>;
  processChatJoinRequest: (chatId: string, userId: string, approve: boolean) => Promise<boolean>;
  processChatJoinRequests: (chatId: string, inviteLink: string | undefined, approve: boolean) => Promise<boolean>;
  getBotCommandSuggestions: (chatId: string, query?: string, botUsername?: string) => Promise<BotCommandSuggestion[]>;
  getCallbackQueryAnswer: (messageId: string, data: string) => Promise<CallbackQueryAnswer | undefined>;
  getInlineQueryResults: (chatId: string, botUsername: string, query: string, offset?: string) => Promise<InlineQueryResultPage | undefined>;
  sendInlineQueryResultMessage: (chatId: string, botUserId: string, queryId: string, resultId: string, replyToMessageId?: string, topicId?: string) => Promise<boolean>;
  sendBotStartMessage: (chatId: string, botUserId: string, parameter?: string) => Promise<boolean>;
  loadBlockedSenders: () => Promise<void>;
  setMessageSenderBlocked: (senderId: string, kind: "user" | "chat", blocked: boolean) => Promise<boolean>;
  getChatReportOptions: (chatId: string, messageIds: string[]) => Promise<ChatReportOptions | undefined>;
  reportChat: (input: ReportChatInput) => Promise<boolean>;
  getActiveSessions: () => Promise<DeviceSession[]>;
  terminateSession: (sessionId: string) => Promise<boolean>;
  terminateAllOtherSessions: () => Promise<boolean>;
  getPrivacySettingRules: (setting: PrivacySettingKey) => Promise<PrivacyRule[]>;
  setPrivacySettingRules: (setting: PrivacySettingKey, rules: PrivacyRule[]) => Promise<boolean>;
  setMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  getMessageReactionSenders: (
    messageId: string,
    type: MessageReactionType,
    offset?: string,
  ) => Promise<MessageReactionSenderPage>;
  setPollAnswer: (messageId: string, optionPositions: number[]) => Promise<boolean>;
  loadPinnedMessages: (chatId: string) => Promise<Message[]>;
  pinMessage: (
    messageId: string,
    disableNotification: boolean,
    onlyForSelf: boolean,
  ) => Promise<boolean>;
  unpinMessage: (messageId: string) => Promise<boolean>;
  setChatMessageAutoDeleteTime: (
    chatId: string,
    messageAutoDeleteTime: number,
  ) => Promise<boolean>;
  loadSharedMedia: (input: SharedMediaSearchInput, force?: boolean) => Promise<SharedMediaPage | undefined>;
  deleteMessagesFromChat: (chatId: string, messageIds: string[], revoke: boolean) => Promise<boolean>;
  loadEmojiPicker: () => Promise<EmojiPickerCatalog | undefined>;
  loadStickerSet: (stickerSetId: string) => Promise<StickerSet | undefined>;
  addStickerSet: (stickerSetId: string) => Promise<boolean>;
  searchStickers: (query: string, chatId: string) => Promise<EmojiPickerAsset[]>;
  loadEmojiAsset: (asset: EmojiPickerAsset) => Promise<string | undefined>;
  sendSticker: (asset: EmojiPickerAsset, replyToMessageId?: string) => Promise<boolean>;
  sendAnimation: (asset: EmojiPickerAsset, replyToMessageId?: string) => Promise<boolean>;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: ChatFilter) => void;
  sendMessage: (text: string, replyToMessageId?: string, replyQuote?: MessageReplyQuote, entities?: MessageTextEntity[]) => Promise<boolean>;
  editMessage: (messageId: string, text: string, entities?: MessageTextEntity[]) => Promise<boolean>;
  deleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  updateChatDraft: (chatId: string, text: string, replyToMessageId?: string, replyQuote?: MessageReplyQuote, entities?: MessageTextEntity[]) => void;
  loadLocalAttachmentDraft: (draftKey: string) => Promise<import("../telegram/types").OutgoingAttachment[]>;
  saveLocalAttachmentDraft: (
    draftKey: string,
    chatId: string,
    attachments: import("../telegram/types").OutgoingAttachment[],
    options: Pick<LocalAttachmentDraft, "mode" | "hasSpoiler" | "muteVideos">,
  ) => Promise<boolean>;
  updateLocalAttachmentDraftOptions: (
    draftKey: string,
    options: Partial<Pick<LocalAttachmentDraft, "mode" | "hasSpoiler" | "muteVideos">>,
  ) => void;
  clearLocalAttachmentDraft: (draftKey: string) => Promise<void>;
  setChatTyping: (chatId: string, typing: boolean) => Promise<void>;
  forwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
    toTopicId?: string,
    description?: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  cacheFile: (fileId: number, priority?: number) => Promise<void>;
  recoverFile: (fileId: number, priority?: number) => Promise<boolean>;
  streamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  suspendFileStream: (fileId: number) => Promise<void>;
  downloadFile: (fileId: number, fileName: string) => Promise<void>;
  cancelFileDownload: (fileId: number) => Promise<void>;
  openFile: (sourcePath: string, fileId?: number) => Promise<boolean>;
  saveFileToDownloads: (sourcePath: string, fileName: string) => Promise<void>;
  saveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  openDownloadDirectory: () => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  sendFile: (file?: File) => Promise<boolean>;
  sendFiles: (attachments: import("../telegram/types").OutgoingAttachment[], caption?: string, captionEntities?: MessageTextEntity[]) => Promise<boolean>;
  cancelFileUpload: (messageId: string) => Promise<void>;
  clearError: () => void;
  clearOperationError: () => void;
}
