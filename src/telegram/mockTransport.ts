import { mockSnapshot } from "./mockData";
import { messageContentText } from "./messageContent";
import { messageSearchMatches } from "./messageSearch";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  CacheCleanupInput,
  CacheUsage,
  CachedTelegramSnapshot,
  Chat,
  ChatEvent,
  ChatEventLogInput,
  ChatEventPage,
  ChatManagement,
  ChatInviteLink,
  ChatInviteLinkPage,
  ChatJoinRequest,
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
  ManagedChatMember,
  ChatProfile,
  ChatProfileMembersPage,
  ConnectionStatus,
  CreateChatInput,
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
  ChatMessageSearchFilter,
  ChatMessageSearchInput,
  ChatMessageSearchPage,
  Message,
  MessagePermissions,
  PinMessageInput,
  ProxySettings,
  SendEmojiAssetInput,
  SendFileInput,
  SendFilesInput,
  SendMessageInput,
  SetChatDraftInput,
  SetChatMessageAutoDeleteTimeInput,
  SetMessageReactionInput,
  SetPollAnswerInput,
  SharedMediaSearchInput,
  StorageSettings,
  StickerSet,
  TelegramAccount,
  TelegramAccountState,
  TelegramSnapshot,
  UpdateCurrentUserProfileInput,
  ChatHistoryPage,
  User,
} from "./types";
import {
  DEFAULT_CHAT_ADMIN_RIGHTS,
  DEFAULT_CHAT_PERMISSIONS,
  cloneChatAdminRights,
  cloneChatPermissions,
} from "./chatManagement";

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

