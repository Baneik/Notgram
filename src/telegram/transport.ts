import type {
  DeleteMessageInput,
  EditMessageInput,
  ForwardMessagesInput,
  ForwardMessagesResult,
  SetChatDraftInput,
  SetMessageReactionInput,
  SendFileInput,
  StreamFileInput,
  SendMessageInput,
  ChatHistoryPage,
  ChatListPage,
  CachedTelegramSnapshot,
  TelegramEvent,
  TelegramSnapshot,
  TelegramAccount,
  TelegramAccountState,
  ProxySettings,
  StorageSettings,
  MessagePermissions,
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
  searchChats(query: string, limit?: number): Promise<void>;
  searchChatMessages(chatId: string, query: string, limit?: number): Promise<number>;
  loadMoreChats(chatListId: string, limit?: number): Promise<ChatListPage>;
  loadChatHistory(chatId: string, limit?: number): Promise<ChatHistoryPage>;
  getMessageProperties(chatId: string, messageId: string): Promise<MessagePermissions>;
  setMessageReaction(input: SetMessageReactionInput): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<void>;
  editMessage(input: EditMessageInput): Promise<void>;
  deleteMessage(input: DeleteMessageInput): Promise<void>;
  forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult>;
  setChatDraft(input: SetChatDraftInput): Promise<void>;
  cacheFile(fileId: number, priority?: number): Promise<void>;
  streamFile(input: StreamFileInput): Promise<string>;
  downloadFile(fileId: number, fileName: string): Promise<void>;
  retryMessage(chatId: string, messageId: string): Promise<void>;
  sendFile(input: SendFileInput): Promise<boolean>;
  cancelFileUpload(chatId: string, messageId: string): Promise<void>;
  markChatRead(chatId: string): Promise<void>;
}
