import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asTdObject,
  asTdObjects,
  mapTdChat,
  mapTdChatDraft,
  mapTdChatFolders,
  mapTdMessage,
  mapTdMessageProperties,
  mapTdUser,
  tdId,
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import { FileDownloadQueue } from "./fileDownloadQueue";
import { loadHistoryWindow } from "./historyPager";
import {
  mapTdConnectionStatus,
  tdConnectionState,
} from "./connectionState";
import { TdRequestBroker } from "./tdRequestBroker";
import { TauriAccountStorage } from "./tauriAccountStorage";
import {
  chatListKey,
  chatListObject,
  chatFolderNumericId,
  effectiveProxy,
  formattedTextObject,
  inputMessageText,
  listObject,
  mapAuthorizationState,
  numericId,
  proxyValue,
  sameProxy,
} from "./tdlibRequests";
import { routeTdUpdate, type TdUpdateHandlers } from "./tdUpdateRouter";
import { messageContentText } from "./messageContent";
import { messageSearchMatches, parseMessageSearchQuery } from "./messageSearch";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  CachedTelegramSnapshot,
  Chat,
  ChatFolder,
  ChatProfile,
  ChatHistoryPage,
  ChatListPage,
  DeleteMessageInput,
  EditMessageInput,
  ForwardMessagesInput,
  ForwardMessagesResult,
  GlobalSearchFilter,
  GlobalSearchInput,
  GlobalSearchPage,
  Message,
  MessagePermissions,
  ConnectionStatus,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
  SetChatDraftInput,
  SetMessageReactionInput,
  StorageSettings,
  StreamFileInput,
  TelegramSnapshot,
  TelegramAccount,
  TelegramAccountState,
  User,
} from "./types";

interface RuntimeStatus {
  backend: string;
  linked: boolean;
  state: string;
  credentialsConfigured: boolean;
  libraryPath?: string;
  searchedPaths: string[];
  error?: string;
  logPath?: string;
}

const globalSearchFilterObject = (filter: GlobalSearchFilter): TdObject | null => {
  switch (filter) {
    case "media": return { "@type": "searchMessagesFilterPhotoAndVideo" };
    case "file": return { "@type": "searchMessagesFilterDocument" };
    case "link": return { "@type": "searchMessagesFilterUrl" };
    default: return null;
  }
};

const globalSearchContentMatches = (message: Message, filter: GlobalSearchFilter) => {
  if (filter === "all") return true;
  if (filter === "message") return ["text", "rich", "service"].includes(message.content.kind);
  if (filter === "media") return message.content.kind === "media";
  if (filter === "file") return message.content.kind === "file";
  return message.content.kind === "text" && (
    message.content.entities?.some((entity) => entity.kind === "textUrl" || entity.kind === "url") ||
    /https?:\/\//i.test(message.content.text)
  );
};

const profileText = (value: unknown) => {
  const object = asTdObject(value);
  return typeof object?.text === "string" ? object.text.trim() : "";
};

const profileMemberRole = (value: unknown) => {
  switch (asTdObject(value)?.["@type"]) {
    case "chatMemberStatusCreator": return "owner" as const;
    case "chatMemberStatusAdministrator": return "administrator" as const;
    default: return "member" as const;
  }
};

const replaceFileReference = (
  value: unknown,
  fileId: number,
  file: TdObject,
): { value: unknown; changed: boolean } => {
  if (Array.isArray(value)) {
    let changed = false;
    const updated = value.map((item) => {
      const replaced = replaceFileReference(item, fileId, file);
      changed ||= replaced.changed;
      return replaced.value;
    });
    return { value: changed ? updated : value, changed };
  }
  const object = asTdObject(value);
  if (!object) return { value, changed: false };
  if (
    tdNumber(object.id) === fileId &&
    (object["@type"] === "file" || ("local" in object && "remote" in object))
  ) {
    return { value: file, changed: true };
  }

  let changed = false;
  const updated: TdObject = {};
  for (const [key, item] of Object.entries(object)) {
    const replaced = replaceFileReference(item, fileId, file);
    changed ||= replaced.changed;
    updated[key] = replaced.value;
  }
  return { value: changed ? updated : value, changed };
};

const messageIdAtMost = (messageId: string, lastReadId: string) => {
  try {
    return BigInt(messageId) <= BigInt(lastReadId);
  } catch {
    return false;
  }
};

export class TauriTelegramTransport implements TelegramTransport {
  readonly kind = "tauri" as const;
  readonly label = "TDLib";

  private listener?: TelegramEventListener;
  private accountStorage = new TauriAccountStorage();
  private unlistenUpdate?: UnlistenFn;
  private unlistenError?: UnlistenFn;
  private requestBroker = new TdRequestBroker();
  private rawChats = new Map<string, TdObject>();
  private rawUsers = new Map<string, TdObject>();
  private rawMessages = new Map<string, Map<string, TdObject>>();
  private exhaustedHistories = new Set<string>();
  private historyCursors = new Map<string, number>();
  private historyLoads = new Map<string, Promise<ChatHistoryPage>>();
  private pendingReplyHydrations = new Map<string, symbol>();
  private unavailableReplyHydrations = new Set<string>();
  private chatListLoads = new Map<string, Promise<ChatListPage>>();
  private chatListCounts = new Map<string, number>();
  private exhaustedChatLists = new Set<string>();
  private fileDownloads = new FileDownloadQueue(
    (request) => this.request(request),
    (file) => this.updateFile(file),
  );
  private updateHandlers: TdUpdateHandlers = {
    authorization: (update) => this.handleAuthorizationUpdate(update),
    connection: (update) => this.handleConnectionUpdate(update),
    upsertUser: (user) => this.upsertUser(user),
    updateUserStatus: (update) => this.updateUserStatus(update),
    updateChatFolders: (update) => this.updateChatFolders(update),
    upsertChat: (chat) => this.upsertChat(chat),
    emitDraft: (chatId, draft) => this.emitDraft(chatId, draft),
    patchChat: (chatId, patch) => this.patchChat(chatId, patch),
    patchChatWithPositions: (chatId, patch, positions) =>
      this.patchChatWithPositions(chatId, patch, positions),
    updateChatPosition: (update) => this.updateChatPosition(update),
    updateChatList: (update, added) => this.updateChatList(update, added),
    emitMessage: (message) => this.emitMessage(message),
    replaceSentMessage: (update) => this.replaceSentMessage(update),
    updateMessageContent: (update) => this.updateMessageContent(update),
    patchMessage: (chatId, messageId, patch) =>
      this.patchMessage(chatId, messageId, patch),
    updateReadOutbox: (update) => this.updateReadOutbox(update),
    deleteMessages: (update) => this.deleteMessages(update),
    updateFile: (file) => this.updateFile(file),
  };
  private pendingDownloads = new Map<number, string>();
  private rawFolderInfos: TdObject[] = [];
  private mainChatListPosition = 0;
  private currentUserId?: string;
  private bootstrapPromise?: Promise<void>;
  private initialChatSyncPending = true;
  private connectionStatus?: ConnectionStatus;
  private proxyConnectionTimer?: ReturnType<typeof setTimeout>;
  private connectingThroughProxy = false;

