import type {
  DeleteMessageInput,
  EditMessageInput,
  EmojiPickerAsset,
  EmojiPickerCatalog,
  ForwardMessagesInput,
  ForwardMessagesResult,
  ForumTopic,
  ForumTopicPage,
  GetForumTopicsInput,
  CreateForumTopicInput,
  GlobalSearchInput,
  GlobalSearchPage,
  SetChatDraftInput,
  SetMessageReactionInput,
  SetPollAnswerInput,
  SendFileInput,
  SendFilesInput,
  SendEmojiAssetInput,
  StreamFileInput,
  SendMessageInput,
  ChatHistoryPage,
  ChatListPage,
  CacheCleanupInput,
  CacheCleanupResult,
  CacheUsage,
  CachedTelegramSnapshot,
  Chat,
  ChatEventLogInput,
  ChatEventPage,
  ChatManagement,
  ChatInviteLink,
  ChatInviteLinkPage,
  ChatJoinRequestPage,
  CreateChatInviteLinkInput,
  GetChatInviteLinksInput,
  GetChatJoinRequestsInput,
  BotCommandSuggestion,
  CallbackQueryAnswer,
  InlineQueryResultPage,
  BlockedSender,
  ChatReportOptions,
  ReportChatInput,
  DeviceSession,
  PrivacyRule,
  PrivacySettingKey,
  ChatMemberStatusInput,
  ChatPermissions,
  CreateChatInput,
  ChatFolder,
  ChatProfile,
  ChatProfileMembersPage,
  TelegramEvent,
  TelegramSnapshot,
  TelegramAccount,
  TelegramAccountState,
  UpdateCurrentUserProfileInput,
  ProxySettings,
  StorageSettings,
  StickerSet,
  Message,
  MessagePermissions,
  PinMessageInput,
  SetChatMessageAutoDeleteTimeInput,
  ChatMessageSearchInput,
  ChatMessageSearchPage,
  SharedMediaPage,
  SharedMediaSearchInput,
  User,
} from "./types";
import type { AuthorizationAction } from "./types";

export type TelegramEventListener = (event: TelegramEvent) => void;

export interface TelegramConnectOptions {
  settingsOnly?: boolean;
}