const mockChatSearchFilterMatches = (message: Message, filter: ChatMessageSearchFilter) => {
  const content = message.content;
  if (filter === "all") return true;
  if (filter === "animation") return content.kind === "media" && content.mediaType === "animation";
  if (filter === "audio") return content.kind === "media" && content.mediaType === "audio";
  if (filter === "document") return content.kind === "file";
  if (filter === "photo") return content.kind === "media" && content.mediaType === "photo";
  if (filter === "poll") return content.kind === "poll";
  if (filter === "video") return content.kind === "media" && content.mediaType === "video";
  if (filter === "voiceNote") return content.kind === "media" && content.mediaType === "voice";
  if (filter === "photoAndVideo") return content.kind === "media" && ["photo", "video"].includes(content.mediaType);
  if (filter === "url") return content.kind === "text" && (
    content.entities?.some((entity) => entity.kind === "url" || entity.kind === "textUrl") ||
    /https?:\/\//i.test(content.text)
  );
  if (filter === "chatPhoto") return content.kind === "service" && /头像|照片|photo/i.test(content.text);
  if (filter === "videoNote") return content.kind === "media" && content.mediaType === "videoNote";
  if (filter === "voiceAndVideoNote") return content.kind === "media" && ["voice", "videoNote"].includes(content.mediaType);
  if (filter === "mention" || filter === "unreadMention") return Boolean(message.containsUnreadMention);
  if (filter === "unreadReaction") return Boolean(message.interaction?.reactions.some((reaction) => reaction.chosen));
  if (filter === "unreadPollVote") return content.kind === "poll" && content.options.some((option) => option.chosen);
  if (filter === "failedToSend") return message.delivery === "failed";
  return message.isPinned === true;
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

const mockEmojiPreview = (emoji: string, background: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
      <rect width="180" height="180" rx="42" fill="${background}"/>
      <text x="90" y="116" text-anchor="middle" font-size="96">${emoji}</text>
    </svg>
  `)}`;

const mockSticker = (
  fileId: number,
  emoji: string,
  background: string,
): EmojiPickerAsset => ({
  id: `mock-sticker:${fileId}`,
  kind: "sticker",
  fileId,
  emoji,
  fileName: "sticker.webp",
  mimeType: "image/webp",
  previewMimeType: "image/svg+xml",
  previewDataUrl: mockEmojiPreview(emoji, background),
  width: 180,
  height: 180,
});

const mockAnimation = (
  fileId: number,
  emoji: string,
  background: string,
): EmojiPickerAsset => ({
  id: `mock-animation:${fileId}`,
  kind: "animation",
  fileId,
  fileName: "animation.mp4",
  mimeType: "video/mp4",
  previewMimeType: "image/svg+xml",
  previewDataUrl: mockEmojiPreview(emoji, background),
  width: 320,
  height: 240,
  duration: 2,
});

const mockStickerSets: StickerSet[] = [
  {
    id: "mock-pack-work",
    title: "工作日常",
    name: "notgram_work",
    size: 6,
    covers: [mockSticker(7101, "👍", "#dff2ff")],
    stickers: [
      mockSticker(7101, "👍", "#dff2ff"),
      mockSticker(7102, "🎉", "#fff0ca"),
      mockSticker(7103, "💡", "#f4e8ff"),
      mockSticker(7104, "✅", "#e3f6e8"),
      mockSticker(7105, "👀", "#ffe7e1"),
      mockSticker(7106, "🚀", "#e6ecff"),
    ],
  },
  {
    id: "mock-pack-cats",
    title: "办公室猫猫",
    name: "notgram_cats",
    size: 6,
    covers: [mockSticker(7201, "😺", "#ffe8d4")],
    stickers: [
      mockSticker(7201, "😺", "#ffe8d4"),
      mockSticker(7202, "🙀", "#e8f4ff"),
      mockSticker(7203, "😼", "#e9f7df"),
      mockSticker(7204, "😻", "#ffe4ef"),
      mockSticker(7205, "😿", "#e7e9ff"),
      mockSticker(7206, "😸", "#fff4c9"),
    ],
  },
];

const mockSavedAnimations = [
  mockAnimation(7301, "👏", "#dff4ee"),
  mockAnimation(7302, "😂", "#fff0c9"),
  mockAnimation(7303, "🔥", "#ffe0da"),
  mockAnimation(7304, "💯", "#e7e7ff"),
];

export class MockTelegramTransport implements TelegramTransport {
  readonly kind = "mock" as const;
  readonly label = "演示数据";

  private listener?: TelegramEventListener;
  private snapshot = clone(mockSnapshot);
  private mockCurrentUserBio = "Notgram 演示账号";
  private cachedSnapshot?: CachedTelegramSnapshot;
  private accountState: TelegramAccountState;
  private historyOffsets = new Map<string, number>();
  private forumTopics = new Map<string, ForumTopic[]>();
  private drafts = new Map((mockSnapshot.drafts ?? []).map((draft) => [draft.chatId, draft]));
  private createdChatSettings = new Map<string, CreateChatInput>();
  private chatManagement = new Map<string, ChatManagement>();
  private chatAudit = new Map<string, ChatEvent[]>();
  private chatInviteLinks = new Map<string, ChatInviteLink[]>();
  private chatJoinRequests = new Map<string, ChatJoinRequest[]>();
  private inlineResults = new Map<string, { botUserId: string; text: string }>();
  private blockedSenders = new Map<string, BlockedSender>();
  private sessions: DeviceSession[] = [
    { id: "session-current", isCurrent: true, isPasswordPending: false, isUnconfirmed: false, canAcceptSecretChats: true, canAcceptCalls: true, applicationName: "Notgram", applicationVersion: "0.5.0", deviceModel: "Windows Desktop", platform: "Windows", systemVersion: "11", loggedInAt: new Date(Date.now() - 86_400_000 * 30).toISOString(), lastActiveAt: new Date().toISOString(), ipAddress: "192.0.2.10", location: "Singapore, SG" },
    { id: "session-phone", isCurrent: false, isPasswordPending: false, isUnconfirmed: false, canAcceptSecretChats: true, canAcceptCalls: true, applicationName: "Telegram Android", applicationVersion: "11.2", deviceModel: "Pixel 8", platform: "Android", systemVersion: "15", loggedInAt: new Date(Date.now() - 86_400_000 * 12).toISOString(), lastActiveAt: new Date(Date.now() - 3_600_000).toISOString(), ipAddress: "198.51.100.7", location: "Shanghai, CN" },
  ];
  private privacyRules: Record<PrivacySettingKey, PrivacyRule[]> = {
    showStatus: [{ kind: "allowContacts" }], showPhoneNumber: [{ kind: "restrictAll" }], showProfilePhoto: [{ kind: "allowContacts" }], allowCalls: [{ kind: "allowContacts" }], allowChatInvites: [{ kind: "allowContacts" }], allowSecretChats: [{ kind: "allowAll" }],
  };
  private authFlow: boolean;
  private connectionStatus: ConnectionStatus;
  private initialTyping?: { chatId: string; senderId: string };
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
    initialTyping?: { chatId: string; senderId: string };
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
    this.initialTyping = options.initialTyping;
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
    if (this.initialTyping) {
      const { chatId, senderId } = this.initialTyping;
      globalThis.queueMicrotask(() => this.listener?.({
        type: "chat.typingChanged",
        chatId,
        senderId,
        typing: true,
      }));
    }
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

  async leaveChat(chatId: string) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat || chat.kind !== "group") throw new Error("只能退出群组会话");
    chat.folderIds = [];
    chat.pinnedFolderIds = [];
    chat.listOrderByFolder = {};
    chat.pinned = false;
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
      bio: this.mockCurrentUserBio,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      phoneNumber: user.phoneNumber,
      dataCenterId: 5,
      dataCenterLocation: "Singapore, SG",
      members: [],
      canViewMembers: false,
      groupInCommonCount: 0,
    };
  }

  async getUserProfile(userId: string): Promise<ChatProfile> {
    const user = this.snapshot.users.find((item) => item.id === userId);
    if (!user) throw new Error("找不到用户资料");
    return {
      id: `user:${user.id}`,
      kind: user.id === this.snapshot.currentUserId ? "self" : "user",
      userId: user.id,
      title: user.displayName,
      avatar: clone(user.avatar),
      statusLabel: user.presence === "online" ? "在线" : user.lastSeenLabel ?? "离线",
      bio: user.id === "u-mia" ? "产品设计师，关注桌面端体验。" : undefined,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      phoneNumber: user.phoneNumber,
      dataCenterId: 5,
      dataCenterLocation: "Singapore, SG",
      members: [],
      canViewMembers: false,
      groupInCommonCount: user.id === this.snapshot.currentUserId ? 0 : 2,
    };
  }

  async updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<ChatProfile> {
    const user = this.snapshot.users.find((item) => item.id === this.snapshot.currentUserId);
    if (!user) throw new Error("找不到当前账号资料");
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const username = input.username.trim();
    const bio = input.bio.trim();
    if (!firstName) throw new Error("名字不能为空");
    if (username && (!/^[A-Za-z0-9_]{5,32}$/.test(username))) {
      throw new Error("用户名需包含 5 至 32 个英文字母、数字或下划线");
    }
    user.firstName = firstName;
    user.lastName = lastName;
    user.displayName = `${firstName} ${lastName}`.trim();
    user.username = username || undefined;
    this.mockCurrentUserBio = bio;
    this.listener?.({ type: "user.upsert", user: clone(user) });
    return this.getCurrentUserProfile();
  }

  async setCurrentUserAvatar(file?: File): Promise<ChatProfile | undefined> {
    if (!file) return undefined;
    if (!/^image\/(?:jpeg|png)$/i.test(file.type)) throw new Error("请选择 JPEG 或 PNG 图片");
    const imagePath = await previewDataUrl(file);
    if (!imagePath) throw new Error("演示模式头像需小于 256 KB");
    const user = this.snapshot.users.find((item) => item.id === this.snapshot.currentUserId);
    if (!user) throw new Error("找不到当前账号资料");
    user.avatar = { ...user.avatar, imagePath };
    this.listener?.({ type: "user.upsert", user: clone(user) });
    return this.getCurrentUserProfile();
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
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        phoneNumber: user.phoneNumber,
        dataCenterId: 5,
        dataCenterLocation: "Singapore, SG",
        members: [],
        canViewMembers: false,
        groupInCommonCount: user.id === this.snapshot.currentUserId ? 0 : 2,
      };
    }
    const settings = this.createdChatSettings.get(chat.id);
    const memberUsers = settings
      ? [
          this.snapshot.users.find((user) => user.id === this.snapshot.currentUserId),
          ...settings.memberUserIds.map((id) => this.snapshot.users.find((user) => user.id === id)),
        ].filter((user): user is User => Boolean(user))
      : this.snapshot.users.slice(0, 4);
    const members = chat.kind === "channel" && !settings
      ? []
      : memberUsers.map((user, index) => ({
          user: clone(user),
          role: index === 0 ? "owner" as const : !settings && index === 1
            ? "administrator" as const
            : "member" as const,
        }));
    return {
      id: `chat:${chat.id}`,
      kind: chat.kind,
      chatId: chat.id,
      title: chat.title,
      avatar: clone(chat.avatar),
      statusLabel: settings
        ? `${members.length} 位${chat.kind === "channel" ? "订阅者" : "成员"}`
        : chat.kind === "channel" ? "1,248 位订阅者" : `${members.length} 位成员`,
      bio: settings?.description || (chat.kind === "channel" ? "桌面版本更新与发布说明。" : "产品、设计与开发协作群。"),
      username: settings?.isPublic ? settings.username : undefined,
      memberCount: settings ? members.length : chat.kind === "channel" ? 1_248 : members.length,
      members,
      canViewMembers: chat.kind !== "channel" || Boolean(settings),
      memberOffset: members.length,
      memberHasMore: false,
    };
  }

  async getChatProfileMembers(chatId: string, offset: number, limit = 50): Promise<ChatProfileMembersPage> {
    const profile = await this.getChatProfile(chatId);
    const start = Math.max(0, offset);
    const members = profile.members.slice(start, start + Math.max(1, limit));
    return {
      members,
      offset: start + members.length,
      hasMore: start + members.length < profile.members.length,
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

  async createChat(input: CreateChatInput): Promise<Chat> {
    const title = input.title.trim();
    const description = input.description?.trim() ?? "";
    const username = input.username?.trim() ?? "";
    if (!title || [...title].length > 128 || /[\r\n]/.test(title)) {
      throw new Error("群组或频道名称需包含 1 至 128 个字符");
    }
    if ([...description].length > 255) throw new Error("简介最多 255 个字符");
    if (input.isPublic && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) {
      throw new Error("公开用户名需包含 5 至 32 个英文字母、数字或下划线，并以字母开头");
    }
    const uniqueMemberIds = [...new Set(input.memberUserIds)];
    if (uniqueMemberIds.length > 200 || uniqueMemberIds.some((id) =>
      !this.snapshot.users.some((user) => user.id === id) || id === this.snapshot.currentUserId)) {
      throw new Error("初始成员列表无效");
    }
    const id = `chat-created-${crypto.randomUUID()}`;
    const chat: Chat = {
      id,
      kind: input.kind === "channel" ? "channel" : "group",
      folderIds: ["main"],
      title,
      avatar: {
        label: [...title][0] ?? "群",
        color: input.kind === "channel" ? "#397a78" : "#75579a",
      },
      preview: input.kind === "channel" ? "频道已创建" : "群组已创建",
      updatedAt: new Date().toISOString(),
      unreadCount: 0,
      pinned: false,
      muted: false,
    };
    this.createdChatSettings.set(id, {
      ...clone(input),
      title,
      description,
      username: input.isPublic ? username : undefined,
      memberUserIds: uniqueMemberIds,
    });
    this.snapshot.chats.push(chat);
    const permissions = input.permissionTemplate === "restricted"
      ? { ...cloneChatPermissions(DEFAULT_CHAT_PERMISSIONS), canSendVideos: false, canSendDocuments: false }
      : cloneChatPermissions(DEFAULT_CHAT_PERMISSIONS);
    const memberUsers = [this.snapshot.currentUserId, ...uniqueMemberIds]
      .map((id) => this.snapshot.users.find((user) => user.id === id))
      .filter((user): user is User => Boolean(user));
    this.chatManagement.set(id, {
      chatId: id,
      members: memberUsers.map((user, index): ManagedChatMember => ({
        user: clone(user),
        role: index === 0 ? "owner" : "member",
        status: index === 0 ? "owner" : "member",
        adminRights: index === 0 ? cloneChatAdminRights(DEFAULT_CHAT_ADMIN_RIGHTS) : undefined,
      })),
      permissions,
      slowModeDelay: 0,
      canManageMembers: true,
      canManagePermissions: true,
      canTransferOwnership: true,
      memberHasMore: false,
    });
    this.appendChatAudit(id, "群组已创建");
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
    return clone(chat);
  }

  private appendChatAudit(chatId: string, summary: string, kind = "setting") {
    const event: ChatEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: new Date().toISOString(),
      actor: clone(this.snapshot.users.find((user) => user.id === this.snapshot.currentUserId)),
      summary,
      kind,
    };
    const events = this.chatAudit.get(chatId) ?? [];
    events.unshift(event);
    this.chatAudit.set(chatId, events);
  }

  private async ensureChatManagement(chatId: string): Promise<ChatManagement> {
    const existing = this.chatManagement.get(chatId);
    if (existing) return existing;
    const profile = await this.getChatProfile(chatId);
    const settings = this.createdChatSettings.get(chatId);
    const permissions = settings?.permissionTemplate === "restricted"
      ? { ...cloneChatPermissions(DEFAULT_CHAT_PERMISSIONS), canSendVideos: false, canSendDocuments: false }
      : cloneChatPermissions(DEFAULT_CHAT_PERMISSIONS);
    const members: ManagedChatMember[] = profile.members.map((member, index) => ({
      ...clone(member),
      status: member.role,
      adminRights: member.role === "owner" || member.role === "administrator"
        ? cloneChatAdminRights(DEFAULT_CHAT_ADMIN_RIGHTS)
        : undefined,
    }));
    if (!members.some((member) => member.user.id === this.snapshot.currentUserId)) {
      const current = this.snapshot.users.find((user) => user.id === this.snapshot.currentUserId);
      if (current) members.unshift({ user: clone(current), role: "owner", status: "owner", adminRights: cloneChatAdminRights(DEFAULT_CHAT_ADMIN_RIGHTS) });
    }
    const value: ChatManagement = {
      chatId,
      members,
      memberCount: members.length,
      permissions,
      slowModeDelay: 0,
      canManageMembers: true,
      canManagePermissions: true,
      canTransferOwnership: true,
      memberHasMore: false,
    };
    this.chatManagement.set(chatId, value);
    return value;
  }

  async getChatManagement(chatId: string, memberOffset = 0): Promise<ChatManagement> {
    const value = await this.ensureChatManagement(chatId);
    const offset = Math.max(0, memberOffset);
    const limit = 50;
    return clone({
      ...value,
      administratorLabels: Object.fromEntries(value.members.flatMap((member) => {
        const label = member.customTitle ||
          (member.status === "owner" ? "群主" : member.status === "administrator" ? "管理员" : "");
        return label ? [[member.user.id, label]] : [];
      })),
      members: value.members.slice(offset, offset + limit),
      memberOffset: offset,
      memberHasMore: offset + limit < value.members.length,
    });
  }

  async addChatMembers(chatId: string, userIds: string[]): Promise<void> {
    const value = await this.ensureChatManagement(chatId);
    const ids = [...new Set(userIds)].filter((id) => id !== this.snapshot.currentUserId);
    for (const id of ids) {
      const user = this.snapshot.users.find((item) => item.id === id);
      if (!user) throw new Error("找不到要添加的联系人");
      if (value.members.some((member) => member.user.id === id && member.status !== "left" && member.status !== "banned")) continue;
      const member: ManagedChatMember = { user: clone(user), role: "member", status: "member" };
      const index = value.members.findIndex((item) => item.user.id === id);
      if (index >= 0) value.members[index] = member; else value.members.push(member);
      this.appendChatAudit(chatId, `添加成员：${user.displayName}`, "memberJoin");
    }
  }

  async setChatMemberStatus({ chatId, userId, status }: { chatId: string; userId: string; status: ChatMemberStatusInput }): Promise<void> {
    const value = await this.ensureChatManagement(chatId);
    const member = value.members.find((item) => item.user.id === userId);
    if (!member) throw new Error("找不到群成员");
    if (member.status === "owner") throw new Error("所有者需要使用所有权转移");
    const user = member.user;
    if (status.kind === "administrator") {
      member.status = "administrator"; member.role = "administrator";
      member.adminRights = cloneChatAdminRights(status.rights); member.customTitle = status.customTitle?.trim() || undefined;
      this.appendChatAudit(chatId, `设置管理员：${user.displayName}`, "memberPromotion");
    } else if (status.kind === "restricted") {
      member.status = "restricted"; member.role = "member"; member.permissions = cloneChatPermissions(status.permissions);
      member.untilDate = status.untilDate; member.adminRights = undefined;
      this.appendChatAudit(chatId, `限制成员：${user.displayName}`, "memberRestriction");
    } else if (status.kind === "banned") {
      member.status = "banned"; member.role = "member"; member.permissions = undefined; member.adminRights = undefined;
      member.untilDate = status.untilDate;
      this.appendChatAudit(chatId, `封禁成员：${user.displayName}`, "memberRestriction");
    } else {
      member.status = "member"; member.role = "member"; member.permissions = undefined; member.adminRights = undefined; member.untilDate = undefined;
      this.appendChatAudit(chatId, `恢复成员：${user.displayName}`, "memberJoin");
    }
  }

  async setChatPermissions(chatId: string, permissions: ChatPermissions): Promise<void> {
    const value = await this.ensureChatManagement(chatId);
    value.permissions = cloneChatPermissions(permissions);
    this.appendChatAudit(chatId, "更新群组默认发送权限");
  }

  async setChatSlowModeDelay(chatId: string, delaySeconds: number): Promise<void> {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86_400) throw new Error("慢速模式间隔无效");
    const value = await this.ensureChatManagement(chatId);
    value.slowModeDelay = delaySeconds;
    this.appendChatAudit(chatId, delaySeconds ? `设置慢速模式：${delaySeconds} 秒` : "关闭慢速模式", "setting");
  }

  async transferChatOwnership(chatId: string, userId: string, password: string): Promise<void> {
    if (!password.trim()) throw new Error("请输入两步验证密码");
    const value = await this.ensureChatManagement(chatId);
    const next = value.members.find((member) => member.user.id === userId);
    const current = value.members.find((member) => member.status === "owner");
    if (!next || !current) throw new Error("所有者候选人无效");
    current.status = "administrator"; current.role = "administrator"; current.adminRights = cloneChatAdminRights(DEFAULT_CHAT_ADMIN_RIGHTS);
    next.status = "owner"; next.role = "owner"; next.adminRights = cloneChatAdminRights(DEFAULT_CHAT_ADMIN_RIGHTS);
    this.appendChatAudit(chatId, `转移所有者给：${next.user.displayName}`, "memberPromotion");
  }

  async getChatEventLog({ chatId, query = "", fromEventId, limit = 30 }: ChatEventLogInput): Promise<ChatEventPage> {
    const events = (this.chatAudit.get(chatId) ?? []).filter((event) => !query.trim() || event.summary.includes(query.trim()));
    const start = fromEventId ? Math.max(0, events.findIndex((event) => event.id === fromEventId) + 1) : 0;
    const page = events.slice(start, start + Math.min(100, Math.max(1, limit)));
    return { events: clone(page), nextEventId: page.at(-1)?.id, hasMore: start + page.length < events.length };
  }

  private ensureInviteLinks(chatId: string) {
    let links = this.chatInviteLinks.get(chatId);
    if (!links) {
      links = [{
        inviteLink: `https://t.me/+notgram_${chatId.replace(/[^a-z0-9]/gi, "")}`,
        name: "主邀请链接",
        creatorUserId: this.snapshot.currentUserId,
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        memberLimit: 0,
        memberCount: 3,
        expiredMemberCount: 1,
        pendingJoinRequestCount: 2,
        createsJoinRequest: true,
        isPrimary: true,
        isRevoked: false,
      }];
      this.chatInviteLinks.set(chatId, links);
    }
    if (!this.chatJoinRequests.has(chatId)) {
      const candidates = ["u-chen", "u-jules"].map((id) => this.snapshot.users.find((user) => user.id === id)).filter((user): user is User => Boolean(user));
      this.chatJoinRequests.set(chatId, candidates.map((user, index) => ({ user: clone(user), date: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(), bio: index === 0 ? "希望加入桌面端协作" : undefined, inviteLink: links?.[0]?.inviteLink })));
    }
    return links;
  }

  async getChatInviteLinks({ chatId, revoked = false, offsetLink = "", limit = 30 }: GetChatInviteLinksInput): Promise<ChatInviteLinkPage> {
    const all = this.ensureInviteLinks(chatId).filter((link) => link.isRevoked === revoked);
    const start = offsetLink ? Math.max(0, all.findIndex((link) => link.inviteLink === offsetLink) + 1) : 0;
    const links = all.slice(start, start + Math.min(100, Math.max(1, limit)));
    return { links: clone(links), hasMore: start + links.length < all.length, nextOffsetLink: links.at(-1)?.inviteLink, nextOffsetDate: links.at(-1) ? Math.floor(Date.parse(links.at(-1)!.createdAt) / 1000) : undefined };
  }

  async createChatInviteLink(input: CreateChatInviteLinkInput): Promise<ChatInviteLink> {
    this.ensureInviteLinks(input.chatId);
    const name = input.name.trim();
    if ([...name].length > 32) throw new Error("邀请链接名称最多 32 个字符");
    const link: ChatInviteLink = {
      inviteLink: `https://t.me/+${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`,
      name: name || (input.subscriptionStars ? "订阅链接" : "邀请链接"),
      creatorUserId: this.snapshot.currentUserId,
      createdAt: new Date().toISOString(),
      expiresAt: input.expirationDate ? new Date(input.expirationDate * 1000).toISOString() : undefined,
      memberLimit: input.memberLimit ?? 0,
      memberCount: 0,
      expiredMemberCount: 0,
      pendingJoinRequestCount: 0,
      createsJoinRequest: input.createsJoinRequest === true,
      isPrimary: false,
      isRevoked: false,
      subscriptionStars: input.subscriptionStars,
      subscriptionPeriod: input.subscriptionStars ? 2_592_000 : undefined,
    };
    this.chatInviteLinks.get(input.chatId)!.unshift(link);
    this.appendChatAudit(input.chatId, `创建邀请链接：${link.name}`, "inviteLink");
    return clone(link);
  }

  async editChatInviteLink(input: CreateChatInviteLinkInput & { inviteLink: string }): Promise<ChatInviteLink> {
    const link = this.ensureInviteLinks(input.chatId).find((item) => item.inviteLink === input.inviteLink);
    if (!link || link.isRevoked) throw new Error("邀请链接不存在或已撤销");
    link.name = input.name.trim() || link.name;
    link.expiresAt = input.expirationDate ? new Date(input.expirationDate * 1000).toISOString() : undefined;
    link.memberLimit = input.memberLimit ?? 0;
    link.createsJoinRequest = input.createsJoinRequest === true;
    link.editedAt = new Date().toISOString();
    this.appendChatAudit(input.chatId, `编辑邀请链接：${link.name}`, "inviteLink");
    return clone(link);
  }

  async revokeChatInviteLink(chatId: string, inviteLink: string): Promise<ChatInviteLink> {
    const link = this.ensureInviteLinks(chatId).find((item) => item.inviteLink === inviteLink);
    if (!link) throw new Error("找不到邀请链接");
    link.isRevoked = true;
    this.appendChatAudit(chatId, `撤销邀请链接：${link.name}`, "inviteLink");
    return clone(link);
  }

  async getChatJoinRequests({ chatId, inviteLink, query = "", offsetUserId, limit = 30 }: GetChatJoinRequestsInput): Promise<ChatJoinRequestPage> {
    this.ensureInviteLinks(chatId);
    const normalized = query.trim().toLocaleLowerCase();
    const all = (this.chatJoinRequests.get(chatId) ?? []).filter((request) => (!inviteLink || request.inviteLink === inviteLink) && (!normalized || `${request.user.displayName} ${request.bio ?? ""}`.toLocaleLowerCase().includes(normalized)));
    const start = offsetUserId ? Math.max(0, all.findIndex((request) => request.user.id === offsetUserId) + 1) : 0;
    const requests = all.slice(start, start + Math.min(100, Math.max(1, limit)));
    const last = requests.at(-1);
    return { requests: clone(requests), totalCount: all.length, hasMore: start + requests.length < all.length, nextOffsetUserId: last?.user.id, nextOffsetDate: last ? Math.floor(Date.parse(last.date) / 1000) : undefined };
  }

  async processChatJoinRequest(chatId: string, userId: string, approve: boolean): Promise<void> {
    this.ensureInviteLinks(chatId);
    const requests = this.chatJoinRequests.get(chatId) ?? [];
    const request = requests.find((item) => item.user.id === userId);
    if (!request) throw new Error("入群申请不存在");
    this.chatJoinRequests.set(chatId, requests.filter((item) => item.user.id !== userId));
    if (approve) await this.addChatMembers(chatId, [userId]);
    this.appendChatAudit(chatId, `${approve ? "批准" : "拒绝"}入群申请：${request.user.displayName}`, "inviteLink");
  }

  async processChatJoinRequests(chatId: string, inviteLink: string | undefined, approve: boolean): Promise<void> {
    this.ensureInviteLinks(chatId);
    const requests = this.chatJoinRequests.get(chatId) ?? [];
    const selected = requests.filter((request) => !inviteLink || request.inviteLink === inviteLink);
    this.chatJoinRequests.set(chatId, requests.filter((request) => inviteLink && request.inviteLink !== inviteLink));
    if (approve) await this.addChatMembers(chatId, selected.map((request) => request.user.id));
    this.appendChatAudit(chatId, `${approve ? "批量批准" : "批量拒绝"} ${selected.length} 个入群申请`, "inviteLink");
  }

  async getBotCommandSuggestions(
    chatId: string,
    query = "",
    botUsername = "notgram_bot",
  ): Promise<BotCommandSuggestion[]> {
    void chatId;
    const username = botUsername.replace(/^@/, "").trim() || "notgram_bot";
    const commands: BotCommandSuggestion[] = [
      { botUserId: `bot:${username}`, botUsername: username, command: "start", description: "启动机器人或打开参数" },
      { botUserId: `bot:${username}`, botUsername: username, command: "help", description: "查看帮助" },
      { botUserId: `bot:${username}`, botUsername: username, command: "settings", description: "打开设置" },
    ];
    const normalized = query.replace(/^\//, "").toLocaleLowerCase();
    return commands.filter((command) => !normalized || command.command.startsWith(normalized));
  }

  async getCallbackQueryAnswer(
    chatId: string,
    messageId: string,
    data: string,
  ): Promise<CallbackQueryAnswer> {
    void chatId;
    void messageId;
    return { text: data ? "机器人已处理操作" : undefined, showAlert: false };
  }

  async getInlineQueryResults(chatId: string, botUsername: string, query: string, offset = ""): Promise<InlineQueryResultPage> {
    void chatId;
    const username = botUsername.replace(/^@/, "").trim() || "notgram_bot";
    const all = [
      { title: "快速摘要", description: `由 @${username} 生成的摘要`, messageText: `@${username}: ${query.trim() || "空查询"}` },
      { title: "项目卡片", description: "包含媒体预览的结果", messageText: `项目卡片：${query.trim() || "Notgram"}`, thumbnailUrl: "/icon.png" },
      { title: "引用模板", description: "可继续编辑后发送", messageText: `> ${query.trim() || "输入内容"}` },
      { title: "文件结果", description: "结果中的文件摘要", messageText: `文件：${query.trim() || "说明文档"}`, kind: "file" as const, fileName: "result.txt" },
    ].map((item, index) => ({ ...item, id: `${username}-${index}`, kind: item.kind ?? (index === 1 ? "photo" as const : "article" as const) }));
    const start = offset ? Number.parseInt(offset, 10) || 0 : 0;
    const page = all.slice(start, start + 2);
    for (const result of page) this.inlineResults.set(result.id, { botUserId: `bot:${username}`, text: result.messageText });
    return { queryId: `mock-query-${Date.now()}`, results: clone(page), nextOffset: start + page.length < all.length ? String(start + page.length) : undefined, hasMore: start + page.length < all.length };
  }

  async sendInlineQueryResultMessage(chatId: string, botUserId: string, queryId: string, resultId: string, replyToMessageId?: string, topicId?: string): Promise<void> {
    void queryId;
    const result = this.inlineResults.get(resultId);
    if (!result || result.botUserId !== botUserId) throw new Error("Inline 结果已过期");
    await this.sendMessage({ chatId, topicId, text: result.text, replyToMessageId });
  }

  async sendBotStartMessage(chatId: string, botUserId: string, parameter = ""): Promise<void> {
    await this.sendMessage({ chatId, text: `/start${parameter.trim() ? ` ${parameter.trim()}` : ""}` });
    void botUserId;
  }

  async getBlockedSenders(): Promise<BlockedSender[]> {
    return clone([...this.blockedSenders.values()]);
  }

  async setMessageSenderBlocked(senderId: string, kind: "user" | "chat", blocked: boolean): Promise<void> {
    const key = `${kind}:${senderId}`;
    if (!blocked) { this.blockedSenders.delete(key); return; }
    const user = kind === "user" ? this.snapshot.users.find((item) => item.id === senderId) : undefined;
    const chat = kind === "chat" ? this.snapshot.chats.find((item) => item.id === senderId) : undefined;
    if (!user && !chat) throw new Error("找不到要屏蔽的对象");
    this.blockedSenders.set(key, {
      id: senderId,
      kind,
      title: user?.displayName ?? chat?.title ?? "已屏蔽对象",
      avatar: clone(user?.avatar ?? chat?.avatar ?? { label: "?", color: "#73808c" }),
      blockedAt: new Date().toISOString(),
    });
  }

  async getChatReportOptions(chatId: string, messageIds: string[]): Promise<ChatReportOptions> {
    void chatId; void messageIds;
    return { title: "选择举报原因", options: [
      { id: "spam", title: "Spam and Scams" },
      { id: "violence", title: "Violence" },
      { id: "pornography", title: "Pornography" },
      { id: "child_abuse", title: "Child Abuse" },
      { id: "copyright", title: "Copyright" },
      { id: "unrelated_location", title: "Unrelated Location" },
      { id: "fake", title: "Fake Account" },
      { id: "illegal_drugs", title: "Illegal Drugs" },
      { id: "personal_details", title: "Personal Details" },
      { id: "other", title: "Other", requiresText: true },
    ] };
  }

  async reportChat(input: ReportChatInput): Promise<void> {
    const options = await this.getChatReportOptions(input.chatId, input.messageIds);
    const option = options.options.find((item) => item.id === input.optionId);
    if (!option) throw new Error("举报原因无效");
    if (option.requiresText && !input.text?.trim()) throw new Error("请补充举报说明");
    if (input.messageIds.length > 100) throw new Error("单次最多举报 100 条消息");
  }

  async getActiveSessions(): Promise<DeviceSession[]> { return clone(this.sessions); }
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session || session.isCurrent) throw new Error("不能终止当前设备");
    this.sessions = this.sessions.filter((item) => item.id !== sessionId);
  }
  async terminateAllOtherSessions(): Promise<void> { this.sessions = this.sessions.filter((item) => item.isCurrent); }
  async getPrivacySettingRules(setting: PrivacySettingKey): Promise<PrivacyRule[]> { return clone(this.privacyRules[setting]); }
  async setPrivacySettingRules(setting: PrivacySettingKey, rules: PrivacyRule[]): Promise<void> { if (rules.length === 0 || rules.length > 10) throw new Error("隐私规则无效"); this.privacyRules[setting] = clone(rules); }

  async resolveTelegramLink(url: string) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return undefined; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.protocol !== "tg:" && !["t.me", "telegram.me", "telegram.dog"].includes(host)) return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const username = parsed.protocol === "tg:" ? parsed.searchParams.get("domain") : parts[0];
    if (!username) return undefined;
    const chat = this.snapshot.chats.find((candidate) => candidate.title.toLowerCase() === username.toLowerCase());
    return chat ? { chatId: chat.id, messageId: parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : parsed.searchParams.get("post") || undefined } : undefined;
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
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return { chats: [], messages: [], totalCount: 0 };
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
        return typeMatches(message) && messageSearchMatches(searchable, normalizedQuery);
      })
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const start = Math.max(0, Number.parseInt(offset, 10) || 0);
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const messages = matches.slice(start, start + boundedLimit);
    const next = start + messages.length;
    const chatIds = new Set(messages.map((message) => message.chatId));
    if (!offset) {
      for (const chat of this.snapshot.chats) {
        if (messageSearchMatches(`${chat.title} ${chat.preview}`, normalizedQuery)) chatIds.add(chat.id);
      }
    }
    return {
      chats: clone(this.snapshot.chats.filter((chat) => chatIds.has(chat.id))),
      messages: clone(messages),
      totalCount: matches.length,
      nextOffset: next < matches.length ? String(next) : undefined,
    };
  }

  async searchChatMessages(input: ChatMessageSearchInput): Promise<ChatMessageSearchPage> {
    const query = input.query?.trim() ?? "";
    const filter = input.filter ?? "all";
    const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
    const matches = this.snapshot.messages
      .filter((message) => message.chatId === input.chatId)
      .filter((message) => !input.topicId || message.topicId === input.topicId)
      .filter((message) => !input.senderId || message.senderId === input.senderId)
      .filter((message) => {
        const timestamp = Math.floor(Date.parse(message.sentAt) / 1000);
        return (!input.minDate || timestamp >= input.minDate) &&
          (!input.maxDate || timestamp <= input.maxDate);
      })
      .filter((message) => mockChatSearchFilterMatches(message, filter))
      .filter((message) => !query || messageSearchMatches(messageContentText(message.content), query))
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const start = input.fromMessageId
      ? Math.max(0, matches.findIndex((message) => message.id === input.fromMessageId))
      : 0;
    const messages = matches.slice(start, start + limit);
    const nextFromMessageId = matches[start + messages.length]?.id;
    return {
      messages: clone(messages),
      totalCount: matches.length,
      nextFromMessageId,
      hasMore: Boolean(nextFromMessageId),
    };
  }

  async searchSharedMedia(input: SharedMediaSearchInput) {
    const categoryMatches = (message: Message) => {
      if (input.category === "media") {
        return message.content.kind === "media" && ["photo", "video", "videoNote"].includes(message.content.mediaType);
      }
      if (input.category === "file") return message.content.kind === "file";
      if (input.category === "audio") {
        return message.content.kind === "media" && ["audio", "voice"].includes(message.content.mediaType);
      }
      const text = messageContentText(message.content);
      return message.content.kind === "text" && (
        message.content.entities?.some((entity) => ["url", "textUrl"].includes(entity.kind)) ||
        /https?:\/\/\S+/i.test(text)
      );
    };
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const all = this.snapshot.messages
      .filter((message) => message.chatId === input.chatId && categoryMatches(message))
      .filter((message) => !query || messageContentText(message.content).toLocaleLowerCase().includes(query))
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const cursorIndex = input.fromMessageId
      ? all.findIndex((message) => message.id === input.fromMessageId) + 1
      : 0;
    const offset = Math.max(0, cursorIndex);
    const limit = Math.max(1, Math.min(input.limit ?? 40, 100));
    const messages = all.slice(offset, offset + limit);
    return clone({
      messages,
      totalCount: all.length,
      nextFromMessageId: messages.at(-1)?.id,
      hasMore: offset + messages.length < all.length,
    });
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

  private ensureForumTopics(chatId: string) {
    const existing = this.forumTopics.get(chatId);
    if (existing) return existing;
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat?.isForum) return [];
    const makeTopic = (id: string, name: string, color: number, isGeneral = false, unreadCount = 0): ForumTopic => {
      const lastMessage = this.snapshot.messages
        .filter((message) => message.chatId === chatId && message.topicId === id)
        .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt))[0];
      return {
        id,
        chatId,
        name,
        iconColor: color,
        createdAt: "2026-08-01T08:00:00.000Z",
        isGeneral,
        isOutgoing: isGeneral,
        isClosed: false,
        isHidden: false,
        isPinned: isGeneral,
        unreadCount,
        unreadMentionCount: 0,
        unreadReactionCount: 0,
        lastReadInboxMessageId: lastMessage?.id,
        lastReadOutboxMessageId: lastMessage?.id,
        lastMessage: lastMessage ? clone(lastMessage) : undefined,
        order: id === "1" ? "300" : id === "12" ? "200" : "100",
        muted: false,
        draft: this.drafts.get(`${chatId}:topic:${id}`) ? clone(this.drafts.get(`${chatId}:topic:${id}`)) : undefined,
      };
    };
    const topics = [
      makeTopic("1", "常规", 0x6fb9f0, true),
      makeTopic("12", "构建与发布", 0xffd67e, false, 3),
      makeTopic("18", "设计反馈", 0xcb86db, false, 1),
    ];
    this.forumTopics.set(chatId, topics);
    return topics;
  }

  async getForumTopics(input: GetForumTopicsInput): Promise<ForumTopicPage> {
    const all = this.ensureForumTopics(input.chatId)
      .filter((topic) => !input.query?.trim() || topic.name.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase()))
      .sort((left, right) => Number(right.order) - Number(left.order));
    const offset = input.offsetTopicId ? Math.max(0, all.findIndex((topic) => topic.id === input.offsetTopicId) + 1) : 0;
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const topics = all.slice(offset, offset + limit);
    const next = all[offset + topics.length];
    return clone({
      topics,
      totalCount: all.length,
      nextOffsetDate: next ? Math.floor(Date.parse(next.createdAt) / 1_000) : undefined,
      nextOffsetMessageId: next?.lastMessage?.id,
      nextOffsetTopicId: next?.id,
      hasMore: Boolean(next),
    });
  }

  async loadForumTopicHistory(chatId: string, topicId: string, limit = 30): Promise<ChatHistoryPage> {
    const historyKey = `forum:${chatId}:${topicId}`;
    const history = this.snapshot.messages
      .filter((message) => message.chatId === chatId && message.topicId === topicId)
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const offset = this.historyOffsets.get(historyKey) ?? 0;
    const page = history.slice(offset, offset + limit);
    this.historyOffsets.set(historyKey, offset + page.length);
    this.listener?.({ type: "messages.upserted", messages: clone(page) });
    return { loadedCount: page.length, hasMore: offset + page.length < history.length, messageIds: page.map((message) => message.id) };
  }

  async createForumTopic(input: CreateForumTopicInput): Promise<ForumTopic> {
    const topics = this.ensureForumTopics(input.chatId);
    const id = String(100 + topics.length);
    const topic: ForumTopic = {
      id,
      chatId: input.chatId,
      name: input.name.trim(),
      iconColor: input.iconColor ?? 0x6fb9f0,
      createdAt: new Date().toISOString(),
      isGeneral: false,
      isOutgoing: true,
      isClosed: false,
      isHidden: false,
      isPinned: false,
      unreadCount: 0,
      unreadMentionCount: 0,
      unreadReactionCount: 0,
      order: String(Date.now()),
      muted: false,
    };
    topics.unshift(topic);
    this.listener?.({ type: "forumTopics.changed", chatId: input.chatId });
    return clone(topic);
  }

  async editForumTopic(chatId: string, topicId: string, name: string) {
    const topic = this.ensureForumTopics(chatId).find((candidate) => candidate.id === topicId);
    if (!topic) throw new Error("找不到话题");
    topic.name = name.trim();
    this.listener?.({ type: "forumTopics.changed", chatId });
  }

  async setForumTopicClosed(chatId: string, topicId: string, closed: boolean) {
    const topic = this.ensureForumTopics(chatId).find((candidate) => candidate.id === topicId);
    if (!topic) throw new Error("找不到话题");
    topic.isClosed = closed;
    this.listener?.({ type: "forumTopics.changed", chatId });
  }

  async setForumTopicPinned(chatId: string, topicId: string, pinned: boolean) {
    const topic = this.ensureForumTopics(chatId).find((candidate) => candidate.id === topicId);
    if (!topic) throw new Error("找不到话题");
    topic.isPinned = pinned;
    this.listener?.({ type: "forumTopics.changed", chatId });
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

  async getRawMessage(chatId: string, messageId: string) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    if (!message) return undefined;
    if (message.content.kind === "unsupported") return message.content.raw;
    return JSON.stringify({
      "@type": "message",
      id: message.id,
      chat_id: message.chatId,
      sender_id: message.senderId,
      is_outgoing: message.outgoing,
      date: Math.floor(Date.parse(message.sentAt) / 1_000),
      content: message.content,
    }, null, 2);
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
      canPin: true,
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

  async setPollAnswer(input: SetPollAnswerInput) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === input.chatId && item.id === input.messageId,
    );
    if (!message || message.content.kind !== "poll") throw new Error("投票不存在");
    const poll = message.content;
    if (poll.isClosed || poll.restrictionReason) throw new Error(poll.restrictionReason ?? "投票已结束");
    const positions = [...new Set(input.optionPositions)].sort((left, right) => left - right);
    if ((!poll.allowsMultipleAnswers && positions.length > 1) ||
      positions.some((position) => !poll.options[position])) throw new Error("投票选项无效");
    const previouslyVoted = poll.options.some((option) => option.chosen);
    const nowVoted = positions.length > 0;
    const nextTotal = Math.max(0, poll.totalVoterCount + (nowVoted ? 1 : 0) - (previouslyVoted ? 1 : 0));
    poll.options = poll.options.map((option) => {
      const chosen = positions.includes(option.position);
      const voterCount = Math.max(0, option.voterCount + (chosen ? 1 : 0) - (option.chosen ? 1 : 0));
      return {
        ...option,
        chosen,
        beingChosen: false,
        voterCount,
        votePercentage: nextTotal > 0 ? Math.round(voterCount * 100 / nextTotal) : 0,
      };
    });
    poll.totalVoterCount = nextTotal;
    poll.canSeeResults = true;
    this.listener?.({ type: "message.upsert", message: clone(message) });
  }

  async getPinnedMessages(chatId: string) {
    return clone(this.snapshot.messages
      .filter((message) => message.chatId === chatId && message.isPinned)
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt)));
  }

  async pinMessage(input: PinMessageInput) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === input.chatId && item.id === input.messageId,
    );
    if (!message) throw new Error("找不到需要置顶的消息");
    message.isPinned = true;
    delete message.permissions;
    this.listener?.({ type: "message.upsert", message: clone(message) });
  }

  async unpinMessage(chatId: string, messageId: string) {
    const message = this.snapshot.messages.find(
      (item) => item.chatId === chatId && item.id === messageId,
    );
    if (!message) throw new Error("找不到需要取消置顶的消息");
    message.isPinned = false;
    delete message.permissions;
    this.listener?.({ type: "message.upsert", message: clone(message) });
  }

  async setChatMessageAutoDeleteTime(input: SetChatMessageAutoDeleteTimeInput) {
    if (!Number.isSafeInteger(input.messageAutoDeleteTime) ||
      input.messageAutoDeleteTime < 0 || input.messageAutoDeleteTime > 31_536_000 ||
      (input.messageAutoDeleteTime !== 0 && input.messageAutoDeleteTime % 86_400 !== 0)) {
      throw new Error("自动删除时间无效");
    }
    const chat = this.snapshot.chats.find((item) => item.id === input.chatId);
    if (!chat) throw new Error("找不到会话");
    chat.messageAutoDeleteTime = input.messageAutoDeleteTime;
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  async getEmojiPickerCatalog(): Promise<EmojiPickerCatalog> {
    return clone({
      recentStickers: mockStickerSets[0].stickers.slice(0, 4),
      stickerSets: mockStickerSets.map(({ stickers: _stickers, ...summary }) => summary),
      savedAnimations: mockSavedAnimations,
    });
  }

  async getStickerSet(stickerSetId: string) {
    const stickerSet = mockStickerSets.find((candidate) => candidate.id === stickerSetId);
    if (!stickerSet) throw new Error("找不到贴纸包");
    return clone(stickerSet);
  }

  async searchStickers(query: string, _chatId: string) {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return clone(mockStickerSets.flatMap((stickerSet) => stickerSet.stickers)
      .filter((asset) =>
        asset.emoji?.includes(normalized) ||
        asset.id.toLocaleLowerCase().includes(normalized)
      ));
  }

  async loadEmojiAsset(asset: EmojiPickerAsset) {
    return asset.previewPath ?? asset.localPath ?? asset.previewDataUrl;
  }

  async sendSticker(input: SendEmojiAssetInput) {
    this.appendEmojiAsset(input, "sticker");
  }

  async sendAnimation(input: SendEmojiAssetInput) {
    this.appendEmojiAsset(input, "animation");
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

  async sendMessage({ chatId, topicId, text, replyToMessageId, clearDraft = true }: SendMessageInput) {
    const replyTarget = replyToMessageId
      ? this.snapshot.messages.find(
          (message) => message.chatId === chatId && message.topicId === topicId && message.id === replyToMessageId,
        )
      : undefined;
    if (replyToMessageId && !replyTarget) throw new Error("找不到需要回复的消息");
    this.appendMessage({
      id: crypto.randomUUID(),
      chatId,
      topicId,
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
    if (clearDraft) await this.setChatDraft({ chatId, topicId, text: "" });
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

  async forwardMessages({ fromChatId, toChatId, toTopicId, messageIds }: ForwardMessagesInput): Promise<ForwardMessagesResult> {
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
        topicId: toTopicId,
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

  async setChatDraft({ chatId, topicId, text, replyToMessageId }: SetChatDraftInput) {
    if (!this.snapshot.chats.some((chat) => chat.id === chatId)) {
      throw new Error("找不到需要保存草稿的会话");
    }
    const draft = text.length > 0 || replyToMessageId
      ? {
          chatId,
          topicId,
          text,
          replyToMessageId,
          updatedAt: new Date().toISOString(),
        }
      : undefined;
    const key = topicId ? `${chatId}:topic:${topicId}` : chatId;
    if (draft) this.drafts.set(key, draft);
    else this.drafts.delete(key);
    this.listener?.({ type: "chat.draftChanged", chatId, draft: clone(draft) });
  }

  async setChatTyping(_chatId: string, _typing: boolean, _topicId?: string) {}

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

  async sendFile({ chatId, topicId, file }: SendFileInput) {
    if (!file) return false;
    return this.sendFiles({
      chatId,
      topicId,
      attachments: [{
        file,
        kind: file.type.startsWith("image/") ? "photo" : "document",
      }],
    });
  }

  async sendFiles({ chatId, topicId, attachments, caption }: SendFilesInput) {
    if (attachments.length === 0) return false;
    const allVisual = attachments.length > 1 && attachments.every(
      (attachment) => attachment.kind === "photo" || attachment.kind === "video",
    );
    const albumId = allVisual ? `mock-album-${crypto.randomUUID()}` : undefined;
    for (const [index, attachment] of attachments.entries()) {
      const { file, kind } = attachment;
      const isMedia = kind !== "document";
      const preview = kind === "photo" ? await previewDataUrl(file) : undefined;
      this.appendMessage({
        id: crypto.randomUUID(),
        chatId,
        topicId,
        mediaAlbumId: isMedia ? albumId : undefined,
        senderId: this.snapshot.currentUserId,
        outgoing: true,
        sentAt: new Date().toISOString(),
        delivery: "sent",
        content: isMedia
          ? {
              kind: "media",
              mediaType: kind,
              fileName: file.name,
              sizeLabel: readableFileSize(file.size),
              previewDataUrl: preview,
              width: attachment.width,
              height: attachment.height,
              duration: attachment.duration,
              caption: index === 0 ? caption : undefined,
            }
          : {
              kind: "file",
              fileName: file.name,
              sizeLabel: readableFileSize(file.size),
              caption: index === 0 ? caption : undefined,
            },
      });
    }
    return true;
  }

  async cancelFileUpload(chatId: string, messageId: string) {
    await this.deleteMessage({ chatId, messageId, revoke: true });
  }

  async markChatRead(chatId: string) {
    const chat = this.snapshot.chats.find((item) => item.id === chatId);
    if (!chat || chat.unreadCount === 0) return;
    const latestIncomingMessage = this.snapshot.messages
      .filter((message) => message.chatId === chatId && !message.outgoing)
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt))[0];
    chat.unreadCount = 0;
    chat.lastReadInboxMessageId = latestIncomingMessage?.id ?? chat.lastReadInboxMessageId;
    this.listener?.({ type: "chat.upsert", chat: clone(chat) });
  }

  async markForumTopicRead(chatId: string, topicId: string, messageId: string) {
    const topic = this.ensureForumTopics(chatId).find((item) => item.id === topicId);
    if (!topic || !this.snapshot.messages.some((message) => message.id === messageId && message.topicId === topicId)) return;
    topic.unreadCount = 0;
    topic.unreadMentionCount = 0;
    topic.unreadReactionCount = 0;
    topic.lastReadInboxMessageId = messageId;
    this.listener?.({ type: "forumTopics.changed", chatId });
  }

  private appendMessage(message: Message) {
    this.snapshot.messages.push(message);
    this.listener?.({ type: "message.upsert", message: clone(message), animateEntrance: true });

    const chat = this.snapshot.chats.find((item) => item.id === message.chatId);
    if (!chat) return;

    const updatedChat: Chat = {
      ...chat,
      preview: messageContentText(message.content),
      previewSenderId: message.senderId,
      updatedAt: message.sentAt,
      unreadCount: 0,
    };
    Object.assign(chat, updatedChat);
    this.listener?.({ type: "chat.upsert", chat: clone(updatedChat) });
  }

  private appendEmojiAsset(
    input: SendEmojiAssetInput,
    mediaType: "sticker" | "animation",
  ) {
    const replyTarget = input.replyToMessageId
      ? this.snapshot.messages.find(
          (message) => message.chatId === input.chatId && message.id === input.replyToMessageId,
        )
      : undefined;
    this.appendMessage({
      id: crypto.randomUUID(),
      chatId: input.chatId,
      topicId: input.topicId,
      senderId: this.snapshot.currentUserId,
      outgoing: true,
      sentAt: new Date().toISOString(),
      delivery: "sent",
      replyTo: replyTarget
        ? {
            kind: "message",
            chatId: input.chatId,
            messageId: replyTarget.id,
            content: clone(replyTarget.content),
          }
        : undefined,
      content: {
        kind: "media",
        mediaType,
        fileId: input.asset.fileId,
        fileName: input.asset.fileName,
        sizeLabel: mediaType === "sticker" ? "贴纸" : "GIF",
        mimeType: input.asset.mimeType,
        previewDataUrl: input.asset.previewDataUrl,
        localPath: input.asset.localPath,
        thumbnailPath: input.asset.previewPath,
        width: input.asset.width,
        height: input.asset.height,
        canDownload: false,
        isDownloaded: true,
      },
    });
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
      previewSenderId: latest.senderId,
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
