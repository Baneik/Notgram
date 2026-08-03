import { mockSnapshot } from "./mockData";
import { messageContentText } from "./messageContent";
import { messageSearchMatches, parseMessageSearchQuery } from "./messageSearch";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  CacheCleanupInput,
  CacheUsage,
  CachedTelegramSnapshot,
  Chat,
  ChatProfile,
  ConnectionStatus,
  DeleteMessageInput,
  EditMessageInput,
  ForwardMessagesInput,
  ForwardMessagesResult,
  GlobalSearchInput,
  GlobalSearchPage,
  Message,
  MessagePermissions,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
  SetChatDraftInput,
  SetMessageReactionInput,
  StorageSettings,
  TelegramAccount,
  TelegramAccountState,
  TelegramSnapshot,
  ChatHistoryPage,
  User,
} from "./types";

const clone = <T,>(value: T): T => structuredClone(value);
const CACHE_KEY = "notgram:ui-cache:v1";
const ACCOUNT_STATE_KEY = "notgram:accounts:v1";
const PINNED_ORDER_KEY = "notgram:mock-pinned-order:v1";

const defaultMockAccount = (): TelegramAccount => {
  const user = mockSnapshot.users.find((item) => item.id === mockSnapshot.currentUserId);
  return {
    id: "default",
    userId: mockSnapshot.currentUserId,
    displayName: user?.displayName ?? "Telegram 账号",
    avatar: clone(user?.avatar ?? { label: "N", color: "#3390ec" }),
  };
};

const browserStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const readableFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const previewDataUrl = async (file: File) => {
  if (!file.type.startsWith("image/") || file.size > 256 * 1024) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
};

export class MockTelegramTransport implements TelegramTransport {
  readonly kind = "mock" as const;
  readonly label = "演示数据";

  private listener?: TelegramEventListener;
  private snapshot = clone(mockSnapshot);
  private cachedSnapshot?: CachedTelegramSnapshot;
  private accountState: TelegramAccountState;
  private historyOffsets = new Map<string, number>();
  private drafts = new Map((mockSnapshot.drafts ?? []).map((draft) => [draft.chatId, draft]));
  private authFlow: boolean;
  private connectionStatus: ConnectionStatus;
  private storageSettings: StorageSettings = {
    cachePath: "Windows 应用缓存\\Notgram\\tdlib",
    downloadPath: "Notgram\\downloads",
    defaultCachePath: "Windows 应用缓存\\Notgram\\tdlib",
    defaultDownloadPath: "Notgram\\downloads",
  };
  private cacheUsage: CacheUsage = {
    total: { bytes: 48_758_784, files: 18 },
    images: { bytes: 6_291_456, files: 9 },
    videos: { bytes: 31_457_280, files: 2 },
    audio: { bytes: 5_242_880, files: 3 },
    documents: { bytes: 4_718_592, files: 3 },
    other: { bytes: 1_048_576, files: 1 },
  };
  private proxySettings: ProxySettings = {
    mode: "system",
    custom: {
      type: "http",
      server: "127.0.0.1",
      port: 7890,
      username: "",
      password: "",
      secret: "",
      httpOnly: false,
    },
    system: {
      type: "http",
      server: "127.0.0.1",
      port: 7897,
      username: "",
      password: "",
      secret: "",
      httpOnly: false,
    },
  };

  private folderTitle(title: string) {
    const normalized = title.trim();
    if ([...normalized].length < 1 || [...normalized].length > 12 || /[\r\n]/.test(normalized)) {
      throw new Error("文件夹名称需要包含 1 至 12 个字符");
    }
    return normalized;
  }

  private requireCustomFolder(folderId: string) {
    const folder = this.snapshot.folders.find((item) => item.id === folderId);
    if (!folder || folderId === "main" || folderId === "archive") {
      throw new Error("找不到自定义文件夹");
    }
    return folder;
  }

  private publishFolders() {
    this.listener?.({ type: "folders.replaced", folders: clone(this.snapshot.folders) });
  }

