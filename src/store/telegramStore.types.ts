import type { TelegramTransport } from "../telegram/transport";
import type { CacheHealth } from "./telegramStore.cache";
import type { GlobalSearchState } from "./globalSearchState";
import type { ProfileState } from "./profileState";
import type {
  AuthorizationAction,
  AuthorizationState,
  Chat,
  ChatDraft,
  ChatFolder,
  CacheCategory,
  CacheCleanupResult,
  CacheUsage,
  ConnectionStatus,
  ForwardMessagesResult,
  GlobalSearchFilter,
  Message,
  MessagePermissions,
  ProxySettings,
  QueuedOutgoingMessage,
  StorageSettings,
  TelegramAccount,
  User,
} from "../telegram/types";

export type ChatFilter = string;
export type RuntimePhase = "idle" | "loading" | "ready" | "error";

export interface HistoryState {
  loading: boolean;
  hasMore: boolean;
}

export interface ChatListState {
  loading: boolean;
  hasMore: boolean;
}

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
  folders: ChatFolder[];
  chats: Map<string, Chat>;
  chatListReady: boolean;
  chatLists: Map<string, ChatListState>;
  messages: Map<string, Message[]>;
  drafts: Map<string, ChatDraft>;
  outbox: QueuedOutgoingMessage[];
  histories: Map<string, HistoryState>;
  activeChatId?: string;
  searchQuery: string;
  chatFilter: ChatFilter;
  globalSearch: GlobalSearchState;
  profile: ProfileState;
  contacts: User[];
  contactsLoading: boolean;
  contactsError?: string;
  contactPendingUserId?: string;
  chatManagementPending: Set<string>;
  folderManagementPending: boolean;
  initialize: () => Promise<void>;
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
  selectChat: (chatId: string) => Promise<void>;
  loadMoreChats: (chatListId?: string) => Promise<void>;
  setChatPinned: (chatListId: string, chatId: string, pinned: boolean) => Promise<boolean>;
  reorderPinnedChats: (chatListId: string, chatIds: string[]) => Promise<boolean>;
  setChatMuted: (chatId: string, muted: boolean) => Promise<boolean>;
  setChatArchived: (chatId: string, archived: boolean) => Promise<boolean>;
  leaveGroup: (chatId: string) => Promise<boolean>;
  createChatFolder: (title: string, chatIds: string[]) => Promise<string | undefined>;
  renameChatFolder: (folderId: string, title: string) => Promise<boolean>;
  deleteChatFolder: (folderId: string) => Promise<boolean>;
  setChatFolderMembership: (
    folderId: string,
    chatId: string,
    included: boolean,
  ) => Promise<boolean>;
  markChatFolderRead: (folderId: string) => Promise<boolean>;
  loadMoreHistory: (chatId: string) => Promise<void>;
  loadMessage: (chatId: string, messageId: string) => Promise<boolean>;
  markActiveChatRead: () => Promise<void>;
  loadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  loadRawMessage: (chatId: string, messageId: string) => Promise<string | undefined>;
  searchChatMessages: (query: string) => Promise<void>;
  searchGlobal: (query: string, filter?: GlobalSearchFilter) => Promise<void>;
  loadMoreGlobalSearch: () => Promise<void>;
  cancelGlobalSearch: () => void;
  clearGlobalSearch: () => void;
  loadCurrentUserProfile: () => Promise<void>;
  loadChatProfile: (chatId: string) => Promise<void>;
  clearProfile: () => void;
  loadContacts: () => Promise<void>;
  startPrivateChat: (userId: string) => Promise<string | undefined>;
  setMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: ChatFilter) => void;
  sendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  editMessage: (messageId: string, text: string) => Promise<boolean>;
  deleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  updateChatDraft: (chatId: string, text: string, replyToMessageId?: string) => void;
  forwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  cacheFile: (fileId: number, priority?: number) => Promise<void>;
  streamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  suspendFileStream: (fileId: number) => Promise<void>;
  downloadFile: (fileId: number, fileName: string) => Promise<void>;
  cancelFileDownload: (fileId: number) => Promise<void>;
  openFile: (sourcePath: string) => Promise<void>;
  saveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  openDownloadDirectory: () => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  sendFile: (file?: File) => Promise<boolean>;
  cancelFileUpload: (messageId: string) => Promise<void>;
  clearError: () => void;
  clearOperationError: () => void;
}