  async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.resetSessionState();
    this.listener = listener;
    this.initialChatSyncPending = true;
    this.emitConnectionStatus("connecting");
    const status = await invoke<RuntimeStatus>("telegram_runtime_status");
    if (!status.linked) {
      const detail =
        status.error ??
        `未找到 tdjson 动态库。搜索路径：${status.searchedPaths.join("、")}`;
      throw new Error(detail);
    }
    if (!status.credentialsConfigured) {
      throw new Error("TDLib 已加载，但缺少 NOTGRAM_API_ID / NOTGRAM_API_HASH。");
    }

    this.unlistenUpdate = await listen<TdObject>("telegram://update", (event) =>
      this.handleUpdate(event.payload),
    );
    this.unlistenError = await listen<{ message: string }>(
      "telegram://bridge-error",
      (event) => {
        const error = new Error(event.payload.message);
        this.requestBroker.rejectAll(error);
        this.emitConnectionStatus("offline");
        this.listener?.({ type: "sync.error", message: error.message, fatal: true });
      },
    );
    await invoke("telegram_start");

    return {
      currentUserId: "self",
      authorization: { kind: "preparing" },
      users: [],
      folders: [],
      chats: [],
      messages: [],
    };
  }

  async disconnect() {
    try {
      await invoke("telegram_shutdown");
    } finally {
      this.emitConnectionStatus("offline");
      this.unlistenUpdate?.();
      this.unlistenError?.();
      this.unlistenUpdate = undefined;
      this.unlistenError = undefined;
      this.requestBroker.rejectAll(new Error("TDLib runtime 已关闭。"));
      this.listener = undefined;
      this.resetSessionState();
    }
  }

  async getAccountState() {
    return this.accountStorage.getAccountState();
  }

  async registerCurrentAccount(account: Omit<TelegramAccount, "id">) {
    return this.accountStorage.registerCurrentAccount(account);
  }

  async selectAccount(accountId: string) {
    return this.accountStorage.selectAccount(accountId);
  }

  async removeAccount(accountId: string) {
    return this.accountStorage.removeAccount(accountId);
  }

  async logOut() {
    await this.request({ "@type": "logOut" });
  }

  async loadCachedSnapshot() {
    return this.accountStorage.loadCachedSnapshot();
  }

  async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    await this.accountStorage.saveCachedSnapshot(snapshot);
  }

  async clearCachedSnapshot() {
    await this.accountStorage.clearCachedSnapshot();
  }

  async authenticate(action: AuthorizationAction) {
    switch (action.kind) {
      case "qr":
        await this.request({
          "@type": "requestQrCodeAuthentication",
          other_user_ids: [],
        });
        return;
      case "phone":
        await this.request({
          "@type": "setAuthenticationPhoneNumber",
          phone_number: action.phoneNumber,
          settings: {
            "@type": "phoneNumberAuthenticationSettings",
            allow_flash_call: false,
            allow_missed_call: false,
            is_current_phone_number: false,
            has_unknown_phone_number: false,
            allow_sms_retriever_api: false,
            firebase_authentication_settings: null,
            authentication_tokens: [],
          },
        });
        return;
      case "code":
        await this.request({ "@type": "checkAuthenticationCode", code: action.code });
        return;
      case "password":
        await this.request({
          "@type": "checkAuthenticationPassword",
          password: action.password,
        });
        return;
      case "emailAddress":
        await this.request({
          "@type": "setAuthenticationEmailAddress",
          email_address: action.emailAddress,
        });
        return;
      case "emailCode":
        await this.request({
          "@type": "checkAuthenticationEmailCode",
          code: { "@type": "emailAddressAuthenticationCode", code: action.code },
        });
        return;
      case "registration":
        await this.request({
          "@type": "registerUser",
          first_name: action.firstName,
          last_name: action.lastName,
          disable_notification: false,
        });
    }
  }

  async getProxySettings() {
    return invoke<ProxySettings>("telegram_proxy_settings");
  }

  async saveProxySettings(settings: ProxySettings) {
    try {
      await this.applyProxy(settings);
      await invoke("telegram_save_proxy_settings", {
        preferences: { mode: settings.mode, custom: settings.custom },
      });
    } catch (error) {
      if (effectiveProxy(settings)) this.emitConnectionStatus("proxyError");
      throw error;
    }
  }

  async testProxy(settings: ProxySettings) {
    const endpoint = effectiveProxy(settings);
    const response = await this.request({
      "@type": "pingProxy",
      proxy: endpoint ? proxyValue(endpoint) : null,
    });
    const seconds = tdNumber(response.seconds);
    if (seconds === undefined) throw new Error("TDLib 未返回代理延迟");
    return Math.max(0, Math.round(seconds * 1000));
  }

  async getStorageSettings() {
    return this.accountStorage.getStorageSettings();
  }

  async saveStorageSettings(settings: StorageSettings) {
    return this.accountStorage.saveStorageSettings(settings);
  }

  async getCacheUsage() {
    return this.accountStorage.getCacheUsage();
  }

  async clearMediaCache(input: import("./types").CacheCleanupInput) {
    return this.accountStorage.clearMediaCache(input);
  }

  async getCurrentUserProfile(): Promise<ChatProfile> {
    let userId = this.currentUserId;
    if (!userId) {
      const me = await this.request({ "@type": "getMe" });
      this.upsertUser(me);
      userId = tdId(me.id);
      this.currentUserId = userId || undefined;
    }
    if (!userId) throw new Error("TDLib 未返回当前用户");
    return this.loadUserProfile(userId, "self");
  }

  async getChatProfile(chatId: string): Promise<ChatProfile> {
    const rawChat = this.rawChats.get(chatId) ?? await this.request({
      "@type": "getChat",
      chat_id: numericId(chatId),
    });
    this.upsertChat(rawChat);
    const chat = mapTdChat(rawChat, this.currentUserId);
    if (!chat) throw new Error("TDLib 未返回聊天资料");
    const type = asTdObject(rawChat.type);
    if (type?.["@type"] === "chatTypePrivate") {
      const userId = tdId(type.user_id);
      if (!userId) throw new Error("聊天缺少用户标识");
      const profile = await this.loadUserProfile(
        userId,
        userId === this.currentUserId ? "self" : "user",
      );
      return { ...profile, chatId: chat.id };
    }
    if (type?.["@type"] === "chatTypeSecret") {
      const secret = await this.request({
        "@type": "getSecretChat",
        secret_chat_id: numericId(tdId(type.secret_chat_id)),
      });
      const userId = tdId(secret.user_id);
      if (!userId) throw new Error("秘密聊天缺少用户标识");
      return { ...await this.loadUserProfile(userId, "user"), chatId: chat.id };
    }
    if (type?.["@type"] === "chatTypeBasicGroup") {
      const full = await this.request({
        "@type": "getBasicGroupFullInfo",
        basic_group_id: numericId(tdId(type.basic_group_id)),
      });
      const members = await this.loadProfileMembers(asTdObjects(full.members));
      return {
        id: `chat:${chat.id}`,
        kind: "group",
        chatId: chat.id,
        title: chat.title,
        avatar: chat.avatar,
        statusLabel: `${members.length} 位成员`,
        bio: typeof full.description === "string" && full.description.trim()
          ? full.description.trim()
          : undefined,
        memberCount: members.length,
        members,
        canViewMembers: true,
      };
    }
    if (type?.["@type"] === "chatTypeSupergroup") {
      const supergroupId = tdId(type.supergroup_id);
      const full = await this.request({
        "@type": "getSupergroupFullInfo",
        supergroup_id: numericId(supergroupId),
      });
      const canViewMembers = full.can_get_members === true;
      const memberResult = canViewMembers
        ? await this.request({
            "@type": "getSupergroupMembers",
            supergroup_id: numericId(supergroupId),
            filter: null,
            offset: 0,
            limit: 50,
          })
        : undefined;
      const members = await this.loadProfileMembers(asTdObjects(memberResult?.members));
      const memberCount = tdNumber(full.member_count);
      const isChannel = type.is_channel === true;
      return {
        id: `chat:${chat.id}`,
        kind: isChannel ? "channel" : "group",
        chatId: chat.id,
        title: chat.title,
        avatar: chat.avatar,
        statusLabel: memberCount
          ? `${memberCount.toLocaleString("zh-CN")} 位${isChannel ? "订阅者" : "成员"}`
          : isChannel ? "频道" : "群组",
        bio: typeof full.description === "string" && full.description.trim()
          ? full.description.trim()
          : undefined,
        memberCount,
        members,
        canViewMembers,
      };
    }
    throw new Error("暂不支持此聊天资料类型");
  }

  async getContacts() {
    const result = await this.request({ "@type": "getContacts" });
    const userIds = Array.isArray(result.user_ids)
      ? result.user_ids.map(tdId).filter(Boolean)
      : [];
    const users = await Promise.all(userIds.map((userId) => this.loadUser(userId)));
    return users.filter((user): user is User => Boolean(user))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  }

  async createPrivateChat(userId: string) {
    const raw = await this.request({
      "@type": "createPrivateChat",
      user_id: numericId(userId),
      force: false,
    });
    this.upsertChat(raw);
    const chat = mapTdChat(raw, this.currentUserId);
    if (!chat) throw new Error("TDLib 未返回私聊");
    return chat;
  }

  async searchChats(query: string, limit = 50) {
    const normalized = query.trim();
    if (!normalized) return;
    const result = await this.request({
      "@type": "searchChatsOnServer",
      query: normalized,
      limit: Math.max(1, Math.min(limit, 100)),
    });
    const ids = Array.isArray(result.chat_ids)
      ? result.chat_ids.map(tdId).filter(Boolean)
      : [];
    await Promise.all(ids.map(async (id) => {
      const raw = this.rawChats.get(id) ?? await this.request({
        "@type": "getChat",
        chat_id: numericId(id),
      });
      this.upsertChat(raw);
    }));
  }

  async searchGlobal({
    query,
    filter,
    offset = "",
    limit = 30,
  }: GlobalSearchInput): Promise<GlobalSearchPage> {
    const pattern = parseMessageSearchQuery(query);
    if (!pattern.query) return { chats: [], messages: [], totalCount: 0 };
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const filterObject = globalSearchFilterObject(filter);
    const [found, serverChats, publicChats] = await Promise.all([
      this.request({
        "@type": "searchMessages",
        chat_list: null,
        query: pattern.serverQuery,
        offset,
        limit: boundedLimit,
        filter: filterObject,
        chat_type_filter: null,
        min_date: 0,
        max_date: 0,
      }),
      offset || pattern.kind === "regex" ? Promise.resolve(undefined) : this.request({
        "@type": "searchChatsOnServer",
        query: pattern.serverQuery,
        limit: 50,
      }).catch(() => undefined),
      offset || pattern.kind === "regex" ? Promise.resolve(undefined) : this.request({
        "@type": "searchPublicChats",
        query: pattern.serverQuery,
      }).catch(() => undefined),
    ]);
    const rawMessages = asTdObjects(found.messages);
    const resultChatIds = new Set(
      rawMessages.map((message) => tdId(message.chat_id)).filter(Boolean),
    );
    await Promise.all([...resultChatIds].map(async (chatId) => {
      if (this.rawChats.has(chatId)) return;
      this.upsertChat(await this.request({
        "@type": "getChat",
        chat_id: numericId(chatId),
      }));
    }));
    const messages = rawMessages
      .map((raw) => this.mapMessage(raw))
      .filter((message): message is Message => Boolean(message))
      .filter((message) => globalSearchContentMatches(message, filter))
      .filter((message) => pattern.kind === "text" || messageSearchMatches(
        messageContentText(message.content),
        pattern,
      ));
    const uniqueMessages = [...new Map(messages.map((message) => [
      `${message.chatId}:${message.id}`,
      message,
    ])).values()];
    const chatIds = new Set<string>(uniqueMessages.map((message) => message.chatId));
    for (const result of [serverChats, publicChats]) {
      for (const id of Array.isArray(result?.chat_ids) ? result.chat_ids.map(tdId) : []) {
        if (id) chatIds.add(id);
      }
    }
    const chats = (await Promise.all([...chatIds].map(async (chatId) => {
      const raw = this.rawChats.get(chatId) ?? await this.request({
        "@type": "getChat",
        chat_id: numericId(chatId),
      });
      this.upsertChat(raw);
      return mapTdChat(raw, this.currentUserId);
    }))).filter((chat): chat is Chat => Boolean(chat));
    const totalCount = tdNumber(found.total_count);
    return {
      chats,
      messages: uniqueMessages,
      totalCount: pattern.kind === "text" && filter !== "message" && totalCount !== undefined && totalCount >= 0
        ? totalCount
        : undefined,
      nextOffset: typeof found.next_offset === "string" && found.next_offset
        ? found.next_offset
        : undefined,
    };
  }

  async searchChatMessages(chatId: string, query: string, limit = 100) {
    const pattern = parseMessageSearchQuery(query);
    if (!pattern.query) return 0;
    const result = await this.request({
      "@type": "searchChatMessages",
      chat_id: numericId(chatId),
      topic_id: null,
      query: pattern.serverQuery,
      sender_id: null,
      from_message_id: 0,
      offset: 0,
      limit: Math.max(1, Math.min(limit, 100)),
      filter: null,
    });
    const messages = asTdObjects(result.messages);
    const matches = pattern.kind === "text"
      ? messages
      : messages.filter((raw) => {
          const message = this.mapMessage(raw);
          return Boolean(message && messageSearchMatches(
            messageContentText(message.content),
            pattern,
          ));
        });
    for (const message of matches) this.emitMessage(message);
    return matches.length;
  }

  async loadMoreChats(chatListId: string, limit = 100) {
    return this.loadChatList(
      chatListObject(chatListId),
      Math.max(1, Math.min(limit, 100)),
    );
  }

  async setPinnedChats(chatListId: string, chatIds: string[]) {
    await this.request({
      "@type": "setPinnedChats",
      chat_list: chatListObject(chatListId),
      chat_ids: chatIds.map(numericId),
    });
    await Promise.all(chatIds.map((chatId) => this.refreshChat(chatId)));
  }

  async setChatPinned(chatListId: string, chatId: string, pinned: boolean) {
    await this.request({
      "@type": "toggleChatIsPinned",
      chat_list: chatListObject(chatListId),
      chat_id: numericId(chatId),
      is_pinned: pinned,
    });
    await this.refreshChat(chatId);
  }

  async setChatMuted(chatId: string, muted: boolean) {
    const raw = this.rawChats.get(chatId) ?? await this.refreshChat(chatId);
    const currentSettings = asTdObject(raw.notification_settings);
    if (!currentSettings) throw new Error("无法读取会话通知设置");
    await this.request({
      "@type": "setChatNotificationSettings",
      chat_id: numericId(chatId),
      notification_settings: {
        ...currentSettings,
        "@type": "chatNotificationSettings",
        use_default_mute_for: false,
        mute_for: muted ? 2_147_483_647 : 0,
      },
    });
    await this.refreshChat(chatId);
  }

  async setChatArchived(chatId: string, archived: boolean) {
    await this.request({
      "@type": "addChatToList",
      chat_id: numericId(chatId),
      chat_list: chatListObject(archived ? "archive" : "main"),
    });
    await this.refreshChat(chatId);
  }

  async createChatFolder(title: string, chatIds: string[]) {
    const includedChatIds = [...new Set(chatIds)].map(numericId);
    if (includedChatIds.length === 0) throw new Error("请至少选择一个会话");
    const info = await this.request({
      "@type": "createChatFolder",
      folder: this.newChatFolder(title, includedChatIds),
    });
    const folder = this.upsertFolderInfo(info);
    await Promise.all([...new Set(chatIds)].map((chatId) => this.refreshChat(chatId)));
    return folder;
  }

  async renameChatFolder(folderId: string, title: string) {
    const numericFolderId = chatFolderNumericId(folderId);
    const folder = await this.request({
      "@type": "getChatFolder",
      chat_folder_id: numericFolderId,
    });
    const info = await this.request({
      "@type": "editChatFolder",
      chat_folder_id: numericFolderId,
      folder: { ...folder, name: this.folderName(title) },
    });
    return this.upsertFolderInfo(info);
  }

  async deleteChatFolder(folderId: string) {
    const numericFolderId = chatFolderNumericId(folderId);
    const affectedChatIds = [...this.rawChats.entries()].flatMap(([chatId, raw]) =>
      mapTdChat(raw, this.currentUserId)?.folderIds.includes(folderId) ? [chatId] : []
    );
    await this.request({
      "@type": "deleteChatFolder",
      chat_folder_id: numericFolderId,
      leave_chat_ids: [],
    });
    this.rawFolderInfos = this.rawFolderInfos.filter(
      (info) => tdNumber(info.id) !== numericFolderId,
    );
    this.emitFolders();
    await Promise.all(affectedChatIds.map((chatId) => this.refreshChat(chatId)));
  }

  async setChatFolderMembership(folderId: string, chatId: string, included: boolean) {
    const numericFolderId = chatFolderNumericId(folderId);
    const numericChatId = numericId(chatId);
    const folder = await this.request({
      "@type": "getChatFolder",
      chat_folder_id: numericFolderId,
    });
    const pinned = this.folderChatIds(folder.pinned_chat_ids)
      .filter((id) => included || id !== numericChatId);
    const alwaysIncluded = this.folderChatIds(folder.included_chat_ids)
      .filter((id) => id !== numericChatId);
    const excluded = this.folderChatIds(folder.excluded_chat_ids)
      .filter((id) => id !== numericChatId);
    if (included && !pinned.includes(numericChatId)) alwaysIncluded.push(numericChatId);
    if (!included && folder.is_shareable !== true) excluded.push(numericChatId);
    const info = await this.request({
      "@type": "editChatFolder",
      chat_folder_id: numericFolderId,
      folder: {
        ...folder,
        pinned_chat_ids: pinned,
        included_chat_ids: alwaysIncluded,
        excluded_chat_ids: excluded,
      },
    });
    this.upsertFolderInfo(info);
    await this.refreshChat(chatId);
  }

  async loadChatHistory(chatId: string, limit = 30): Promise<ChatHistoryPage> {
    if (this.exhaustedHistories.has(chatId)) {
      return { loadedCount: 0, hasMore: false, messageIds: [] };
    }
    const existing = this.historyLoads.get(chatId);
    if (existing) return existing;

    const load = this.loadNextHistoryPage(chatId, Math.max(1, Math.min(limit, 100)))
      .finally(() => this.historyLoads.delete(chatId));
    this.historyLoads.set(chatId, load);
    return load;
  }

  async getMessageContext(chatId: string, messageId: string, limit = 31) {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const newerCount = Math.min(49, Math.floor((boundedLimit - 1) / 2));
    const result = await this.request({
      "@type": "getChatHistory",
      chat_id: numericId(chatId),
      from_message_id: numericId(messageId),
      offset: -newerCount,
      limit: boundedLimit,
      only_local: false,
    });
    const rawMessages = asTdObjects(result.messages);
    this.emitMessages(rawMessages);
    return rawMessages
      .map((raw) => this.mapMessage(raw))
      .filter((message): message is Message => Boolean(message));
  }

  async getMessage(chatId: string, messageId: string) {
    const raw = await this.request({
      "@type": "getMessage",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    });
    const message = this.mapMessage(raw);
    if (!message || message.chatId !== chatId || message.id !== messageId) return undefined;
    const chatMessages = this.rawMessages.get(chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(chatId, chatMessages);
    this.ensureReplyContent(raw);
    return message;
  }

  async getMessageProperties(
    chatId: string,
    messageId: string,
  ): Promise<MessagePermissions> {
    const properties = await this.request({
      "@type": "getMessageProperties",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    });
    return mapTdMessageProperties(properties);
  }

  async setMessageReaction(input: SetMessageReactionInput) {
    const request = {
      "@type": input.chosen ? "addMessageReaction" : "removeMessageReaction",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      reaction_type: { "@type": "reactionTypeEmoji", emoji: input.emoji },
    } as TdObject;
    if (input.chosen) {
      request.is_big = false;
      request.update_recent_reactions = true;
    }
    await this.request(request);
  }

  private async formattedTextInput(text: string) {
    const fallback = formattedTextObject(text);
    const hasMarkdown = /(?:\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_|~~[^~]+~~|\|\|[^|]+\|\||`[^`]+`|^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+\.\s)|\[[^\]]+\]\([^)]+\)|\|[^\n]+\|)/m.test(text);
    if (!hasMarkdown) return fallback;
    try {
      const parsed = await this.request({
        "@type": "parseMarkdown",
        text: fallback,
      });
      return parsed["@type"] === "formattedText" && typeof parsed.text === "string"
        ? {
            "@type": "formattedText",
            text: parsed.text,
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          }
        : fallback;
    } catch {
      return fallback;
    }
  }

  async sendMessage(input: SendMessageInput) {
    const text = await this.formattedTextInput(input.text);
    const response = await this.request({
      "@type": "sendMessage",
      chat_id: numericId(input.chatId),
      topic_id: null,
      reply_to: input.replyToMessageId
        ? {
            "@type": "inputMessageReplyToMessage",
            message_id: numericId(input.replyToMessageId),
            quote: null,
            checklist_task_id: 0,
          }
        : null,
      options: null,
      reply_markup: null,
      input_message_content: inputMessageText(text, input.clearDraft !== false),
    });
    if (response["@type"] === "message") this.emitMessage(response);
  }

  async editMessage(input: EditMessageInput) {
    const text = await this.formattedTextInput(input.text);
    const response = await this.request({
      "@type": "editMessageText",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      reply_markup: null,
      input_message_content: inputMessageText(text, false),
    });
    if (response["@type"] === "message") this.emitMessage(response);
  }

  async deleteMessage(input: DeleteMessageInput) {
    await this.request({
      "@type": "deleteMessages",
      chat_id: numericId(input.chatId),
      message_ids: [numericId(input.messageId)],
      revoke: input.revoke,
    });
  }

  async forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult> {
    const messageIds = [...new Set(input.messageIds.map(numericId))]
      .sort((left, right) => left - right);
    if (messageIds.length === 0) throw new Error("请选择要转发的消息");
    if (messageIds.length > 100) throw new Error("单次最多转发 100 条消息");
    const response = await this.request({
      "@type": "forwardMessages",
      chat_id: numericId(input.toChatId),
      topic_id: null,
      from_chat_id: numericId(input.fromChatId),
      message_ids: messageIds,
      options: null,
      send_copy: false,
      remove_caption: false,
    });
    const forwarded = Array.isArray(response.messages) ? response.messages : [];
    const failedMessageIds: string[] = [];
    let forwardedCount = 0;
    for (const [index, messageId] of messageIds.entries()) {
      const message = asTdObject(forwarded[index]);
      if (message?.["@type"] === "message") {
        this.emitMessage(message);
        forwardedCount += 1;
      } else {
        failedMessageIds.push(String(messageId));
      }
    }
    return { forwardedCount, failedMessageIds };
  }

  async setChatDraft(input: SetChatDraftInput) {
    const hasDraft = input.text.length > 0 || Boolean(input.replyToMessageId);
    await this.request({
      "@type": "setChatDraftMessage",
      chat_id: numericId(input.chatId),
      topic_id: null,
      draft_message: hasDraft
        ? {
            "@type": "draftMessage",
            reply_to: input.replyToMessageId
              ? {
                  "@type": "inputMessageReplyToMessage",
                  message_id: numericId(input.replyToMessageId),
                  quote: null,
                  checklist_task_id: 0,
                }
              : null,
            date: Math.floor(Date.now() / 1000),
            content: {
              "@type": "draftMessageContentText",
              text: { "@type": "formattedText", text: input.text, entities: [] },
              link_preview_options: null,
            },
            effect_id: 0,
            suggested_post_info: null,
          }
        : null,
    });
  }

  async downloadFile(fileId: number, fileName: string) {
    this.pendingDownloads.set(fileId, fileName);
    try {
      const cachedDownload = this.fileDownloads.get(fileId);
      if (cachedDownload) {
        this.fileDownloads.promote(fileId);
        await cachedDownload;
        return;
      }
      const file = await this.request({
        "@type": "downloadFile",
        file_id: fileId,
        priority: 24,
        offset: 0,
        limit: 0,
        synchronous: false,
      });
      this.updateFile(file);
    } catch (error) {
      const cancelled = !this.pendingDownloads.has(fileId);
      this.pendingDownloads.delete(fileId);
      if (cancelled) return;
      throw error;
    }
  }

  async cancelFileDownload(fileId: number) {
    this.pendingDownloads.delete(fileId);
    this.fileDownloads.cancel(fileId);
    await this.request({
      "@type": "cancelDownloadFile",
      file_id: fileId,
      only_if_pending: false,
    });
  }

  async openFile(sourcePath: string) {
    await invoke("telegram_open_cached_file", { sourcePath });
  }

  async saveFileAs(sourcePath: string, fileName: string) {
    return invoke<boolean>("telegram_save_cached_file_as", { sourcePath, fileName });
  }

  async openDownloadDirectory() {
    await invoke("telegram_open_download_directory");
  }

  cacheFile(fileId: number, priority = 16) {
    return this.fileDownloads.cache(fileId, priority);
  }

  async streamFile({ fileId, size, mimeType }: StreamFileInput) {
    await invoke("telegram_register_media_stream", {
      fileId,
      size,
      mimeType: mimeType ?? "video/mp4",
    });
    return convertFileSrc(String(fileId), "notgram-media");
  }

  async retryMessage(chatId: string, messageId: string) {
    const response = await this.request({
      "@type": "resendMessages",
      chat_id: numericId(chatId),
      message_ids: [numericId(messageId)],
      quote: null,
      paid_message_star_count: 0,
    });
    for (const message of asTdObjects(response.messages)) this.emitMessage(message);
  }

  async sendFile(input: SendFileInput) {
    return this.requestPreparedFile(input.chatId);
  }

  async cancelFileUpload(chatId: string, messageId: string) {
    await this.request({
      "@type": "deleteMessages",
      chat_id: numericId(chatId),
      message_ids: [numericId(messageId)],
      revoke: true,
    });
  }

  async markChatRead(chatId: string) {
    const messages = [...(this.rawMessages.get(chatId)?.values() ?? [])];
    const messageIds = messages
      .filter((message) => message.is_outgoing !== true)
      .map((message) => tdNumber(message.id))
      .filter((id): id is number => id !== undefined);
    if (messageIds.length === 0) return;

    await this.request({
      "@type": "viewMessages",
      chat_id: numericId(chatId),
      message_ids: messageIds,
      source: { "@type": "messageSourceChatHistory" },
      force_read: true,
    });
  }

  private async loadNextHistoryPage(
    chatId: string,
    targetCount: number,
  ): Promise<ChatHistoryPage> {
    const rawMessages: TdObject[] = [];
    const result = await loadHistoryWindow({
      chatId,
      targetCount,
      cursor: this.historyCursors.get(chatId) ?? 0,
      knownMessages: this.rawMessages.get(chatId) ?? new Map<string, TdObject>(),
      request: (request) => this.request(request),
      emitMessage: (message) => rawMessages.push(message),
      onCursor: (cursor) => this.historyCursors.set(chatId, cursor),
    });
    this.emitMessages(rawMessages);
    if (result.exhausted) this.exhaustedHistories.add(chatId);

    return {
      loadedCount: result.loadedCount,
      hasMore: !this.exhaustedHistories.has(chatId),
      messageIds: result.messageIds,
    };
  }

  private async request(request: TdObject) {
    return this.requestBroker.request(request);
  }

  private async requestPreparedFile(chatId: string) {
    return this.requestBroker.requestPreparedFile(chatId, (error) => {
      this.listener?.({ type: "sync.error", message: error.message, fatal: false });
    });
  }

  private async applyProxy(settings: ProxySettings) {
    const endpoint = effectiveProxy(settings);
    if (!endpoint) {
      await this.request({ "@type": "disableProxy" });
      return;
    }

    const current = await this.request({ "@type": "getProxies" });
    const existing = asTdObjects(current.proxies).find((added) => {
      const proxy = asTdObject(added.proxy);
      return proxy ? sameProxy(proxy, endpoint) : false;
    });
    const proxyId = tdNumber(existing?.id);
    if (proxyId !== undefined) {
      await this.request({ "@type": "enableProxy", proxy_id: proxyId });
      return;
    }
    await this.request({
      "@type": "addProxy",
      proxy: proxyValue(endpoint),
      enable: true,
      comment: "Notgram",
    });
  }

  private handleUpdate(update: TdObject) {
    if (this.requestBroker.settle(update)) return;
    routeTdUpdate(update, this.updateHandlers);
  }

  private handleAuthorizationUpdate(update: TdObject) {
    const state = asTdObject(update.authorization_state);
    if (!state) return;
    const mapped = mapAuthorizationState(state);
    this.listener?.({ type: "authorization.changed", state: mapped });
    if (mapped.kind === "ready") this.startBootstrap();
    if (mapped.kind === "closing" || mapped.kind === "closed") {
      this.emitConnectionStatus("offline");
    }
  }

  private handleConnectionUpdate(update: TdObject) {
    const state = tdConnectionState(update);
    const status = mapTdConnectionStatus(state);
    if (!status) return;

    this.connectingThroughProxy = state?.["@type"] === "connectionStateConnectingToProxy";
    if (this.proxyConnectionTimer) globalThis.clearTimeout(this.proxyConnectionTimer);
    this.proxyConnectionTimer = undefined;
    this.emitConnectionStatus(status);

    if (this.connectingThroughProxy) {
      this.proxyConnectionTimer = globalThis.setTimeout(() => {
        this.proxyConnectionTimer = undefined;
        if (this.connectingThroughProxy) this.emitConnectionStatus("proxyError");
      }, 15_000);
    }
  }

  private emitConnectionStatus(status: ConnectionStatus) {
    if (status !== "connecting") this.connectingThroughProxy = false;
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.listener?.({ type: "connection.changed", status });
  }

  private startBootstrap() {
    if (this.bootstrapPromise) return;
    this.emitConnectionStatus("syncing");
    this.bootstrapPromise = this.bootstrap()
      .then(() => {
        this.finishInitialChatSync();
        if (this.connectionStatus === "syncing") this.emitConnectionStatus("online");
      })
      .catch((error) => {
        this.finishInitialChatSync();
        this.listener?.({
          type: "sync.error",
          message: error instanceof Error ? error.message : "无法同步 Telegram 数据",
        });
      });
  }

  private async bootstrap() {
    const me = await this.request({ "@type": "getMe" });
    this.currentUserId = tdId(me.id);
    this.upsertUser(me);
    if (this.currentUserId) {
      this.listener?.({ type: "currentUser.changed", userId: this.currentUserId });
    }

    this.emitFolders();
    await this.loadChatList(listObject("chatListMain"), 100);
  }

  private async loadChatList(chatList: TdObject, limit: number): Promise<ChatListPage> {
    const key = chatListKey(chatList);
    const existing = this.chatListLoads.get(key);
    if (existing) return existing;
    const load = this.fetchChatList(chatList, limit)
      .finally(() => this.chatListLoads.delete(key));
    this.chatListLoads.set(key, load);
    return load;
  }

  private async fetchChatList(chatList: TdObject, limit: number): Promise<ChatListPage> {
    const key = chatListKey(chatList);
    if (!this.exhaustedChatLists.has(key)) {
      try {
        await this.request({ "@type": "loadChats", chat_list: chatList, limit });
      } catch (error) {
        if (!(error instanceof Error) || !/(all chats are loaded|404)/i.test(error.message)) {
          throw error;
        }
        this.exhaustedChatLists.add(key);
      }
    }

    const previousCount = this.chatListCounts.get(key) ?? 0;
    const requestedCount = previousCount + limit;
    const result = await this.request({
      "@type": "getChats",
      chat_list: chatList,
      limit: requestedCount,
    });
    const ids = Array.isArray(result.chat_ids) ? result.chat_ids.map(tdId).filter(Boolean) : [];
    this.chatListCounts.set(key, Math.max(previousCount, ids.length));
    await Promise.all(
      ids.map(async (id) => this.upsertChat(await this.request({
        "@type": "getChat",
        chat_id: numericId(id),
      }))),
    );
    return {
      loadedCount: Math.max(0, ids.length - previousCount),
      hasMore: !this.exhaustedChatLists.has(key),
    };
  }

  private updateChatFolders(update: TdObject) {
    this.rawFolderInfos = asTdObjects(update.chat_folders);
    this.mainChatListPosition = tdNumber(update.main_chat_list_position) ?? 0;
    this.emitFolders();
  }

  private emitFolders() {
    this.listener?.({
      type: "folders.replaced",
      folders: mapTdChatFolders(this.rawFolderInfos, this.mainChatListPosition),
    });
  }

  private async loadUser(userId: string) {
    let raw = this.rawUsers.get(userId);
    if (!raw) {
      raw = await this.request({ "@type": "getUser", user_id: numericId(userId) });
      this.upsertUser(raw);
    }
    return mapTdUser(raw);
  }

  private async loadUserProfile(
    userId: string,
    kind: "self" | "user",
  ): Promise<ChatProfile> {
    const [user, full] = await Promise.all([
      this.loadUser(userId),
      this.request({ "@type": "getUserFullInfo", user_id: numericId(userId) }),
    ]);
    if (!user) throw new Error("TDLib 未返回用户资料");
    const bio = profileText(full.bio);
    return {
      id: `user:${user.id}`,
      kind,
      userId: user.id,
      title: user.displayName,
      avatar: user.avatar,
      statusLabel: user.presence === "online" ? "在线" : user.lastSeenLabel ?? "离线",
      bio: bio || undefined,
      members: [],
      canViewMembers: false,
      groupInCommonCount: tdNumber(full.group_in_common_count),
    };
  }

  private async loadProfileMembers(values: TdObject[]) {
    const details = values.flatMap((member) => {
      const sender = asTdObject(member.member_id);
      const userId = sender?.["@type"] === "messageSenderUser"
        ? tdId(sender.user_id)
        : "";
      return userId ? [{ userId, role: profileMemberRole(member.status) }] : [];
    });
    const users = await Promise.all(details.map(({ userId }) => this.loadUser(userId)));
    return details.flatMap((detail, index) => {
      const user = users[index];
      return user ? [{ user, role: detail.role }] : [];
    });
  }

  private upsertUser(raw?: TdObject) {
    if (!raw) return;
    const id = tdId(raw.id);
    const user = mapTdUser(raw);
    if (!id || !user) return;
    this.rawUsers.set(id, raw);
    this.listener?.({ type: "user.upsert", user });
  }

  private updateUserStatus(update: TdObject) {
    const id = tdId(update.user_id);
    const current = this.rawUsers.get(id);
    if (current) this.upsertUser({ ...current, status: update.status });
  }

  private upsertChat(raw?: TdObject) {
    if (!raw) return;
    const id = tdId(raw.id);
    if (!id) return;
    this.rawChats.set(id, raw);
    this.emitChat(raw);
  }

  private folderName(title: string): TdObject {
    const normalized = title.trim();
    if ([...normalized].length < 1 || [...normalized].length > 12 || /[\r\n]/.test(normalized)) {
      throw new Error("文件夹名称需要包含 1 至 12 个字符");
    }
    return {
      "@type": "chatFolderName",
      text: formattedTextObject(normalized),
      animate_custom_emoji: false,
    };
  }

  private newChatFolder(title: string, includedChatIds: number[]): TdObject {
    return {
      "@type": "chatFolder",
      name: this.folderName(title),
      icon: { "@type": "chatFolderIcon", name: "Custom" },
      color_id: -1,
      is_shareable: false,
      pinned_chat_ids: [],
      included_chat_ids: includedChatIds,
      excluded_chat_ids: [],
      exclude_muted: false,
      exclude_read: false,
      exclude_archived: false,
      include_contacts: false,
      include_non_contacts: false,
      include_bots: false,
      include_groups: false,
      include_channels: false,
    };
  }

  private folderChatIds(value: unknown) {
    return Array.isArray(value)
      ? value.map((id) => Number(id)).filter(Number.isSafeInteger)
      : [];
  }

  private upsertFolderInfo(info: TdObject): ChatFolder {
    const id = tdNumber(info.id);
    if (id === undefined) throw new Error("TDLib 未返回文件夹标识");
    this.rawFolderInfos = [
      ...this.rawFolderInfos.filter((item) => tdNumber(item.id) !== id),
      info,
    ];
    this.emitFolders();
    const folder = mapTdChatFolders([info]).find((item) => item.id === `folder:${id}`);
    if (!folder) throw new Error("TDLib 未返回文件夹资料");
    return folder;
  }

  private async refreshChat(chatId: string) {
    const raw = await this.request({
      "@type": "getChat",
      chat_id: numericId(chatId),
    });
    this.upsertChat(raw);
    return raw;
  }

  private emitChat(raw: TdObject) {
    const chat = mapTdChat(raw, this.currentUserId);
    if (chat && !this.initialChatSyncPending) {
      this.listener?.({ type: "chat.upsert", chat });
    }
  }

  private finishInitialChatSync() {
    if (!this.initialChatSyncPending) return;
    this.initialChatSyncPending = false;
    const chats: Chat[] = [];
    for (const raw of this.rawChats.values()) {
      const chat = mapTdChat(raw, this.currentUserId);
      if (chat) chats.push(chat);
    }
    this.listener?.({ type: "chats.upserted", chats });
    const drafts = [];
    const draftChatIds: string[] = [];
    for (const raw of this.rawChats.values()) {
      const chatId = tdId(raw.id);
      if (!chatId) continue;
      if (raw.draft_message === null || raw.draft_message === undefined) {
        draftChatIds.push(chatId);
        continue;
      }
      const draft = mapTdChatDraft(chatId, raw.draft_message);
      if (draft) {
        drafts.push(draft);
        draftChatIds.push(chatId);
      }
    }
    this.listener?.({ type: "drafts.replaced", drafts, chatIds: draftChatIds });
  }

  private emitDraft(chatIdValue: unknown, value: unknown) {
    const chatId = tdId(chatIdValue);
    if (!chatId) return;
    if (value === null || value === undefined) {
      this.listener?.({ type: "chat.draftChanged", chatId, draft: undefined });
      return;
    }
    const draft = mapTdChatDraft(chatId, value);
    if (draft) this.listener?.({ type: "chat.draftChanged", chatId, draft });
  }

  private patchChat(idValue: unknown, patch: TdObject) {
    const id = tdId(idValue);
    const current = this.rawChats.get(id);
    if (current) this.upsertChat({ ...current, ...patch });
  }

  private patchChatWithPositions(
    idValue: unknown,
    patch: TdObject,
    positionsValue: unknown,
  ) {
    const id = tdId(idValue);
    const current = this.rawChats.get(id);
    if (!current) return;
    const positions = asTdObjects(positionsValue);
    const incomingLists = new Set(positions.map((position) => chatListKey(position.list)));
    const stablePinnedPositions = asTdObjects(current.positions).filter((position) =>
      position.is_pinned === true && !incomingLists.has(chatListKey(position.list)),
    );
    this.upsertChat({
      ...current,
      ...patch,
      // Last-message and draft updates can briefly omit a pinned list position.
      // Keep it until updateChatPosition explicitly replaces or removes that list.
      positions: positions.length > 0
        ? [...positions, ...stablePinnedPositions]
        : current.positions,
    });
  }

  private updateChatPosition(update: TdObject) {
    const id = tdId(update.chat_id);
    const current = this.rawChats.get(id);
    const position = asTdObject(update.position);
    if (!current || !position) return;
    const incomingKey = chatListKey(position.list);
    const positions = asTdObjects(current.positions).filter(
      (item) => chatListKey(item.list) !== incomingKey,
    );
    if ((tdNumber(position.order) ?? 0) !== 0) positions.push(position);
    this.upsertChat({ ...current, positions });
  }

  private updateChatList(update: TdObject, added: boolean) {
    const id = tdId(update.chat_id);
    const current = this.rawChats.get(id);
    const list = asTdObject(update.chat_list);
    if (!current || !list) return;
    const listKey = chatListKey(list);
    const lists = asTdObjects(current.chat_lists).filter(
      (item) => chatListKey(item) !== listKey,
    );
    if (added) lists.push(list);
    this.upsertChat({ ...current, chat_lists: lists });
  }

  private updateFile(file?: TdObject) {
    const fileId = tdNumber(file?.id);
    if (!file || fileId === undefined) return;
    const local = asTdObject(file.local);
    this.fileDownloads.handleFile(
      fileId,
      local?.is_downloading_completed === true,
      local?.is_downloading_active === true,
    );

    for (const raw of [...this.rawChats.values()]) {
      const photo = asTdObject(raw.photo);
      const small = asTdObject(photo?.small);
      if (tdNumber(small?.id) !== fileId || !photo) continue;
      this.upsertChat({ ...raw, photo: { ...photo, small: file } });
    }

    for (const raw of [...this.rawUsers.values()]) {
      const profilePhoto = asTdObject(raw.profile_photo);
      const small = asTdObject(profilePhoto?.small);
      if (tdNumber(small?.id) !== fileId || !profilePhoto) continue;
      this.upsertUser({
        ...raw,
        profile_photo: { ...profilePhoto, small: file },
      });
    }

    for (const chatMessages of this.rawMessages.values()) {
      for (const raw of [...chatMessages.values()]) {
        const replaced = replaceFileReference(raw, fileId, file);
        if (replaced.changed) this.emitMessage(asTdObject(replaced.value));
      }
    }

    const fileName = this.pendingDownloads.get(fileId);
    if (
      fileName &&
      local?.is_downloading_completed === true &&
      typeof local.path === "string" &&
      local.path
    ) {
      this.pendingDownloads.delete(fileId);
      void invoke<string>("telegram_save_downloaded_file", {
        sourcePath: local.path,
        fileName,
      }).catch((error) => {
        this.listener?.({
          type: "sync.error",
          message: error instanceof Error ? error.message : "无法保存下载文件",
        });
      });
    }
  }

  private emitMessage(raw?: TdObject) {
    if (!raw) return;
    const message = this.mapMessage(raw);
    if (!message) return;
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.listener?.({ type: "message.upsert", message });
    this.ensureReplyContent(raw);
  }

  private emitMessages(rawMessages: TdObject[]) {
    const messages = new Map<string, Message>();
    const uniqueRawMessages = new Map<string, TdObject>();
    for (const raw of rawMessages) {
      const message = this.mapMessage(raw);
      if (!message) continue;
      const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
      chatMessages.set(message.id, raw);
      this.rawMessages.set(message.chatId, chatMessages);
      const key = `${message.chatId}:${message.id}`;
      messages.set(key, message);
      uniqueRawMessages.set(key, raw);
    }
    if (messages.size > 0) {
      this.listener?.({ type: "messages.upserted", messages: [...messages.values()] });
    }
    for (const raw of uniqueRawMessages.values()) this.ensureReplyContent(raw);
  }

  private mapMessage(raw: TdObject) {
    const message = mapTdMessage(raw);
    if (!message?.outgoing || message.delivery !== "sent") return message;
    const lastReadId = tdId(
      this.rawChats.get(message.chatId)?.last_read_outbox_message_id,
    );
    if (!lastReadId || !messageIdAtMost(message.id, lastReadId)) return message;
    return { ...message, delivery: "read" as const };
  }

  private ensureReplyContent(raw: TdObject) {
    const chatId = tdId(raw.chat_id);
    const messageId = tdId(raw.id);
    const reply = asTdObject(raw.reply_to);
    const repliedMessageId = tdId(reply?.message_id);
    if (
      !chatId ||
      !messageId ||
      reply?.["@type"] !== "messageReplyToMessage" ||
      !repliedMessageId ||
      repliedMessageId === "0" ||
      asTdObject(reply.content)
    ) {
      return;
    }

    const quote = asTdObject(asTdObject(reply.quote)?.text);
    if (typeof quote?.text === "string" && quote.text.trim()) return;

    const repliedChatId = tdId(reply.chat_id) || chatId;
    const key = `${chatId}:${messageId}:${repliedChatId}:${repliedMessageId}`;
    if (this.pendingReplyHydrations.has(key) || this.unavailableReplyHydrations.has(key)) {
      return;
    }

    const token = Symbol(key);
    this.pendingReplyHydrations.set(key, token);
    void Promise.resolve()
      .then(async () => {
        const current = this.rawMessages.get(chatId)?.get(messageId);
        const currentReply = asTdObject(current?.reply_to);
        if (
          !current ||
          currentReply?.["@type"] !== "messageReplyToMessage" ||
          asTdObject(currentReply.content)
        ) {
          return;
        }

        const currentRepliedMessageId = tdId(currentReply.message_id);
        const currentRepliedChatId = tdId(currentReply.chat_id) || chatId;
        if (
          currentRepliedMessageId !== repliedMessageId ||
          currentRepliedChatId !== repliedChatId
        ) {
          return;
        }

        const known = this.rawMessages.get(repliedChatId)?.get(repliedMessageId);
        const replied = known ?? await this.request({
          "@type": "getRepliedMessage",
          chat_id: numericId(chatId),
          message_id: numericId(messageId),
        });
        if (replied["@type"] !== "message" || !asTdObject(replied.content)) {
          this.unavailableReplyHydrations.add(key);
          return;
        }

        const latest = this.rawMessages.get(chatId)?.get(messageId);
        const latestReply = asTdObject(latest?.reply_to);
        if (!latest || latestReply?.["@type"] !== "messageReplyToMessage") return;
        if (
          tdId(latestReply.message_id) !== repliedMessageId ||
          (tdId(latestReply.chat_id) || chatId) !== repliedChatId
        ) {
          return;
        }

        this.emitMessage({
          ...latest,
          reply_to: {
            ...latestReply,
            chat_id: replied.chat_id,
            message_id: replied.id,
            origin_send_date: replied.date,
            content: replied.content,
          },
        });
      })
      .catch((error) => {
        if (error instanceof Error && /\b404\b/.test(error.message)) {
          this.unavailableReplyHydrations.add(key);
        }
      })
      .finally(() => {
        if (this.pendingReplyHydrations.get(key) === token) {
          this.pendingReplyHydrations.delete(key);
        }
      });
  }

  private replaceSentMessage(update: TdObject) {
    const raw = asTdObject(update.message);
    if (!raw) return;
    const chatId = tdId(raw.chat_id);
    const oldId = tdId(update.old_message_id);
    if (chatId && oldId) {
      this.rawMessages.get(chatId)?.delete(oldId);
      this.listener?.({ type: "message.remove", chatId, messageId: oldId });
    }
    this.emitMessage(raw);
  }

  private updateMessageContent(update: TdObject) {
    this.patchMessage(update.chat_id, update.message_id, {
      content: update.new_content,
    });
  }

  private patchMessage(chatIdValue: unknown, messageIdValue: unknown, patch: TdObject) {
    const chatId = tdId(chatIdValue);
    const messageId = tdId(messageIdValue);
    const raw = this.rawMessages.get(chatId)?.get(messageId);
    if (raw) this.emitMessage({ ...raw, ...patch });
  }

  private updateReadOutbox(update: TdObject) {
    const chatId = tdId(update.chat_id);
    const lastReadId = tdId(update.last_read_outbox_message_id);
    const chat = this.rawChats.get(chatId);
    if (chat && lastReadId) {
      this.rawChats.set(chatId, {
        ...chat,
        last_read_outbox_message_id: lastReadId,
      });
    }
    for (const raw of this.rawMessages.get(chatId)?.values() ?? []) {
      const message = this.mapMessage(raw);
      if (message?.outgoing && message.delivery === "read") {
        this.listener?.({ type: "message.upsert", message });
      }
    }
  }

  private deleteMessages(update: TdObject) {
    const chatId = tdId(update.chat_id);
    const ids = Array.isArray(update.message_ids) ? update.message_ids.map(tdId) : [];
    if (update.from_cache === true && update.is_permanent !== true) return;
    for (const messageId of ids) {
      this.rawMessages.get(chatId)?.delete(messageId);
      this.listener?.({ type: "message.remove", chatId, messageId });
    }
  }

  private resetSessionState() {
    if (this.proxyConnectionTimer) globalThis.clearTimeout(this.proxyConnectionTimer);
    this.proxyConnectionTimer = undefined;
    this.connectingThroughProxy = false;
    this.connectionStatus = undefined;
    this.rawChats.clear();
    this.rawUsers.clear();
    this.rawMessages.clear();
    this.exhaustedHistories.clear();
    this.historyCursors.clear();
    this.historyLoads.clear();
    this.pendingReplyHydrations.clear();
    this.unavailableReplyHydrations.clear();
    this.chatListLoads.clear();
    this.chatListCounts.clear();
    this.exhaustedChatLists.clear();
    this.fileDownloads.reset();
    this.pendingDownloads.clear();
    this.rawFolderInfos = [];
    this.mainChatListPosition = 0;
    this.currentUserId = undefined;
    this.bootstrapPromise = undefined;
    this.initialChatSyncPending = true;
  }

}