  constructor(options: {
    authFlow?: boolean;
    cachedSnapshot?: CachedTelegramSnapshot;
    connectionStatus?: ConnectionStatus;
  } = {}) {
    const serializedAccounts = browserStorage()?.getItem(ACCOUNT_STATE_KEY);
    let storedAccounts: TelegramAccountState | undefined;
    if (serializedAccounts) {
      try {
        storedAccounts = JSON.parse(serializedAccounts) as TelegramAccountState;
      } catch {
        storedAccounts = undefined;
      }
    }
    this.accountState = storedAccounts ?? {
      activeAccountId: "default",
      accounts: [defaultMockAccount()],
    };
    const activeAccountExists = this.accountState.accounts.some(
      (account) => account.id === this.accountState.activeAccountId,
    );
    this.authFlow = options.authFlow ?? !activeAccountExists;
    this.connectionStatus = options.connectionStatus ?? "online";
    this.cachedSnapshot = options.cachedSnapshot
      ? clone(options.cachedSnapshot)
      : undefined;
    if (this.authFlow) {
      this.snapshot.authorization = { kind: "waitPhoneNumber" };
    }
    this.restorePinnedOrders();
  }

  async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.listener = listener;
    this.listener({ type: "connection.changed", status: this.connectionStatus });
    return clone({ ...this.snapshot, messages: [], drafts: [...this.drafts.values()] });
  }

  async disconnect() {
    this.setConnectionStatus("offline");
    this.listener = undefined;
  }

  setConnectionStatus(status: ConnectionStatus) {
    this.connectionStatus = status;
    this.listener?.({ type: "connection.changed", status });
  }

  async loadCachedSnapshot() {
    if (this.cachedSnapshot) return clone(this.cachedSnapshot);
    const serialized = browserStorage()?.getItem(this.cacheKey());
    if (!serialized) return undefined;
    try {
      return JSON.parse(serialized) as CachedTelegramSnapshot;
    } catch {
      return undefined;
    }
  }

  async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    this.cachedSnapshot = clone(snapshot);
    browserStorage()?.setItem(this.cacheKey(), JSON.stringify(snapshot));
  }

  async clearCachedSnapshot() {
    this.cachedSnapshot = undefined;
    browserStorage()?.removeItem(this.cacheKey());
  }

  async getAccountState() {
    return clone(this.accountState);
  }

  async registerCurrentAccount(account: Omit<TelegramAccount, "id">) {
    const registered = { ...clone(account), id: this.accountState.activeAccountId };
    const index = this.accountState.accounts.findIndex((item) => item.id === registered.id);
    if (index >= 0) this.accountState.accounts[index] = registered;
    else this.accountState.accounts.push(registered);
    this.persistAccountState();
    return clone(this.accountState);
  }

  async selectAccount(accountId: string) {
    this.accountState.activeAccountId = accountId;
    this.persistAccountState();
    return clone(this.accountState);
  }

  async removeAccount(accountId: string) {
    this.accountState.accounts = this.accountState.accounts.filter(
      (account) => account.id !== accountId,
    );
    if (this.accountState.activeAccountId === accountId) {
      this.accountState.activeAccountId = this.accountState.accounts[0]?.id ?? "default";
    }
    browserStorage()?.removeItem(accountId === "default" ? CACHE_KEY : `${CACHE_KEY}:${accountId}`);
    browserStorage()?.removeItem(
      accountId === "default" ? PINNED_ORDER_KEY : `${PINNED_ORDER_KEY}:${accountId}`,
    );
    this.persistAccountState();
    return clone(this.accountState);
  }

  async logOut() {
    this.snapshot.authorization = { kind: "loggingOut" };
    this.listener?.({ type: "authorization.changed", state: { kind: "loggingOut" } });
    this.snapshot.authorization = { kind: "closed" };
    this.listener?.({ type: "authorization.changed", state: { kind: "closed" } });
    this.setConnectionStatus("offline");
  }

  async authenticate(action: AuthorizationAction) {
    if (!this.authFlow) return;
    const next =
      action.kind === "qr"
        ? { kind: "waitOtherDeviceConfirmation" as const, link: "tg://login?token=notgram-demo" }
        : action.kind === "phone"
        ? { kind: "waitCode" as const, phoneNumber: action.phoneNumber, codeLength: 5 }
        : action.kind === "code"
          ? { kind: "waitPassword" as const, hint: "mock password" }
          : action.kind === "password"
            ? { kind: "ready" as const }
            : action.kind === "emailAddress"
              ? { kind: "waitEmailCode" as const, emailPattern: "m•••@example.com", codeLength: 6 }
              : action.kind === "emailCode" || action.kind === "registration"
                ? { kind: "ready" as const }
                : { kind: "waitPhoneNumber" as const };
    this.snapshot.authorization = next;
    this.listener?.({ type: "authorization.changed", state: next });
    if (next.kind === "ready") this.publishReadySnapshot();
  }

  async loadMoreChats() {
    return { loadedCount: 0, hasMore: false };
  }

  async setPinnedChats(chatListId: string, chatIds: string[]) {
    const rankBase = BigInt(chatIds.length);
    for (const [index, chatId] of chatIds.entries()) {
      const chat = this.snapshot.chats.find((item) => item.id === chatId);
      if (!chat) continue;
      chat.listOrderByFolder = {
        ...chat.listOrderByFolder,
        [chatListId]: String(rankBase - BigInt(index)),
      };
      this.listener?.({ type: "chat.upsert", chat: clone(chat) });
    }
    const stored = this.loadPinnedOrders();
    stored[chatListId] = [...chatIds];
    browserStorage()?.setItem(this.pinnedOrderKey(), JSON.stringify(stored));
  }

  async setChatPinned(chatListId: string, chatId: string, pinned: boolean) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat || !chat.folderIds.includes(chatListId)) {
      throw new Error("找不到当前列表中的会话");
    }
    const pinnedFolderIds = new Set(chat.pinnedFolderIds ?? []);
    const listOrderByFolder = { ...chat.listOrderByFolder };
    if (pinned) {
      pinnedFolderIds.add(chatListId);
      const currentOrders = this.snapshot.chats.flatMap((item) => {
        const order = item.listOrderByFolder?.[chatListId];
        return order ? [BigInt(order)] : [];
      });
      listOrderByFolder[chatListId] = String(
        currentOrders.reduce((highest, order) => order > highest ? order : highest, 0n) + 1n,
      );
    } else {
      pinnedFolderIds.delete(chatListId);
      delete listOrderByFolder[chatListId];
    }
    chat.pinnedFolderIds = [...pinnedFolderIds];
    chat.listOrderByFolder = listOrderByFolder;
    chat.pinned = pinnedFolderIds.size > 0;
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  async setChatMuted(chatId: string, muted: boolean) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error("找不到会话");
    chat.muted = muted;
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  async setChatArchived(chatId: string, archived: boolean) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error("找不到会话");
    const target = archived ? "archive" : "main";
    chat.folderIds = [
      ...chat.folderIds.filter((folderId) => folderId !== "main" && folderId !== "archive"),
      target,
    ];
    chat.pinnedFolderIds = chat.pinnedFolderIds?.filter(
      (folderId) => folderId !== "main" && folderId !== "archive",
    );
    const listOrderByFolder = { ...chat.listOrderByFolder };
    delete listOrderByFolder.main;
    delete listOrderByFolder.archive;
    chat.listOrderByFolder = listOrderByFolder;
    chat.pinned = (chat.pinnedFolderIds?.length ?? 0) > 0;
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  async createChatFolder(title: string, chatIds: string[]) {
    const normalized = this.folderTitle(title);
    const nextId = Math.max(0, ...this.snapshot.folders.flatMap((folder) => {
      const id = /^folder:(\d+)$/.exec(folder.id)?.[1];
      return id ? [Number(id)] : [];
    })) + 1;
    const folder = { id: `folder:${nextId}`, title: normalized, iconName: "Custom" };
    this.snapshot.folders.splice(this.snapshot.folders.length - 1, 0, folder);
    for (const chatId of new Set(chatIds)) {
      const chat = this.snapshot.chats.find((item) => item.id === chatId);
      if (!chat) continue;
      if (!chat.folderIds.includes(folder.id)) chat.folderIds.push(folder.id);
      this.listener?.({ type: "chat.upsert", chat: clone(chat) });
    }
    this.publishFolders();
    return clone(folder);
  }

  async renameChatFolder(folderId: string, title: string) {
    const folder = this.requireCustomFolder(folderId);
    folder.title = this.folderTitle(title);
    this.publishFolders();
    return clone(folder);
  }

  async deleteChatFolder(folderId: string) {
    this.requireCustomFolder(folderId);
    this.snapshot.folders = this.snapshot.folders.filter((folder) => folder.id !== folderId);
    for (const chat of this.snapshot.chats) {
      if (!chat.folderIds.includes(folderId)) continue;
      chat.folderIds = chat.folderIds.filter((id) => id !== folderId);
      chat.pinnedFolderIds = chat.pinnedFolderIds?.filter((id) => id !== folderId);
      if (chat.listOrderByFolder) delete chat.listOrderByFolder[folderId];
      chat.pinned = (chat.pinnedFolderIds?.length ?? 0) > 0;
      this.listener?.({ type: "chat.upsert", chat: clone(chat) });
    }
    this.publishFolders();
  }

  async setChatFolderMembership(folderId: string, chatId: string, included: boolean) {
    this.requireCustomFolder(folderId);
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error("找不到会话");
    const folders = new Set(chat.folderIds);
    if (included) folders.add(folderId);
    else folders.delete(folderId);
    chat.folderIds = [...folders];
    if (!included) {
      chat.pinnedFolderIds = chat.pinnedFolderIds?.filter((id) => id !== folderId);
      if (chat.listOrderByFolder) delete chat.listOrderByFolder[folderId];
      chat.pinned = (chat.pinnedFolderIds?.length ?? 0) > 0;
    }
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  async getCurrentUserProfile(): Promise<ChatProfile> {
    const user = this.snapshot.users.find((item) => item.id === this.snapshot.currentUserId);
    if (!user) throw new Error("找不到当前账号资料");
    return {
      id: `user:${user.id}`,
      kind: "self",
      userId: user.id,
      title: user.displayName,
      avatar: clone(user.avatar),
      statusLabel: "在线",
      bio: "Notgram 演示账号",
      members: [],
      canViewMembers: false,
      groupInCommonCount: 0,
    };
  }

  async getChatProfile(chatId: string): Promise<ChatProfile> {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error("找不到聊天资料");
    if (chat.kind === "direct" || chat.kind === "saved") {
      const userId = chat.kind === "saved" ? this.snapshot.currentUserId : chat.peerId;
      const user = this.snapshot.users.find((item) => item.id === userId);
      if (!user) throw new Error("找不到用户资料");
      return {
        id: `user:${user.id}`,
        kind: chat.kind === "saved" ? "self" : "user",
        chatId: chat.id,
        userId: user.id,
        title: user.displayName,
        avatar: clone(user.avatar),
        statusLabel: user.presence === "online" ? "在线" : user.lastSeenLabel ?? "离线",
        bio: user.id === "u-mia" ? "产品设计师，关注桌面端体验。" : undefined,
        members: [],
        canViewMembers: false,
        groupInCommonCount: user.id === this.snapshot.currentUserId ? 0 : 2,
      };
    }
    const members = chat.kind === "channel"
      ? []
      : this.snapshot.users.slice(0, 4).map((user, index) => ({
          user: clone(user),
          role: index === 0 ? "owner" as const : index === 1
            ? "administrator" as const
            : "member" as const,
        }));
    return {
      id: `chat:${chat.id}`,
      kind: chat.kind,
      chatId: chat.id,
      title: chat.title,
      avatar: clone(chat.avatar),
      statusLabel: chat.kind === "channel" ? "1,248 位订阅者" : `${members.length} 位成员`,
      bio: chat.kind === "channel" ? "桌面版本更新与发布说明。" : "产品、设计与开发协作群。",
      memberCount: chat.kind === "channel" ? 1_248 : members.length,
      members,
      canViewMembers: chat.kind !== "channel",
    };
  }

  async getContacts(): Promise<User[]> {
    return clone(this.snapshot.users.filter((user) => user.id !== this.snapshot.currentUserId));
  }

  async createPrivateChat(userId: string): Promise<Chat> {
    const existing = this.snapshot.chats.find((chat) => chat.peerId === userId);
    if (existing) return clone(existing);
    const user = this.snapshot.users.find((item) => item.id === userId);
    if (!user) throw new Error("找不到联系人");
    const chat: Chat = {
      id: `chat-contact-${user.id}`,
      kind: "direct",
      folderIds: ["main"],
      title: user.displayName,
      avatar: clone(user.avatar),
      peerId: user.id,
      preview: "暂无消息",
      updatedAt: new Date(0).toISOString(),
      unreadCount: 0,
      pinned: false,
      muted: false,
    };
    this.snapshot.chats.push(chat);
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
    return clone(chat);
  }

  async searchChats(query: string, limit = 50) {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return;
    for (const chat of this.snapshot.chats
      .filter((item) => `${item.title} ${item.preview}`.toLocaleLowerCase().includes(normalized))
      .slice(0, limit)) {
      this.listener?.({ type: "chat.upsert", chat: clone(chat) });
    }
  }

  async searchGlobal({ query, filter, offset = "", limit = 30 }: GlobalSearchInput): Promise<GlobalSearchPage> {
    const pattern = parseMessageSearchQuery(query);
    if (!pattern.query) return { chats: [], messages: [], totalCount: 0 };
    const typeMatches = (message: Message) => {
      const content = message.content;
      if (filter === "all") return true;
      if (filter === "message") return ["text", "rich", "service"].includes(content.kind);
      if (filter === "media") {
        return content.kind === "media" &&
          ["photo", "video", "videoNote", "animation", "sticker"].includes(content.mediaType);
      }
      if (filter === "file") return content.kind === "file";
      if (content.kind !== "text") return false;
      return content.entities?.some((entity) => entity.kind === "textUrl" || entity.kind === "url") ||
        /https?:\/\//i.test(content.text);
    };
    const matches = this.snapshot.messages
      .filter((message) => {
        const content = message.content;
        const fileName = content.kind === "file" || content.kind === "media"
          ? content.fileName
          : "";
        const searchable = [messageContentText(content), fileName]
          .filter(Boolean)
          .join(" ");
        return typeMatches(message) && messageSearchMatches(searchable, pattern);
      })
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const start = Math.max(0, Number.parseInt(offset, 10) || 0);
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const messages = matches.slice(start, start + boundedLimit);
    const next = start + messages.length;
    const chatIds = new Set(messages.map((message) => message.chatId));
    if (!offset && pattern.kind === "text") {
      for (const chat of this.snapshot.chats) {
        if (messageSearchMatches(`${chat.title} ${chat.preview}`, pattern)) chatIds.add(chat.id);
      }
    }
    return {
      chats: clone(this.snapshot.chats.filter((chat) => chatIds.has(chat.id))),
      messages: clone(messages),
      totalCount: matches.length,
      nextOffset: next < matches.length ? String(next) : undefined,
    };
  }

  async searchChatMessages(chatId: string, query: string, limit = 100) {
    const pattern = parseMessageSearchQuery(query);
    if (!pattern.query) return 0;
    const matches = this.snapshot.messages.filter((message) => {
      if (message.chatId !== chatId) return false;
      return messageSearchMatches(messageContentText(message.content), pattern);
    }).slice(0, limit);
    for (const message of matches) {
      this.listener?.({ type: "message.upsert", message: clone(message) });
    }
    return matches.length;
  }

  async loadChatHistory(chatId: string, limit = 30): Promise<ChatHistoryPage> {
    const history = this.snapshot.messages
      .filter((message) => message.chatId === chatId)
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const offset = this.historyOffsets.get(chatId) ?? 0;
    const page = history.slice(offset, offset + limit);
    this.historyOffsets.set(chatId, offset + page.length);
    this.listener?.({ type: "messages.upserted", messages: clone(page) });
    return {
      loadedCount: page.length,
      hasMore: offset + page.length < history.length,
      messageIds: page.map((message) => message.id),
    };
  }

  async getMessageContext(chatId: string, messageId: string, limit = 31) {
    const history = this.snapshot.messages
      .filter((message) => message.chatId === chatId)
      .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
    const targetIndex = history.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const start = Math.max(0, targetIndex - Math.floor((boundedLimit - 1) / 2));
    const context = history.slice(start, start + boundedLimit);
    this.listener?.({ type: "messages.upserted", messages: clone(context) });
    return clone(context);
  }

  async getMessage(chatId: string, messageId: string) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    return message ? clone(message) : undefined;
  }

  async getMessageProperties(chatId: string, messageId: string): Promise<MessagePermissions> {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    if (!message) throw new Error("找不到消息");
    return clone(message.permissions ?? {
      canReply: true,
      canEdit: message.outgoing && message.content.kind === "text",
      canDeleteOnlyForSelf: !message.outgoing,
      canDeleteForAllUsers: message.outgoing,
      canForward: true,
    });
  }

  async setMessageReaction(input: SetMessageReactionInput) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === input.chatId && item.id === input.messageId,
    );
    if (!message) throw new Error("消息不存在");
    const interaction = message.interaction ?? {
      viewCount: 0,
      forwardCount: 0,
      replyCount: 0,
      reactions: [],
    };
    const reactions = [...interaction.reactions];
    const index = reactions.findIndex(
      (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === input.emoji,
    );
    if (index >= 0) {
      const current = reactions[index];
      const totalCount = Math.max(0, current.totalCount + (input.chosen ? 1 : -1));
      if (totalCount === 0) reactions.splice(index, 1);
      else reactions[index] = { ...current, chosen: input.chosen, totalCount };
    } else if (input.chosen) {
      reactions.push({
        type: { kind: "emoji", emoji: input.emoji },
        totalCount: 1,
        chosen: true,
        recentSenderIds: [this.snapshot.currentUserId],
      });
    }
    message.interaction = { ...interaction, reactions };
    this.listener?.({ type: "message.upsert", message: clone(message) });
  }

  async getProxySettings() {
    return structuredClone(this.proxySettings);
  }

  async saveProxySettings(settings: ProxySettings) {
    this.proxySettings = structuredClone(settings);
  }

  async testProxy(_settings: ProxySettings) {
    return 42;
  }

  async getStorageSettings() {
    return structuredClone(this.storageSettings);
  }

  async saveStorageSettings(settings: StorageSettings) {
    this.storageSettings = structuredClone(settings);
    return structuredClone(this.storageSettings);
  }

  async getCacheUsage() {
    return clone(this.cacheUsage);
  }

  async clearMediaCache(input: CacheCleanupInput) {
    const keyByCategory = {
      image: "images",
      video: "videos",
      audio: "audio",
      document: "documents",
      other: "other",
    } as const;
    let removedBytes = 0;
    let removedFiles = 0;
    for (const category of input.categories) {
      const key = keyByCategory[category];
      removedBytes += this.cacheUsage[key].bytes;
      removedFiles += this.cacheUsage[key].files;
      this.cacheUsage[key] = { bytes: 0, files: 0 };
    }
    this.cacheUsage.total = {
      bytes: Math.max(0, this.cacheUsage.total.bytes - removedBytes),
      files: Math.max(0, this.cacheUsage.total.files - removedFiles),
    };
    return {
      removedBytes,
      removedFiles,
      skippedProtectedFiles: input.protectedPaths.length > 0 ? 1 : 0,
      usage: clone(this.cacheUsage),
    };
  }

  async sendMessage({ chatId, text, replyToMessageId, clearDraft = true }: SendMessageInput) {
    const replyTarget = replyToMessageId
      ? this.snapshot.messages.find(
          (message) => message.chatId === chatId && message.id === replyToMessageId,
        )
      : undefined;
    if (replyToMessageId && !replyTarget) throw new Error("找不到需要回复的消息");
    this.appendMessage({
      id: crypto.randomUUID(),
      chatId,
      senderId: this.snapshot.currentUserId,
      outgoing: true,
      sentAt: new Date().toISOString(),
      delivery: "sent",
      replyTo: replyTarget
        ? {
            kind: "message",
            chatId,
            messageId: replyTarget.id,
            content: clone(replyTarget.content),
          }
        : undefined,
      content: { kind: "text", text },
    });
    if (clearDraft) await this.setChatDraft({ chatId, text: "" });
  }

  async editMessage({ chatId, messageId, text }: EditMessageInput) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    if (!message) throw new Error("找不到需要编辑的消息");
    if (message.content.kind !== "text") throw new Error("只能编辑文本消息");
    message.content = { kind: "text", text };
    message.editedAt = new Date().toISOString();
    delete message.permissions;
    this.listener?.({ type: "message.upsert", message: clone(message) });
    this.refreshChatPreview(chatId);
  }

  async deleteMessage({ chatId, messageId }: DeleteMessageInput) {
    const index = this.snapshot.messages.findIndex(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    if (index < 0) throw new Error("找不到需要删除的消息");
    this.snapshot.messages.splice(index, 1);
    this.listener?.({ type: "message.remove", chatId, messageId });
    this.refreshChatPreview(chatId);
  }

  async forwardMessages({ fromChatId, toChatId, messageIds }: ForwardMessagesInput): Promise<ForwardMessagesResult> {
    const uniqueMessageIds = [...new Set(messageIds)];
    const selected = uniqueMessageIds
      .map((messageId) => this.snapshot.messages.find(
        (message) => message.chatId === fromChatId && message.id === messageId,
      ))
      .filter((message): message is Message => Boolean(message));
    if (selected.length === 0) throw new Error("请选择要转发的消息");
    if (selected.length > 100) throw new Error("单次最多转发 100 条消息");
    if (selected.length !== uniqueMessageIds.length) throw new Error("部分待转发消息已不存在");
    if (!this.snapshot.chats.some((chat) => chat.id === toChatId)) {
      throw new Error("找不到转发目标会话");
    }

    const now = Date.now();
    for (const [index, source] of selected.entries()) {
      this.appendMessage({
        ...clone(source),
        id: crypto.randomUUID(),
        chatId: toChatId,
        senderId: this.snapshot.currentUserId,
        outgoing: true,
        sentAt: new Date(now + index).toISOString(),
        delivery: "sent",
        editedAt: undefined,
        replyTo: undefined,
        permissions: undefined,
        forwardInfo: source.forwardInfo ? clone(source.forwardInfo) : {
          origin: { kind: "user", userId: source.senderId },
          sentAt: source.sentAt,
          source: {
            chatId: fromChatId,
            messageId: source.id,
            senderId: source.senderId,
            outgoing: source.outgoing,
          },
        },
        interaction: undefined,
        canRetry: undefined,
      });
    }
    return { forwardedCount: selected.length, failedMessageIds: [] };
  }

  async setChatDraft({ chatId, text, replyToMessageId }: SetChatDraftInput) {
    if (!this.snapshot.chats.some((chat) => chat.id === chatId)) {
      throw new Error("找不到需要保存草稿的会话");
    }
    const draft = text.length > 0 || replyToMessageId
      ? {
          chatId,
          text,
          replyToMessageId,
          updatedAt: new Date().toISOString(),
        }
      : undefined;
    if (draft) this.drafts.set(chatId, draft);
    else this.drafts.delete(chatId);
    this.listener?.({ type: "chat.draftChanged", chatId, draft: clone(draft) });
  }

  async downloadFile(fileId: number, _fileName: string) {
    this.updateFileTransfer(fileId, {
      isDownloading: true,
      isDownloaded: false,
      canDownload: true,
      progress: 0,
    });
  }

  async cancelFileDownload(fileId: number) {
    this.updateFileTransfer(fileId, {
      isDownloading: false,
      isDownloaded: false,
      canDownload: true,
      progress: undefined,
    });
  }

  async openFile(_sourcePath: string) {
    return;
  }

  async saveFileAs(_sourcePath: string, _fileName: string) {
    return true;
  }

  async openDownloadDirectory() {
    return;
  }

  async cacheFile(_fileId: number, _priority?: number) {
    return;
  }

  async streamFile() {
    return "/mock-video.mp4";
  }

  async suspendFileStream() {
    return;
  }

  async retryMessage(chatId: string, messageId: string) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    if (!message) throw new Error("找不到需要重试的消息");
    message.delivery = "sent";
    message.canRetry = false;
    this.listener?.({ type: "message.upsert", message: clone(message) });
  }

  async sendFile({ chatId, file }: SendFileInput) {
    if (!file) return false;
    const isPhoto = file.type.startsWith("image/");
    const preview = isPhoto ? await previewDataUrl(file) : undefined;
    this.appendMessage({
      id: crypto.randomUUID(),
      chatId,
      senderId: this.snapshot.currentUserId,
      outgoing: true,
      sentAt: new Date().toISOString(),
      delivery: "sent",
      content: isPhoto
        ? {
            kind: "media",
            mediaType: "photo",
            fileName: file.name,
            sizeLabel: readableFileSize(file.size),
            previewDataUrl: preview,
          }
        : {
            kind: "file",
            fileName: file.name,
            sizeLabel: readableFileSize(file.size),
          },
    });
    return true;
  }

  async cancelFileUpload(chatId: string, messageId: string) {
    await this.deleteMessage({ chatId, messageId, revoke: true });
  }

  async markChatRead(chatId: string) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat || chat.unreadCount === 0) return;
    chat.unreadCount = 0;
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  private appendMessage(message: Message) {
    this.snapshot.messages.push(message);
    this.listener?.({ type: "message.upsert", message: clone(message) });

    const chat = this.snapshot.chats.find((item) => item.id === message.chatId);
    if (!chat) return;

    const updatedChat: Chat = {
      ...chat,
      preview: messageContentText(message.content),
      updatedAt: message.sentAt,
      unreadCount: 0,
    };
    Object.assign(chat, updatedChat);
    this.listener?.({ type: "chat.upsert", chat: clone(updatedChat) });
  }

  private updateFileTransfer(
    fileId: number,
    patch: {
      canDownload: boolean;
      isDownloading: boolean;
      isDownloaded: boolean;
      progress?: number;
    },
  ) {
    for (const message of this.snapshot.messages) {
      const content = message.content;
      if ((content.kind !== "file" && content.kind !== "media") || content.fileId !== fileId) {
        continue;
      }
      message.content = { ...content, ...patch };
      this.listener?.({ type: "message.upsert", message: clone(message) });
    }
  }

  private refreshChatPreview(chatId: string) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat) return;
    const latest = this.snapshot.messages
      .filter((message) => message.chatId === chatId)
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt))[0];
    if (!latest) return;
    const updatedChat: Chat = {
      ...chat,
      preview: messageContentText(latest.content),
      updatedAt: latest.sentAt,
    };
    Object.assign(chat, updatedChat);
    this.listener?.({ type: "chat.upsert", chat: clone(updatedChat) });
  }

  private cacheKey() {
    return this.accountState.activeAccountId === "default"
      ? CACHE_KEY
      : `${CACHE_KEY}:${this.accountState.activeAccountId}`;
  }

  private pinnedOrderKey() {
    return this.accountState.activeAccountId === "default"
      ? PINNED_ORDER_KEY
      : `${PINNED_ORDER_KEY}:${this.accountState.activeAccountId}`;
  }

  private loadPinnedOrders(): Record<string, string[]> {
    const serialized = browserStorage()?.getItem(this.pinnedOrderKey());
    if (!serialized) return {};
    try {
      return JSON.parse(serialized) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  private restorePinnedOrders() {
    for (const [chatListId, chatIds] of Object.entries(this.loadPinnedOrders())) {
      const rankBase = BigInt(chatIds.length);
      for (const [index, chatId] of chatIds.entries()) {
        const chat = this.snapshot.chats.find((item) => item.id === chatId);
        if (!chat) continue;
        chat.listOrderByFolder = {
          ...chat.listOrderByFolder,
          [chatListId]: String(rankBase - BigInt(index)),
        };
      }
    }
  }

  private persistAccountState() {
    browserStorage()?.setItem(ACCOUNT_STATE_KEY, JSON.stringify(this.accountState));
  }

  private publishReadySnapshot() {
    for (const user of this.snapshot.users) {
      this.listener?.({ type: "user.upsert", user: clone(user) });
    }
    this.listener?.({ type: "currentUser.changed", userId: this.snapshot.currentUserId });
    this.listener?.({ type: "folders.replaced", folders: clone(this.snapshot.folders) });
    this.listener?.({ type: "chats.upserted", chats: clone(this.snapshot.chats) });
  }
}
