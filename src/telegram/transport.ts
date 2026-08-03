import type {
  DeleteMessageInput,
  EditMessageInput,
  ForwardMessagesInput,
  ForwardMessagesResult,
  GlobalSearchInput,
  GlobalSearchPage,
  SetChatDraftInput,
  SetMessageReactionInput,
  SendFileInput,
  StreamFileInput,
  SendMessageInput,
  ChatHistoryPage,
  ChatListPage,
  CacheCleanupInput,
  CacheCleanupResult,
  CacheUsage,
  CachedTelegramSnapshot,
  Chat,
  ChatFolder,
  ChatProfile,
  TelegramEvent,
  TelegramSnapshot,
  TelegramAccount,
  TelegramAccountState,
  ProxySettings,
  StorageSettings,
  Message,
  MessagePermissions,
  User,
} from "./types";
import type { AuthorizationAction } from "./types";

export type TelegramEventListener = (event: TelegramEvent) => void;

export interface TelegramTransport {
  readonly kind: "mock" | "tauri";
  readonly label: string;
  connect(listener: TelegramEventListener): Promise<TelegramSnapshot>;
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
  getChatProfile(chatId: string): Promise<ChatProfile>;
  getContacts(): Promise<User[]>;
  createPrivateChat(userId: string): Promise<Chat>;
  searchChats(query: string, limit?: number): Promise<void>;
  searchGlobal(input: GlobalSearchInput): Promise<GlobalSearchPage>;
  searchChatMessages(chatId: string, query: string, limit?: number): Promise<number>;
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
  getMessageContext(chatId: string, messageId: string, limit?: number): Promise<Message[]>;
  getMessage(chatId: string, messageId: string): Promise<Message | undefined>;
  getRawMessage(chatId: string, messageId: string): Promise<string | undefined>;
  getMessageProperties(chatId: string, messageId: string): Promise<MessagePermissions>;
  setMessageReaction(input: SetMessageReactionInput): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<void>;
  editMessage(input: EditMessageInput): Promise<void>;
  deleteMessage(input: DeleteMessageInput): Promise<void>;
  forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult>;
  setChatDraft(input: SetChatDraftInput): Promise<void>;
  cacheFile(fileId: number, priority?: number): Promise<void>;
  streamFile(input: StreamFileInput): Promise<string>;
  suspendFileStream(fileId: number): Promise<void>;
  downloadFile(fileId: number, fileName: string): Promise<void>;
  cancelFileDownload(fileId: number): Promise<void>;
  openFile(sourcePath: string): Promise<void>;
  saveFileAs(sourcePath: string, fileName: string): Promise<boolean>;
  openDownloadDirectory(): Promise<void>;
  retryMessage(chatId: string, messageId: string): Promise<void>;
  sendFile(input: SendFileInput): Promise<boolean>;
  cancelFileUpload(chatId: string, messageId: string): Promise<void>;
  markChatRead(chatId: string): Promise<void>;
}