export interface TelegramTransport {
  readonly kind: "mock" | "tauri";
  readonly label: string;
  connect(listener: TelegramEventListener, options?: TelegramConnectOptions): Promise<TelegramSnapshot>;
  disconnect(): Promise<void>;
  loadCachedSnapshot(): Promise<CachedTelegramSnapshot | undefined>;
  saveCachedSnapshot(snapshot: CachedTelegramSnapshot): Promise<void>;
  clearCachedSnapshot(): Promise<void>;
  getAccountState(): Promise<TelegramAccountState>;
  registerCurrentAccount(account: Omit<TelegramAccount, "id">): Promise<TelegramAccountState>;
  selectAccount(accountId: string): Promise<TelegramAccountState>;
  removeAccount(accountId: string): Promise<TelegramAccountState>;
  logOut(): Promise<void>;
  authenticate(action: AuthorizationAction): Promise<void>;
  getProxySettings(): Promise<ProxySettings>;
  saveProxySettings(settings: ProxySettings): Promise<void>;
  testProxy(settings: ProxySettings): Promise<number>;
  getStorageSettings(): Promise<StorageSettings>;
  saveStorageSettings(settings: StorageSettings): Promise<StorageSettings>;
  getCacheUsage(): Promise<CacheUsage>;
  clearMediaCache(input: CacheCleanupInput): Promise<CacheCleanupResult>;
  getCurrentUserProfile(): Promise<ChatProfile>;
  updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<ChatProfile>;
  setCurrentUserAvatar(file?: File): Promise<ChatProfile | undefined>;
  getChatProfile(chatId: string): Promise<ChatProfile>;
  getChatProfileMembers(chatId: string, offset: number, limit?: number): Promise<ChatProfileMembersPage>;
  getUserProfile(userId: string): Promise<ChatProfile>;
  getContacts(): Promise<User[]>;
  createPrivateChat(userId: string): Promise<Chat>;
  createChat(input: CreateChatInput): Promise<Chat>;
  getChatManagement(chatId: string, memberOffset?: number): Promise<ChatManagement>;
  addChatMembers(chatId: string, userIds: string[]): Promise<void>;
  setChatMemberStatus(input: { chatId: string; userId: string; status: ChatMemberStatusInput }): Promise<void>;
  setChatMemberTag(chatId: string, userId: string, tag: string): Promise<void>;
  setChatPermissions(chatId: string, permissions: ChatPermissions): Promise<void>;
  setChatSlowModeDelay(chatId: string, delaySeconds: number): Promise<void>;
  transferChatOwnership(chatId: string, userId: string, password: string): Promise<void>;
  getChatEventLog(input: ChatEventLogInput): Promise<ChatEventPage>;
  getChatInviteLinks(input: GetChatInviteLinksInput): Promise<ChatInviteLinkPage>;
  createChatInviteLink(input: CreateChatInviteLinkInput): Promise<ChatInviteLink>;
  editChatInviteLink(input: CreateChatInviteLinkInput & { inviteLink: string }): Promise<ChatInviteLink>;
  revokeChatInviteLink(chatId: string, inviteLink: string): Promise<ChatInviteLink>;
  getChatJoinRequests(input: GetChatJoinRequestsInput): Promise<ChatJoinRequestPage>;
  processChatJoinRequest(chatId: string, userId: string, approve: boolean): Promise<void>;
  processChatJoinRequests(chatId: string, inviteLink: string | undefined, approve: boolean): Promise<void>;
  getBotCommandSuggestions(chatId: string, query?: string, botUsername?: string): Promise<BotCommandSuggestion[]>;
  getCallbackQueryAnswer(chatId: string, messageId: string, data: string): Promise<CallbackQueryAnswer>;
  getInlineQueryResults(chatId: string, botUsername: string, query: string, offset?: string): Promise<InlineQueryResultPage>;
  sendInlineQueryResultMessage(chatId: string, botUserId: string, queryId: string, resultId: string, replyToMessageId?: string, topicId?: string): Promise<void>;
  sendBotStartMessage(chatId: string, botUserId: string, parameter?: string): Promise<void>;
  getBlockedSenders(): Promise<BlockedSender[]>;
  setMessageSenderBlocked(senderId: string, kind: "user" | "chat", blocked: boolean): Promise<void>;
  getChatReportOptions(chatId: string, messageIds: string[]): Promise<ChatReportOptions>;
  reportChat(input: ReportChatInput): Promise<void>;
  getActiveSessions(): Promise<DeviceSession[]>;
  terminateSession(sessionId: string): Promise<void>;
  terminateAllOtherSessions(): Promise<void>;
  getPrivacySettingRules(setting: PrivacySettingKey): Promise<PrivacyRule[]>;
  setPrivacySettingRules(setting: PrivacySettingKey, rules: PrivacyRule[]): Promise<void>;
  resolveTelegramLink(url: string): Promise<import("./types").TelegramLinkTarget | undefined>;
  searchChats(query: string, limit?: number): Promise<void>;
  searchGlobal(input: GlobalSearchInput): Promise<GlobalSearchPage>;
  searchChatMessages(input: ChatMessageSearchInput): Promise<ChatMessageSearchPage>;
  searchSharedMedia(input: SharedMediaSearchInput): Promise<SharedMediaPage>;
  loadMoreChats(chatListId: string, limit?: number): Promise<ChatListPage>;
  setChatPinned(chatListId: string, chatId: string, pinned: boolean): Promise<void>;
  setPinnedChats(chatListId: string, chatIds: string[]): Promise<void>;
  setChatMuted(chatId: string, muted: boolean): Promise<void>;
  setChatArchived(chatId: string, archived: boolean): Promise<void>;
  leaveChat(chatId: string): Promise<void>;
  createChatFolder(title: string, chatIds: string[]): Promise<ChatFolder>;
  renameChatFolder(folderId: string, title: string): Promise<ChatFolder>;
  deleteChatFolder(folderId: string): Promise<void>;
  setChatFolderMembership(folderId: string, chatId: string, included: boolean): Promise<void>;
  loadChatHistory(chatId: string, limit?: number): Promise<ChatHistoryPage>;
  getForumTopics(input: GetForumTopicsInput): Promise<ForumTopicPage>;
  loadForumTopicHistory(chatId: string, topicId: string, limit?: number): Promise<ChatHistoryPage>;
  createForumTopic(input: CreateForumTopicInput): Promise<ForumTopic>;
  editForumTopic(chatId: string, topicId: string, name: string): Promise<void>;
  setForumTopicClosed(chatId: string, topicId: string, closed: boolean): Promise<void>;
  setForumTopicPinned(chatId: string, topicId: string, pinned: boolean): Promise<void>;
  getMessageContext(chatId: string, messageId: string, limit?: number): Promise<Message[]>;
  getMessage(chatId: string, messageId: string): Promise<Message | undefined>;
  getMessageProperties(chatId: string, messageId: string): Promise<MessagePermissions>;
  setMessageReaction(input: SetMessageReactionInput): Promise<void>;
  setPollAnswer(input: SetPollAnswerInput): Promise<void>;
  getPinnedMessages(chatId: string): Promise<Message[]>;
  pinMessage(input: PinMessageInput): Promise<void>;
  unpinMessage(chatId: string, messageId: string): Promise<void>;
  setChatMessageAutoDeleteTime(input: SetChatMessageAutoDeleteTimeInput): Promise<void>;
  getEmojiPickerCatalog(): Promise<EmojiPickerCatalog>;
  getStickerSet(stickerSetId: string): Promise<StickerSet>;
  searchStickers(query: string, chatId: string): Promise<EmojiPickerAsset[]>;
  loadEmojiAsset(asset: EmojiPickerAsset): Promise<string | undefined>;
  sendSticker(input: SendEmojiAssetInput): Promise<void>;
  sendAnimation(input: SendEmojiAssetInput): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<void>;
  editMessage(input: EditMessageInput): Promise<void>;
  deleteMessage(input: DeleteMessageInput): Promise<void>;
  forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult>;
  setChatDraft(input: SetChatDraftInput): Promise<void>;
  setChatTyping(chatId: string, typing: boolean, topicId?: string): Promise<void>;
  cacheFile(fileId: number, priority?: number): Promise<void>;
  recoverFile(fileId: number, priority?: number): Promise<void>;
  streamFile(input: StreamFileInput): Promise<string>;
  suspendFileStream(fileId: number): Promise<void>;
  downloadFile(fileId: number, fileName: string): Promise<void>;
  cancelFileDownload(fileId: number): Promise<void>;
  openFile(sourcePath: string): Promise<void>;
  saveFileAs(sourcePath: string, fileName: string): Promise<boolean>;
  openDownloadDirectory(): Promise<void>;
  retryMessage(chatId: string, messageId: string): Promise<void>;
  sendFile(input: SendFileInput): Promise<boolean>;
  sendFiles(input: SendFilesInput): Promise<boolean>;
  cancelFileUpload(chatId: string, messageId: string): Promise<void>;
  markChatRead(chatId: string): Promise<void>;
  markForumTopicRead(chatId: string, topicId: string, messageId: string): Promise<void>;
  markMessageAttentionRead(chatId: string, messageIds: string[]): Promise<void>;
}
