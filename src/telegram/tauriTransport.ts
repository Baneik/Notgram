import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asTdObject,
  asTdObjects,
  mapTdChat,
  mapTdChatDraft,
  mapTdChatFolders,
  mapTdMessage,
  messageSenderId,
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
import {
  TdRequestBroker,
  type PreparedPastedAttachment,
} from "./tdRequestBroker";
import { TauriAccountStorage } from "./tauriAccountStorage";
import {
  chatListKey,
  chatListObject,
  chatFolderNumericId,
  effectiveProxy,
  formattedTextObject,
  listObject,
  mapAuthorizationState,
  forumTopicObject,
  numericId,
  proxyValue,
  sameProxy,
} from "./tdlibRequests";
import { routeTdUpdate, type TdUpdateHandlers } from "./tdUpdateRouter";
import { TauriSearchService } from "./tauriSearchService";
import { TauriForumTopicService } from "./tauriForumTopicService";
import {
  PROFILE_ADMIN_PAGE_SIZE,
  PROFILE_MEMBER_PAGE_SIZE,
  TauriProfileService,
  profileField,
} from "./tauriProfileService";
import {
  TauriMessageMediaService,
  type PendingDownload,
} from "./tauriMessageMediaService";
import {
  getActiveConversationTraceId,
  logPerformance,
} from "../utils/performanceMonitor";
import type { TelegramConnectOptions, TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
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
  InlineQueryResult,
  BlockedSender,
  ChatReportOptions,
  ReportChatInput,
  DeviceSession,
  PrivacyRule,
  PrivacySettingKey,
  ChatMemberStatusInput,
  ChatPermissions,
  ManagedChatMember,
  ChatAdminRights,
  ChatFolder,
  ChatProfile,
  ChatProfileMembersPage,
  ChatHistoryPage,
  ChatListPage,
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
  Message,
  MessagePermissions,
  PinMessageInput,
  ConnectionStatus,
  CreateChatInput,
  ProxySettings,
  SendEmojiAssetInput,
  SendFileInput,
  SendFilesInput,
  SendMessageInput,
  SetChatDraftInput,
  SetChatMessageAutoDeleteTimeInput,
  SetMessageReactionInput,
  SetPollAnswerInput,
  StorageSettings,
  StickerSet,
  StickerSetSummary,
  StreamFileInput,
  TelegramSnapshot,
  TelegramAccount,
  TelegramAccountState,
  TelegramLinkTarget,
  UpdateCurrentUserProfileInput,
  User,
} from "./types";
import {
  CHAT_ADMIN_FIELDS,
  CHAT_PERMISSION_FIELDS,
  DEFAULT_CHAT_ADMIN_RIGHTS,
  DEFAULT_CHAT_PERMISSIONS,
  chatMemberTagError,
  deriveChatManagementCapabilities,
  managedMemberStatusFromTd,
  mapChatAdminRightsFromTd,
  mapChatPermissionsFromTd,
} from "./chatManagement";
import {
  knownUnsupportedTelegramLink,
  unsupportedTelegramLink,
} from "./telegramLinks";

interface RuntimeStatus {
  backend: string;
  linked: boolean;
  state: string;
  credentialsConfigured: boolean;
  libraryPath?: string;
  searchedPaths: string[];
  error?: string;
  logPath?: string;
  performanceLogPath?: string;
}

const PROXY_RECOVERY_DELAYS_MS = [8_000, 15_000, 30_000, 60_000] as const;
const PROXY_ERROR_AFTER_RECOVERY_ATTEMPTS = 3;

const chatPermissionsForTemplate = (template: CreateChatInput["permissionTemplate"]): TdObject => {
  const open = template !== "restricted";
  return {
    "@type": "chatPermissions",
    can_send_basic_messages: true,
    can_send_audios: open,
    can_send_documents: open,
    can_send_photos: open,
    can_send_videos: open,
    can_send_video_notes: open,
    can_send_voice_notes: open,
    can_send_polls: open,
    can_send_other_messages: open,
    can_add_link_previews: open,
    can_change_info: false,
    can_invite_users: open,
    can_pin_messages: false,
    can_create_topics: false,
  };
};


const chatPermissionsObject = (value: ChatPermissions): TdObject => Object.fromEntries([
  ["@type", "chatPermissions"],
  ...CHAT_PERMISSION_FIELDS.map(([key, field]) => [field, value[key]]),
]);

const chatAdminRightsObject = (value: ChatAdminRights): TdObject => Object.fromEntries([
  ["@type", "chatAdministratorRights"],
  ...CHAT_ADMIN_FIELDS.map(([key, field]) => [field, value[key]]),
]);

const unixDate = (value: unknown) => {
  const seconds = tdNumber(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
};

const mapChatInviteLink = (value: unknown): ChatInviteLink | undefined => {
  const raw = asTdObject(value);
  const inviteLink = typeof raw?.invite_link === "string" ? raw.invite_link : "";
  if (!raw || !inviteLink) return undefined;
  const pricing = asTdObject(raw.subscription_pricing);
  return {
    inviteLink,
    name: typeof raw.name === "string" ? raw.name : "邀请链接",
    creatorUserId: tdId(raw.creator_user_id) || undefined,
    createdAt: unixDate(raw.date) ?? new Date(0).toISOString(),
    editedAt: unixDate(raw.edit_date),
    expiresAt: unixDate(raw.expiration_date),
    memberLimit: tdNumber(raw.member_limit) ?? 0,
    memberCount: tdNumber(raw.member_count) ?? 0,
    expiredMemberCount: tdNumber(raw.expired_member_count) ?? 0,
    pendingJoinRequestCount: tdNumber(raw.pending_join_request_count) ?? 0,
    createsJoinRequest: raw.creates_join_request === true,
    isPrimary: raw.is_primary === true,
    isRevoked: raw.is_revoked === true,
    subscriptionStars: pricing ? tdNumber(pricing.star_count) : undefined,
    subscriptionPeriod: pricing ? tdNumber(pricing.period) : undefined,
  };
};

const PRIVACY_SETTING_TYPES: Record<PrivacySettingKey, string> = {
  showStatus: "userPrivacySettingShowStatus",
  showPhoneNumber: "userPrivacySettingShowPhoneNumber",
  showProfilePhoto: "userPrivacySettingShowProfilePhoto",
  allowCalls: "userPrivacySettingAllowCalls",
  allowChatInvites: "userPrivacySettingAllowChatInvites",
  allowSecretChats: "userPrivacySettingAllowSecretChats",
};

const mapSession = (value: unknown): DeviceSession | undefined => {
  const raw = asTdObject(value);
  const id = tdId(raw?.id);
  if (!raw || !id) return undefined;
  return { id, isCurrent: raw.is_current === true, isPasswordPending: raw.is_password_pending === true, isUnconfirmed: raw.is_unconfirmed === true, canAcceptSecretChats: raw.can_accept_secret_chats === true, canAcceptCalls: raw.can_accept_calls === true, applicationName: typeof raw.application_name === "string" ? raw.application_name : "Telegram", applicationVersion: typeof raw.application_version === "string" ? raw.application_version : "", deviceModel: typeof raw.device_model === "string" ? raw.device_model : "", platform: typeof raw.platform === "string" ? raw.platform : "", systemVersion: typeof raw.system_version === "string" ? raw.system_version : "", loggedInAt: unixDate(raw.log_in_date) ?? new Date(0).toISOString(), lastActiveAt: unixDate(raw.last_active_date) ?? new Date(0).toISOString(), ipAddress: typeof raw.ip_address === "string" ? raw.ip_address : undefined, location: typeof raw.location === "string" ? raw.location : undefined };
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

const collectFileIds = (value: unknown, result: Set<number>) => {
  if (Array.isArray(value)) {
    for (const item of value) collectFileIds(item, result);
    return;
  }
  const object = asTdObject(value);
  if (!object) return;
  const id = tdNumber(object.id);
  if (id !== undefined && (
    object["@type"] === "file" ||
    ("local" in object && "remote" in object)
  )) {
    result.add(id);
  }
  for (const item of Object.values(object)) collectFileIds(item, result);
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
  private unlistenUpdates?: UnlistenFn;
  private unlistenError?: UnlistenFn;
  private requestBroker = new TdRequestBroker();
  private rawChats = new Map<string, TdObject>();
  private rawUsers = new Map<string, TdObject>();
  private searchService = new TauriSearchService({
    request: (request) => this.request(request),
    rawChats: this.rawChats,
    rawUsers: this.rawUsers,
    upsertChat: (raw) => this.upsertChat(raw),
    upsertUser: (raw) => this.upsertUser(raw),
    mapChat: (raw) => this.mapChat(raw),
    mapMessage: (raw) => this.mapMessage(raw),
    emitMessages: (rawMessages) => this.emitMessages(rawMessages),
  });
  private forumTopicService = new TauriForumTopicService({
    request: (request) => this.request(request),
    emitMessages: (rawMessages) => this.emitMessages(rawMessages),
    emitForumTopicsChanged: (chatId) => this.emitForumTopicsChanged(chatId),
  });
  private rawBasicGroups = new Map<string, TdObject>();
  private rawSupergroups = new Map<string, TdObject>();
  private profileService = new TauriProfileService({
    request: (request) => this.request(request),
    rawChats: this.rawChats,
    rawUsers: this.rawUsers,
    getCurrentUserId: () => this.currentUserId,
    setCurrentUserId: (userId) => { this.currentUserId = userId; },
    upsertChat: (raw) => this.upsertChat(raw),
    upsertUser: (raw) => this.upsertUser(raw),
    mapChat: (raw) => this.mapChat(raw),
    requestPreparedProfilePhoto: () => this.requestPreparedProfilePhoto(),
  });
  private rawMessages = new Map<string, Map<string, TdObject>>();
  private pendingDownloads = new Map<number, PendingDownload>();
  private rawMessageFileIds = new Map<string, Set<number>>();
  private fileMessageReferences = new Map<number, Set<string>>();
  private exhaustedHistories = new Set<string>();
  private historyCursors = new Map<string, number>();
  private historyLoads = new Map<string, Promise<ChatHistoryPage>>();
  private pendingReplyHydrations = new Map<string, symbol>();
  private unavailableReplyHydrations = new Set<string>();
  private pendingRichMessageHydrations = new Set<string>();
  private unavailableRichMessageHydrations = new Set<string>();
  private richMessageHydrationTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  private richMessageHydrationFailures = new Map<string, number>();
  private pendingSenderChatLoads = new Set<string>();
  private pendingSenderUserLoads = new Set<string>();
  private pendingBotDrafts = new Map<string, string>();
  private chatListLoads = new Map<string, Promise<ChatListPage>>();
  private chatListCounts = new Map<string, number>();
  private chatListIds = new Map<string, Set<string>>();
  private exhaustedChatLists = new Set<string>();
  private fileDownloads = new FileDownloadQueue(
    (request) => this.request(request),
    (file) => this.updateFile(file),
    (fileId) => {
      void this.request({
        "@type": "cancelDownloadFile",
        file_id: fileId,
        only_if_pending: false,
      }).catch(() => undefined);
    },
  );
  private messageMediaService = new TauriMessageMediaService({
    request: (request) => this.request(request),
    rawMessages: this.rawMessages,
    emitMessage: (raw, animateEntrance) => this.emitMessage(raw, animateEntrance),
    emitMessages: (rawMessages) => this.emitMessages(rawMessages),
    mapMessage: (raw) => this.mapMessage(raw),
    ensureReplyContent: (raw) => this.ensureReplyContent(raw),
    patchMessage: (chatId, messageId, patch) => this.patchMessage(chatId, messageId, patch),
    refreshChat: (chatId) => this.refreshChat(chatId),
    fileDownloads: this.fileDownloads,
    pendingDownloads: this.pendingDownloads,
    updateFile: (file) => this.updateFile(file),
    requestPreparedFile: (chatId, topicId) => this.requestPreparedFile(chatId, topicId),
    requestPreparedPastedFiles: (chatId, files, caption, captionEntities, topicId) =>
      this.requestPreparedPastedFiles(chatId, files, caption, captionEntities, topicId),
  });
  private updateHandlers: TdUpdateHandlers = {
    authorization: (update) => this.handleAuthorizationUpdate(update),
    connection: (update) => this.handleConnectionUpdate(update),
    upsertUser: (user) => this.upsertUser(user),
    upsertBasicGroup: (basicGroup) => this.upsertBasicGroup(basicGroup),
    upsertSupergroup: (supergroup) => this.upsertSupergroup(supergroup),
    updateUserStatus: (update) => this.updateUserStatus(update),
    updateChatFolders: (update) => this.updateChatFolders(update),
    upsertChat: (chat) => this.upsertChat(chat),
    emitDraft: (chatId, draft) => this.emitDraft(chatId, draft),
    updateChatAction: (update) => this.updateChatAction(update),
    patchChat: (chatId, patch) => this.patchChat(chatId, patch),
    patchChatWithPositions: (chatId, patch, positions) =>
      this.patchChatWithPositions(chatId, patch, positions),
    updateChatPosition: (update) => this.updateChatPosition(update),
    updateChatList: (update, added) => this.updateChatList(update, added),
    emitMessage: (message, animateEntrance) => this.emitMessage(message, animateEntrance),
    replaceSentMessage: (update) => this.replaceSentMessage(update),
    updateMessageContent: (update) => this.updateMessageContent(update),
    updatePendingMessage: (update) => this.updatePendingMessage(update),
    updatePoll: (update) => this.updatePoll(update),
    patchMessage: (chatId, messageId, patch) =>
      this.patchMessage(chatId, messageId, patch),
    updateReadOutbox: (update) => this.updateReadOutbox(update),
    deleteMessages: (update) => this.deleteMessages(update),
    updateFile: (file) => this.updateFile(file),
    forumTopicsChanged: (chatId) => this.emitForumTopicsChanged(chatId),
  };
  private rawFolderInfos: TdObject[] = [];
  private mainChatListPosition = 0;
  private currentUserId?: string;
  private bootstrapPromise?: Promise<void>;
  private initialChatSyncPending = true;
  private connectionStatus?: ConnectionStatus;
  private settingsOnly = false;
  private proxyConnectionTimer?: ReturnType<typeof setTimeout>;
  private connectingThroughProxy = false;
  private proxyRecoveryAttempt = 0;
  private networkReopenPromise?: Promise<void>;
  private networkOnlineHandler?: () => void;

  async connect(
    listener: TelegramEventListener,
    options: TelegramConnectOptions = {},
  ): Promise<TelegramSnapshot> {
    this.resetSessionState();
    this.settingsOnly = options.settingsOnly === true;
    this.listener = listener;
    this.initialChatSyncPending = true;
    if (typeof window !== "undefined") {
      this.networkOnlineHandler = () => {
        if (!this.listener || this.connectionStatus === "online") return;
        void this.reopenNetworkConnections().catch(() => undefined);
      };
      window.addEventListener("online", this.networkOnlineHandler, { passive: true });
    }
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

    this.unlistenUpdate = await listen<TdObject>("telegram://update", (event) => {
      this.handleUpdateBatch([event.payload]);
    });
    this.unlistenUpdates = await listen<TdObject[]>("telegram://updates", (event) => {
      this.handleUpdateBatch(event.payload);
    });
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
    const authorizationState = await this.request({ "@type": "getAuthorizationState" });
    this.handleAuthorizationUpdate({ authorization_state: authorizationState });

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
      this.unlistenUpdates?.();
      this.unlistenError?.();
      this.unlistenUpdate = undefined;
      this.unlistenUpdates = undefined;
      this.unlistenError = undefined;
      this.requestBroker.rejectAll(new Error("TDLib runtime 已关闭。"));
      this.listener = undefined;
      this.resetSessionState();
    }
  }

  private handleUpdateBatch(updates: TdObject[]) {
    if (updates.length === 0) return;
    const startedAt = performance.now();
    for (const update of updates) this.handleUpdate(update);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= 4 || updates.length >= 32) {
      const traceId = getActiveConversationTraceId();
      let messageUpdateCount = 0;
      let chatUpdateCount = 0;
      let fileUpdateCount = 0;
      let otherUpdateCount = 0;
      for (const update of updates) {
        const type = typeof update["@type"] === "string" ? update["@type"] : "";
        if (type === "updateFile") fileUpdateCount += 1;
        else if (type.startsWith("updateChat")) chatUpdateCount += 1;
        else if (type.includes("Message") || type === "updateNewMessage") messageUpdateCount += 1;
        else otherUpdateCount += 1;
      }
      logPerformance("ui_tdlib_update_batch", {
        startTimeMs: startedAt,
        durationMs,
        batchCount: updates.length,
        traceId,
        duringConversationSwitch: traceId !== undefined,
        messageUpdateCount,
        chatUpdateCount,
        fileUpdateCount,
        otherUpdateCount,
      });
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
    return this.profileService.getCurrentUserProfile();
  }

  async updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<ChatProfile> {
    return this.profileService.updateCurrentUserProfile(input);
  }

  async setCurrentUserAvatar(file?: File): Promise<ChatProfile | undefined> {
    return this.profileService.setCurrentUserAvatar(file);
  }

  async getChatProfile(chatId: string): Promise<ChatProfile> {
    return this.profileService.getChatProfile(chatId);
  }

  async getChatProfileMembers(
    chatId: string,
    offset: number,
    limit = PROFILE_MEMBER_PAGE_SIZE,
  ): Promise<ChatProfileMembersPage> {
    return this.profileService.getChatProfileMembers(chatId, offset, limit);
  }

  async getUserProfile(userId: string): Promise<ChatProfile> {
    return this.profileService.getUserProfile(userId);
  }

  async getContacts() {
    return this.profileService.getContacts();
  }



  async createPrivateChat(userId: string) {
    const raw = await this.request({
      "@type": "createPrivateChat",
      user_id: numericId(userId),
      force: false,
    });
    this.upsertChat(raw);
    const chat = this.mapChat(raw);
    if (!chat) throw new Error("TDLib 未返回私聊");
    return chat;
  }

  async createChat(input: CreateChatInput) {
    const title = profileField(input.title, 128, "名称", true);
    const description = profileField(input.description ?? "", 255, "简介");
    const username = profileField(input.username ?? "", 32, "公开用户名");
    if (input.isPublic && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) {
      throw new Error("公开用户名需包含 5 至 32 个英文字母、数字或下划线，并以字母开头");
    }
    const memberUserIds = [...new Set(input.memberUserIds)];
    if (memberUserIds.length > 200) throw new Error("初始成员不能超过 200 人");
    const numericUserIds = memberUserIds.map(numericId);

    let chatId: string;
    let rawChat: TdObject;
    if (input.kind === "basicGroup") {
      const created = await this.request({
        "@type": "createNewBasicGroupChat",
        user_ids: numericUserIds,
        title,
        message_auto_delete_time: 0,
      });
      chatId = tdId(created.chat_id);
      if (!chatId) throw new Error("TDLib 未返回新群组标识");
      rawChat = await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
    } else {
      rawChat = await this.request({
        "@type": "createNewSupergroupChat",
        title,
        is_forum: false,
        is_channel: input.kind === "channel",
        description,
        location: null,
        message_auto_delete_time: 0,
        for_import: false,
      });
      chatId = tdId(rawChat.id);
      if (!chatId) throw new Error("TDLib 未返回新超级群组标识");
      if (numericUserIds.length > 0) {
        await this.request({
          "@type": "addChatMembers",
          chat_id: numericId(chatId),
          user_ids: numericUserIds,
        });
      }
      const type = asTdObject(rawChat.type);
      const supergroupId = tdId(type?.supergroup_id);
      if (!supergroupId) throw new Error("TDLib 未返回超级群组类型信息");
      if (input.isPublic && username) {
        await this.request({
          "@type": "setSupergroupUsername",
          supergroup_id: numericId(supergroupId),
          username,
        });
      }
      if (input.kind === "supergroup") {
        await this.request({
          "@type": "toggleSupergroupIsAllHistoryAvailable",
          supergroup_id: numericId(supergroupId),
          is_all_history_available: input.historyAvailable !== false,
        });
      }
    }

    if (input.kind !== "channel") {
      await this.request({
        "@type": "setChatPermissions",
        chat_id: numericId(chatId),
        permissions: chatPermissionsForTemplate(input.permissionTemplate),
      });
    }
    if (input.selectPhoto) await this.requestPreparedChatPhoto(chatId);
    rawChat = await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
    const createdType = asTdObject(rawChat.type);
    if (createdType?.["@type"] === "chatTypeBasicGroup") {
      const basicGroupId = tdId(createdType.basic_group_id);
      if (basicGroupId) {
        const basicGroup = await this.request({ "@type": "getBasicGroup", basic_group_id: numericId(basicGroupId) });
        this.upsertBasicGroup(basicGroup);
      }
    } else if (createdType?.["@type"] === "chatTypeSupergroup") {
      const supergroupId = tdId(createdType.supergroup_id);
      if (supergroupId) {
        const supergroup = await this.request({ "@type": "getSupergroup", supergroup_id: numericId(supergroupId) });
        this.upsertSupergroup(supergroup);
      }
    }
    this.upsertChat(rawChat);
    const chat = this.mapChat(rawChat);
    if (!chat) throw new Error("TDLib 未返回已创建的聊天");
    return chat;
  }

  async searchChats(query: string, limit = 50) {
    return this.searchService.searchChats(query, limit);
  }

  async getChatManagement(chatId: string, memberOffset = 0): Promise<ChatManagement> {
    const rawChat = this.rawChats.get(chatId) ?? await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
    this.upsertChat(rawChat);
    const type = asTdObject(rawChat.type);
    if (!type || (type["@type"] !== "chatTypeBasicGroup" && type["@type"] !== "chatTypeSupergroup")) {
      throw new Error("只有群组和频道支持成员管理");
    }
    const isBasic = type["@type"] === "chatTypeBasicGroup";
    const chatType = isBasic
      ? "basicGroup" as const
      : type.is_channel === true ? "channel" as const : "supergroup" as const;
    const groupId = tdId(isBasic ? type.basic_group_id : type.supergroup_id);
    if (!groupId) throw new Error("群组标识无效");
    const group = isBasic
      ? await this.request({ "@type": "getBasicGroup", basic_group_id: numericId(groupId) })
      : await this.request({ "@type": "getSupergroup", supergroup_id: numericId(groupId) });
    if (isBasic) this.upsertBasicGroup(group); else this.upsertSupergroup(group);
    const statusObject = asTdObject(group.status);
    const status = managedMemberStatusFromTd(statusObject);
    const adminRights = status === "administrator"
      ? mapChatAdminRightsFromTd(statusObject?.rights)
      : undefined;
    const capabilities = deriveChatManagementCapabilities(chatType, status, adminRights);
    if (!capabilities.canOpenManagement) throw new Error("当前账号没有群组管理权限");
    const offset = Math.max(0, memberOffset);
    const administratorLabelsPromise = this.request({
      "@type": "getChatAdministrators",
      chat_id: numericId(chatId),
    }).then((result) => Object.fromEntries(asTdObjects(result.administrators).flatMap((raw) => {
      const userId = tdId(raw.user_id);
      if (!userId) return [];
      const customTitle = typeof raw.custom_title === "string" ? raw.custom_title.trim() : "";
      return [[userId, customTitle || (raw.is_owner === true ? "群主" : "管理员")]];
    }))).catch((): Record<string, string> => {
      // Member data remains usable on chats where the administrator list is unavailable.
      return {};
    });
    const fullInfoPromise = isBasic
      ? this.request({ "@type": "getBasicGroupFullInfo", basic_group_id: numericId(groupId) })
      : this.request({ "@type": "getSupergroupFullInfo", supergroup_id: numericId(groupId) });
    const memberValuesPromise = isBasic
      ? fullInfoPromise.then((full) => asTdObjects(full.members).slice(offset, offset + 50))
      : this.request({
          "@type": "getSupergroupMembers",
          supergroup_id: numericId(groupId), filter: null, offset, limit: 50,
        }).then((result) => asTdObjects(result.members));
    const membersPromise = memberValuesPromise.then((values) => this.loadManagedMembers(values));
    const ownershipTransferPromise = capabilities.canTransferOwnership
      ? this.request({ "@type": "canTransferOwnership" })
      : Promise.resolve(undefined);
    const [administratorLabels, full, values, members, transferResult] = await Promise.all([
      administratorLabelsPromise,
      fullInfoPromise,
      memberValuesPromise,
      membersPromise,
      ownershipTransferPromise,
    ]);
    const permissions = rawChat.permissions ? mapChatPermissionsFromTd(rawChat.permissions) : { ...DEFAULT_CHAT_PERMISSIONS };
    const slowModeDelay = tdNumber(full.slow_mode_delay) ?? 0;
    const memberCount = tdNumber(group.member_count) ?? tdNumber(full.member_count);
    let ownershipTransfer;
    if (transferResult) {
      const transferType = transferResult["@type"];
      ownershipTransfer = transferType === "canTransferOwnershipResultOk"
        ? { available: true }
        : {
            available: false,
            ...(transferType === "canTransferOwnershipResultPasswordNeeded" ? { reason: "passwordNeeded" as const } : {}),
            ...(transferType === "canTransferOwnershipResultPasswordTooFresh" ? { reason: "passwordTooFresh" as const } : {}),
            ...(transferType === "canTransferOwnershipResultSessionTooFresh" ? { reason: "sessionTooFresh" as const } : {}),
            ...(tdNumber(transferResult.retry_after) !== undefined ? { retryAfter: tdNumber(transferResult.retry_after) } : {}),
          };
      capabilities.canTransferOwnership = ownershipTransfer.available;
    }
    return {
      chatId,
      members,
      administratorLabels,
      permissions,
      slowModeDelay,
      capabilities,
      ownershipTransfer,
      memberCount,
      memberOffset: offset,
      memberHasMore: values.length === 50 || (memberCount !== undefined && offset + values.length < memberCount),
    };
  }

  async addChatMembers(chatId: string, userIds: string[]): Promise<void> {
    const rawChat = this.rawChats.get(chatId) ?? await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
    const type = asTdObject(rawChat.type);
    const uniqueIds = [...new Set(userIds)].map(numericId);
    if (type?.["@type"] === "chatTypeBasicGroup") {
      for (const userId of uniqueIds) {
        await this.request({
          "@type": "setChatMemberStatus",
          chat_id: numericId(chatId),
          member_id: { "@type": "messageSenderUser", user_id: userId },
          status: { "@type": "chatMemberStatusMember", member_until_date: 0 },
        });
      }
      return;
    }
    await this.request({ "@type": "addChatMembers", chat_id: numericId(chatId), user_ids: uniqueIds });
  }

  async setChatMemberStatus({ chatId, userId, status }: { chatId: string; userId: string; status: ChatMemberStatusInput }): Promise<void> {
    let statusObject: TdObject;
    if (status.kind === "administrator") {
      statusObject = { "@type": "chatMemberStatusAdministrator", can_be_edited: false, rights: chatAdminRightsObject(status.rights) };
    } else if (status.kind === "restricted") {
      statusObject = { "@type": "chatMemberStatusRestricted", is_member: true, restricted_until_date: status.untilDate ?? 0, permissions: chatPermissionsObject(status.permissions) };
    } else if (status.kind === "banned") {
      statusObject = { "@type": "chatMemberStatusBanned", banned_until_date: status.untilDate ?? 0 };
    } else {
      statusObject = { "@type": "chatMemberStatusMember", member_until_date: 0 };
    }
    await this.request({ "@type": "setChatMemberStatus", chat_id: numericId(chatId), member_id: { "@type": "messageSenderUser", user_id: numericId(userId) }, status: statusObject });
  }

  async setChatMemberTag(chatId: string, userId: string, tag: string): Promise<void> {
    const validationError = chatMemberTagError(tag);
    if (validationError) throw new Error(validationError);
    await this.request({ "@type": "setChatMemberTag", chat_id: numericId(chatId), user_id: numericId(userId), tag: tag.trim() });
  }

  async setChatPermissions(chatId: string, permissions: ChatPermissions): Promise<void> {
    await this.request({ "@type": "setChatPermissions", chat_id: numericId(chatId), permissions: chatPermissionsObject(permissions) });
  }

  async setChatSlowModeDelay(chatId: string, delaySeconds: number): Promise<void> {
    const rawChat = this.rawChats.get(chatId) ?? await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
    const type = asTdObject(rawChat.type);
    const supergroupId = tdId(type?.supergroup_id);
    if (!supergroupId || type?.["@type"] !== "chatTypeSupergroup" || type.is_channel === true) throw new Error("慢速模式只适用于超级群组");
    await this.request({ "@type": "setChatSlowModeDelay", chat_id: numericId(chatId), slow_mode_delay: delaySeconds });
  }

  async transferChatOwnership(chatId: string, userId: string, password: string): Promise<void> {
    await this.request({ "@type": "transferChatOwnership", chat_id: numericId(chatId), user_id: numericId(userId), password });
  }

  async getChatEventLog({ chatId, query = "", fromEventId = "", limit = 30, filters }: ChatEventLogInput): Promise<ChatEventPage> {
    const mappedFilters = filters ? {
      "@type": "chatEventLogFilters",
      message_edits: filters.messageEdits,
      message_deletions: filters.messageDeletions,
      message_pins: filters.messagePins,
      member_joins: filters.memberJoins,
      member_leaves: filters.memberLeaves,
      member_invites: filters.memberInvites,
      member_promotions: filters.memberPromotions,
      member_restrictions: filters.memberRestrictions,
      member_tag_changes: filters.memberTagChanges,
      info_changes: filters.infoChanges,
      setting_changes: filters.settingChanges,
      invite_link_changes: filters.inviteLinkChanges,
      video_chat_changes: filters.videoChatChanges,
      forum_changes: filters.forumChanges,
      subscription_extensions: filters.subscriptionExtensions,
    } : null;
    const result = await this.request({ "@type": "getChatEventLog", chat_id: numericId(chatId), query: query.trim(), from_event_id: fromEventId ? numericId(fromEventId) : "0", limit: Math.max(1, Math.min(limit, 100)), filters: mappedFilters, user_ids: [] });
    const events = await Promise.all(asTdObjects(result.events).map(async (event) => {
      const actorSender = asTdObject(event.member_id);
      const actorId = actorSender?.["@type"] === "messageSenderUser" ? tdId(actorSender.user_id) : "";
      const actor = actorId ? await this.loadUser(actorId) : undefined;
      const action = asTdObject(event.action);
      const kind = typeof action?.["@type"] === "string" ? action["@type"] : "event";
      const summary = kind.replace(/^chatEventAction/, "").replace(/([A-Z])/g, " $1").trim() || "群组设置更新";
      return { id: tdId(event.id) || `${event.date ?? 0}`, date: new Date((tdNumber(event.date) ?? 0) * 1000).toISOString(), actor, summary, kind };
    }));
    const nextEventId = events.at(-1)?.id;
    return { events, nextEventId, hasMore: events.length >= Math.max(1, Math.min(limit, 100)) };
  }

  async getChatInviteLinks({ chatId, creatorUserId, revoked = false, offsetDate = 0, offsetLink = "", limit = 30 }: GetChatInviteLinksInput): Promise<ChatInviteLinkPage> {
    const creatorId = creatorUserId || this.currentUserId;
    if (!creatorId) throw new Error("无法确定邀请链接创建者");
    const result = await this.request({ "@type": "getChatInviteLinks", chat_id: numericId(chatId), creator_user_id: numericId(creatorId), is_revoked: revoked, offset_date: offsetDate, offset_invite_link: offsetLink, limit: Math.max(1, Math.min(limit, 100)) });
    const links = asTdObjects(result.invite_links).map(mapChatInviteLink).filter((link): link is ChatInviteLink => Boolean(link));
    const last = links.at(-1);
    return { links, hasMore: links.length >= Math.max(1, Math.min(limit, 100)), nextOffsetDate: last ? Math.floor(Date.parse(last.createdAt) / 1000) : undefined, nextOffsetLink: last?.inviteLink };
  }

  async createChatInviteLink(input: CreateChatInviteLinkInput): Promise<ChatInviteLink> {
    const request = input.subscriptionStars && input.subscriptionStars > 0 ? {
      "@type": "createChatSubscriptionInviteLink",
      chat_id: numericId(input.chatId),
      name: input.name.trim(),
      subscription_pricing: { "@type": "starSubscriptionPricing", period: 2_592_000, star_count: input.subscriptionStars },
    } : {
      "@type": "createChatInviteLink",
      chat_id: numericId(input.chatId),
      name: input.name.trim(),
      expiration_date: input.expirationDate ?? 0,
      member_limit: input.memberLimit ?? 0,
      creates_join_request: input.createsJoinRequest === true,
    };
    const link = mapChatInviteLink(await this.request(request));
    if (!link) throw new Error("TDLib 未返回邀请链接");
    return link;
  }

  async editChatInviteLink(input: CreateChatInviteLinkInput & { inviteLink: string }): Promise<ChatInviteLink> {
    const request = input.subscriptionStars && input.subscriptionStars > 0 ? {
      "@type": "editChatSubscriptionInviteLink", chat_id: numericId(input.chatId), invite_link: input.inviteLink, name: input.name.trim(),
    } : {
      "@type": "editChatInviteLink", chat_id: numericId(input.chatId), invite_link: input.inviteLink, name: input.name.trim(), expiration_date: input.expirationDate ?? 0, member_limit: input.memberLimit ?? 0, creates_join_request: input.createsJoinRequest === true,
    };
    const link = mapChatInviteLink(await this.request(request));
    if (!link) throw new Error("TDLib 未返回已更新的邀请链接");
    return link;
  }

  async revokeChatInviteLink(chatId: string, inviteLink: string): Promise<ChatInviteLink> {
    const link = mapChatInviteLink(await this.request({ "@type": "revokeChatInviteLink", chat_id: numericId(chatId), invite_link: inviteLink }));
    if (!link) throw new Error("TDLib 未返回已撤销的邀请链接");
    return link;
  }

  async getChatJoinRequests({ chatId, inviteLink = "", query = "", offsetUserId, offsetDate = 0, limit = 30 }: GetChatJoinRequestsInput): Promise<ChatJoinRequestPage> {
    const offsetRequest = offsetUserId ? { "@type": "chatJoinRequest", user_id: numericId(offsetUserId), date: offsetDate, bio: "" } : null;
    const result = await this.request({ "@type": "getChatJoinRequests", chat_id: numericId(chatId), invite_link: inviteLink, query: query.trim(), offset_request: offsetRequest, limit: Math.max(1, Math.min(limit, 100)) });
    const values = asTdObjects(result.requests);
    const requests = await Promise.all(values.map(async (raw) => {
      const userId = tdId(raw.user_id);
      const user = userId ? await this.loadUser(userId) : undefined;
      return user ? { user, date: unixDate(raw.date) ?? new Date(0).toISOString(), bio: typeof raw.bio === "string" ? raw.bio : undefined, inviteLink: inviteLink || undefined } : undefined;
    }));
    const filtered = requests.filter((request): request is NonNullable<typeof request> => Boolean(request));
    const lastRaw = values.at(-1);
    return { requests: filtered, totalCount: tdNumber(result.total_count) ?? filtered.length, hasMore: filtered.length >= Math.max(1, Math.min(limit, 100)), nextOffsetUserId: tdId(lastRaw?.user_id) || undefined, nextOffsetDate: tdNumber(lastRaw?.date) };
  }

  async processChatJoinRequest(chatId: string, userId: string, approve: boolean): Promise<void> {
    await this.request({ "@type": "processChatJoinRequest", chat_id: numericId(chatId), user_id: numericId(userId), approve });
  }

  async processChatJoinRequests(chatId: string, inviteLink: string | undefined, approve: boolean): Promise<void> {
    await this.request({ "@type": "processChatJoinRequests", chat_id: numericId(chatId), invite_link: inviteLink ?? "", approve });
  }

  private async resolveBotUser(botUsername: string): Promise<{ userId: string; username: string }> {
    const username = botUsername.replace(/^@/, "").trim();
    if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error("机器人用户名无效");
    const result = await this.request({ "@type": "searchPublicChats", query: username, limit: 10 });
    const chatIds = Array.isArray(result.chat_ids) ? result.chat_ids.map(tdId).filter(Boolean) : [];
    for (const chatId of chatIds) {
      const chat = this.rawChats.get(chatId) ?? await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
      const type = asTdObject(chat.type);
      const userId = tdId(type?.user_id);
      if (type?.["@type"] !== "chatTypePrivate" || !userId) continue;
      const user = await this.loadUser(userId).catch(() => undefined);
      const rawUsernames = asTdObject(this.rawUsers.get(userId)?.usernames);
      const usernames = [
        rawUsernames?.editable_username,
        ...(Array.isArray(rawUsernames?.active_usernames) ? rawUsernames.active_usernames : []),
      ].filter((value): value is string => typeof value === "string" && Boolean(value));
      const exactUsername = usernames.find(
        (candidate) => candidate.toLocaleLowerCase() === username.toLocaleLowerCase(),
      );
      if (user?.isBot && exactUsername) return { userId, username: exactUsername };
    }
    throw new Error("找不到这个机器人");
  }

  async getBotCommandSuggestions(
    chatId: string,
    query = "",
    botUsername?: string,
  ): Promise<BotCommandSuggestion[]> {
    let commandGroups: TdObject[] = [];
    let canDiscoverGroupBots = false;
    if (botUsername) {
      const bot = await this.resolveBotUser(botUsername);
      const full = await this.request({ "@type": "getUserFullInfo", user_id: numericId(bot.userId) });
      const botInfo = asTdObject(full.bot_info);
      commandGroups = [{ bot_user_id: bot.userId, commands: botInfo?.commands }];
    } else {
      const chat = this.rawChats.get(chatId) ?? await this.request({
        "@type": "getChat",
        chat_id: numericId(chatId),
      });
      const type = asTdObject(chat.type);
      if (type?.["@type"] === "chatTypePrivate") {
        const userId = tdId(type.user_id);
        if (userId) {
          const full = await this.request({ "@type": "getUserFullInfo", user_id: numericId(userId) });
          commandGroups = [{ bot_user_id: userId, commands: asTdObject(full.bot_info)?.commands }];
        }
      } else if (type?.["@type"] === "chatTypeBasicGroup") {
        canDiscoverGroupBots = true;
        const groupId = tdId(type.basic_group_id);
        if (groupId) {
          const full = await this.request({ "@type": "getBasicGroupFullInfo", basic_group_id: numericId(groupId) });
          commandGroups = asTdObjects(full.bot_commands);
        }
      } else if (type?.["@type"] === "chatTypeSupergroup") {
        canDiscoverGroupBots = true;
        const groupId = tdId(type.supergroup_id);
        if (groupId) {
          const full = await this.request({ "@type": "getSupergroupFullInfo", supergroup_id: numericId(groupId) });
          commandGroups = asTdObjects(full.bot_commands);
        }
      }
    }
    if (canDiscoverGroupBots) {
      const members = await this.request({
        "@type": "searchChatMembers",
        chat_id: numericId(chatId),
        query: "",
        limit: 200,
        filter: { "@type": "chatMembersFilterBots" },
      });
      const knownBotUserIds = new Set(commandGroups
        .filter((group) => asTdObjects(group.commands).length > 0)
        .map((group) => tdId(group.bot_user_id))
        .filter(Boolean));
      const botUserIds = [...new Set(asTdObjects(members.members).flatMap((member) => {
        const sender = asTdObject(member.member_id);
        const userId = sender?.["@type"] === "messageSenderUser" ? tdId(sender.user_id) : "";
        return userId ? [userId] : [];
      }))].filter((userId) => !knownBotUserIds.has(userId));
      const discovered = await Promise.all(botUserIds.map(async (
        botUserId,
      ): Promise<TdObject | undefined> => {
        try {
          const full = await this.request({
            "@type": "getUserFullInfo",
            user_id: numericId(botUserId),
          });
          return { bot_user_id: botUserId, commands: asTdObject(full.bot_info)?.commands };
        } catch {
          return undefined;
        }
      }));
      commandGroups = [
        ...commandGroups,
        ...discovered.filter((group): group is TdObject => Boolean(group)),
      ];
    }
    const normalized = query.replace(/^\//, "").toLocaleLowerCase();
    const suggestions = await Promise.all(commandGroups.map(async (group) => {
      const botUserId = tdId(group.bot_user_id);
      if (!botUserId) return [];
      let username = "";
      try {
        username = (await this.loadUser(botUserId))?.username ?? "";
      } catch {
        // Commands remain useful even if a deleted/inaccessible bot profile can't be loaded.
      }
      return asTdObjects(group.commands).flatMap((raw) => {
        const commandMatch = typeof raw.command === "string"
          ? raw.command.trim().match(/^\/?([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{5,32})?$/)
          : null;
        const command = commandMatch?.[1]?.toLocaleLowerCase() ?? "";
        const description = typeof raw.description === "string" ? raw.description.trim() : "";
        return command && (!normalized || command.toLocaleLowerCase().startsWith(normalized))
          ? [{ botUserId, botUsername: username, command, description }]
          : [];
      });
    }));
    return [...new Map(suggestions.flat().map((suggestion) => [
      `${suggestion.botUserId}:${suggestion.command.toLocaleLowerCase()}`,
      suggestion,
    ])).values()];
  }

  async getCallbackQueryAnswer(
    chatId: string,
    messageId: string,
    data: string,
  ): Promise<CallbackQueryAnswer> {
    const result = await this.request({
      "@type": "getCallbackQueryAnswer",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
      payload: { "@type": "callbackQueryPayloadData", data },
    });
    return {
      text: typeof result.text === "string" && result.text ? result.text : undefined,
      showAlert: result.show_alert === true,
      url: typeof result.url === "string" && result.url ? result.url : undefined,
    };
  }

  async getInlineQueryResults(chatId: string, botUsername: string, query: string, offset = ""): Promise<InlineQueryResultPage> {
    const bot = await this.resolveBotUser(botUsername);
    const result = await this.request({ "@type": "getInlineQueryResults", bot_user_id: numericId(bot.userId), chat_id: numericId(chatId), user_location: null, query: query.slice(0, 256), offset: offset.slice(0, 64) });
    const mapped = asTdObjects(result.results).flatMap((raw): InlineQueryResult[] => {
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id) return [];
      const content = asTdObject(raw.input_message_content);
      const formatted = asTdObject(content?.text);
      const messageText = typeof formatted?.text === "string" ? formatted.text : typeof raw.title === "string" ? raw.title : "Inline 结果";
      const kind = raw["@type"] === "inlineQueryResultPhoto" ? "photo" : raw["@type"] === "inlineQueryResultVideo" ? "video" : raw["@type"] === "inlineQueryResultDocument" ? "file" : "article";
      return [{ id, kind, title: typeof raw.title === "string" ? raw.title : "Inline 结果", description: typeof raw.description === "string" ? raw.description : undefined, messageText, fileName: typeof raw.title === "string" ? raw.title : undefined }];
    });
    const nextOffset = typeof result.next_offset === "string" && result.next_offset ? result.next_offset : undefined;
    return { queryId: String(result.inline_query_id ?? ""), results: mapped, nextOffset, hasMore: Boolean(nextOffset) };
  }

  async sendInlineQueryResultMessage(chatId: string, botUserId: string, queryId: string, resultId: string, replyToMessageId?: string, topicId?: string): Promise<void> {
    void botUserId;
    await this.request({ "@type": "sendInlineQueryResultMessage", chat_id: numericId(chatId), topic_id: forumTopicObject(topicId), reply_to: replyToMessageId ? { "@type": "inputMessageReplyToMessage", message_id: numericId(replyToMessageId), quote: null, checklist_task_id: 0 } : null, options: { "@type": "messageSendOptions", disable_notification: false, from_background: false, protect_content: false, update_order_of_installed_sticker_sets: false, scheduling_state: null, paid_message_star_count: 0 }, query_id: numericId(queryId), result_id: resultId, hide_via_bot: false });
  }

  async sendBotStartMessage(chatId: string, botUserId: string, parameter = ""): Promise<void> {
    await this.request({ "@type": "sendBotStartMessage", bot_user_id: numericId(botUserId), chat_id: numericId(chatId), parameter: parameter.trim().slice(0, 64) });
  }

  async getBlockedSenders(): Promise<BlockedSender[]> {
    const result = await this.request({ "@type": "getBlockedMessageSenders", block_list: { "@type": "blockListMain" }, offset: 0, limit: 100 });
    const senders = await Promise.all(asTdObjects(result.senders).map(async (raw) => {
      const type = raw["@type"];
      if (type === "messageSenderUser") {
        const id = tdId(raw.user_id);
        const user = id ? await this.loadUser(id) : undefined;
        return user ? { id, kind: "user" as const, title: user.displayName, avatar: user.avatar } : undefined;
      }
      if (type === "messageSenderChat") {
        const id = tdId(raw.chat_id);
        const chat = id ? this.rawChats.get(id) ?? await this.request({ "@type": "getChat", chat_id: numericId(id) }) : undefined;
        return chat && id ? { id, kind: "chat" as const, title: typeof chat.title === "string" ? chat.title : "已屏蔽频道", avatar: this.mapChat(chat)?.avatar ?? { label: "?", color: "#73808c" } } : undefined;
      }
      return undefined;
    }));
    return senders.filter((sender): sender is BlockedSender => Boolean(sender));
  }

  async setMessageSenderBlocked(senderId: string, kind: "user" | "chat", blocked: boolean): Promise<void> {
    await this.request({ "@type": "setMessageSenderBlockList", sender_id: kind === "user" ? { "@type": "messageSenderUser", user_id: numericId(senderId) } : { "@type": "messageSenderChat", chat_id: numericId(senderId) }, block_list: blocked ? { "@type": "blockListMain" } : null });
  }

  async getChatReportOptions(chatId: string, messageIds: string[]): Promise<ChatReportOptions> {
    const result = await this.request({ "@type": "reportChat", chat_id: numericId(chatId), option_id: "", message_ids: messageIds.map(numericId), text: "" });
    if (result["@type"] === "reportChatResultOptionRequired") {
      return { title: typeof result.title === "string" ? result.title : "选择举报原因", options: asTdObjects(result.options).flatMap((raw) => { const id = typeof raw.id === "string" ? raw.id : ""; const title = typeof raw.text === "string" ? raw.text : "其他"; return id ? [{ id, title }] : []; }) };
    }
    if (result["@type"] === "reportChatResultTextRequired") return { title: "补充举报说明", options: [{ id: typeof result.option_id === "string" ? result.option_id : "", title: "其他", requiresText: result.is_optional !== true }] };
    return { title: "举报原因", options: [] };
  }

  async reportChat({ chatId, messageIds, optionId, text = "" }: ReportChatInput): Promise<void> {
    const result = await this.request({ "@type": "reportChat", chat_id: numericId(chatId), option_id: optionId, message_ids: messageIds.map(numericId), text: text.slice(0, 1000) });
    if (["reportChatResultOk", "reportChatResultMessagesRequired"].includes(String(result["@type"]))) return;
    if (result["@type"] === "reportChatResultTextRequired" && !text.trim() && result.is_optional !== true) throw new Error("请补充举报说明");
  }

  async getActiveSessions(): Promise<DeviceSession[]> {
    const result = await this.request({ "@type": "getActiveSessions" });
    return asTdObjects(result.sessions).map(mapSession).filter((session): session is DeviceSession => Boolean(session));
  }
  async terminateSession(sessionId: string): Promise<void> { await this.request({ "@type": "terminateSession", session_id: numericId(sessionId) }); }
  async terminateAllOtherSessions(): Promise<void> { await this.request({ "@type": "terminateAllOtherSessions" }); }
  async getPrivacySettingRules(setting: PrivacySettingKey): Promise<PrivacyRule[]> {
    const result = await this.request({ "@type": "getUserPrivacySettingRules", setting: { "@type": PRIVACY_SETTING_TYPES[setting] } });
    return asTdObjects(result.rules).flatMap((raw): PrivacyRule[] => {
      const kind = String(raw["@type"] ?? "").replace(/^userPrivacySettingRule/, "");
      const names: Record<string, PrivacyRule["kind"]> = { AllowAll: "allowAll", AllowContacts: "allowContacts", AllowUsers: "allowUsers", RestrictAll: "restrictAll", RestrictContacts: "restrictContacts", RestrictUsers: "restrictUsers" };
      const mapped = names[kind];
      return mapped ? [{ kind: mapped, userIds: Array.isArray(raw.user_ids) ? raw.user_ids.map(tdId).filter(Boolean) : undefined }] : [];
    });
  }
  async setPrivacySettingRules(setting: PrivacySettingKey, rules: PrivacyRule[]): Promise<void> {
    const mapped = rules.map((rule) => ({ "@type": `userPrivacySettingRule${rule.kind === "allowAll" ? "AllowAll" : rule.kind === "allowContacts" ? "AllowContacts" : rule.kind === "allowUsers" ? "AllowUsers" : rule.kind === "restrictAll" ? "RestrictAll" : rule.kind === "restrictContacts" ? "RestrictContacts" : "RestrictUsers"}`, ...(rule.userIds ? { user_ids: rule.userIds.map(numericId) } : {}) }));
    await this.request({
      "@type": "setUserPrivacySettingRules",
      setting: { "@type": PRIVACY_SETTING_TYPES[setting] },
      rules: { "@type": "userPrivacySettingRules", rules: mapped },
    });
  }

  async resolveTelegramLink(url: string): Promise<TelegramLinkTarget | undefined> {
    const parsed = (() => {
      try { return new URL(url); } catch { return undefined; }
    })();
    if (!parsed) return undefined;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const isTelegram = parsed.protocol === "tg:" || host === "t.me" || host === "telegram.me" || host === "telegram.dog";
    if (!isTelegram) return undefined;

    const knownUnsupported = knownUnsupportedTelegramLink(url);
    if (knownUnsupported) return knownUnsupported;

    if (parsed.protocol === "tg:" && parsed.hostname.toLowerCase() === "user") {
      const userId = parsed.searchParams.get("id");
      if (!userId || !/^-?\d+$/.test(userId)) {
        return unsupportedTelegramLink(undefined, "Telegram 用户链接无效");
      }
      const rawUser = this.rawUsers.get(userId) ?? await this.request({
        "@type": "getUser",
        user_id: numericId(userId),
      }).catch(() => undefined);
      if (!rawUser || !tdId(rawUser.id)) {
        return unsupportedTelegramLink(undefined, "找不到链接中的 Telegram 用户");
      }
      this.upsertUser(rawUser);
      return { kind: "user", userId };
    }

    const rawLinkType = await this.request({
      "@type": "getInternalLinkType",
      link: parsed.toString(),
    }).catch(() => undefined);
    const linkType = typeof rawLinkType?.["@type"] === "string"
      ? rawLinkType["@type"]
      : undefined;
    if (linkType === "internalLinkTypeUserPhoneNumber") {
      const phoneNumber = typeof rawLinkType?.phone_number === "string"
        ? rawLinkType.phone_number
        : undefined;
      if (!phoneNumber) return unsupportedTelegramLink(linkType, "Telegram 用户链接无效");
      const rawUser = await this.request({
        "@type": "searchUserByPhoneNumber",
        phone_number: phoneNumber,
        only_local: false,
      }).catch(() => undefined);
      const userId = tdId(rawUser?.id);
      if (!rawUser || !userId) {
        return unsupportedTelegramLink(linkType, "找不到链接中的 Telegram 用户");
      }
      this.upsertUser(rawUser);
      if (rawLinkType?.open_profile === false) {
        const chat = await this.createPrivateChat(userId).catch(() => undefined);
        if (chat) return { chatId: chat.id };
      }
      return { kind: "user", userId };
    }
    if (linkType && linkType !== "ok" && linkType !== "internalLinkTypeMessage" && linkType !== "internalLinkTypePublicChat") {
      return unsupportedTelegramLink(linkType);
    }

    const path = parsed.pathname.split("/").filter(Boolean);
    const hasMessageReference = linkType === "internalLinkTypeMessage" || (parsed.protocol === "tg:"
      ? /^\d+$/.test(parsed.searchParams.get("post") ?? "")
      : path[0]?.toLowerCase() === "c"
        ? /^\d+$/.test(path[2] ?? "")
        : /^\d+$/.test(path[1] ?? ""));
    if (hasMessageReference) {
      const linkInfo = await this.request({
        "@type": "getMessageLinkInfo",
        url: parsed.toString(),
      }).catch(() => undefined);
      const linkedMessage = asTdObject(linkInfo?.message);
      const linkedChatId = tdId(linkInfo?.chat_id) || tdId(linkedMessage?.chat_id);
      if (linkedChatId) {
        const rawChat = this.rawChats.get(linkedChatId) ?? await this.request({
          "@type": "getChat",
          chat_id: numericId(linkedChatId),
        }).catch(() => undefined);
        if (rawChat) this.upsertChat(rawChat);
        if (linkedMessage) this.emitMessage(linkedMessage);
        return { chatId: linkedChatId, messageId: tdId(linkedMessage?.id) || undefined };
      }
      return unsupportedTelegramLink(linkType, "找不到链接中的 Telegram 消息，或当前账号无权访问");
    }
    if (parsed.protocol !== "tg:" && path[0]?.toLowerCase() === "c" && /^\d+$/.test(path[1] ?? "")) {
      const internalChatId = `-100${path[1]}`;
      const raw = this.rawChats.get(internalChatId) ?? await this.request({ "@type": "getChat", chat_id: numericId(internalChatId) }).catch(() => undefined);
      if (raw) {
        this.upsertChat(raw);
        return { chatId: internalChatId };
      }
      return unsupportedTelegramLink(undefined, "找不到链接中的 Telegram 会话，或当前账号无权访问");
    }
    const domain = linkType === "internalLinkTypePublicChat" && typeof rawLinkType?.chat_username === "string"
      ? rawLinkType.chat_username
      : parsed.protocol === "tg:" ? parsed.searchParams.get("domain") : path[0];
    if (!domain || !/^[A-Za-z0-9_]{5,32}$/.test(domain)) {
      return unsupportedTelegramLink(linkType ?? "internalLinkTypeUnknownDeepLink");
    }
    const raw = await this.request({ "@type": "searchPublicChat", username: domain }).catch(() => undefined);
    if (!raw) return unsupportedTelegramLink(linkType, "找不到链接中的 Telegram 会话或用户");
    const chatId = tdId(raw.id);
    const chatType = asTdObject(raw.type);
    if (!chatId || !["chatTypePrivate", "chatTypeSupergroup", "chatTypeBasicGroup"].includes(String(chatType?.["@type"]))) {
      return unsupportedTelegramLink(linkType, "此 Telegram 会话类型暂时无法在 Notgram 中打开");
    }
    this.upsertChat(raw);
    return { chatId };
  }

  async searchGlobal(input: import("./types").GlobalSearchInput): Promise<import("./types").GlobalSearchPage> {
    return this.searchService.searchGlobal(input);
  }

  async searchChatMessages(input: import("./types").ChatMessageSearchInput) {
    return this.searchService.searchChatMessages(input);
  }

  async searchSharedMedia(input: import("./types").SharedMediaSearchInput): Promise<import("./types").SharedMediaPage> {
    return this.searchService.searchSharedMedia(input);
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

  async leaveChat(chatId: string) {
    await this.request({
      "@type": "leaveChat",
      chat_id: numericId(chatId),
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
      this.mapChat(raw)?.folderIds.includes(folderId) ? [chatId] : []
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

  async getForumTopics(input: GetForumTopicsInput): Promise<ForumTopicPage> {
    return this.forumTopicService.getForumTopics(input);
  }

  async loadForumTopicHistory(chatId: string, topicId: string, limit = 30): Promise<ChatHistoryPage> {
    return this.forumTopicService.loadForumTopicHistory(chatId, topicId, limit);
  }

  async createForumTopic(input: CreateForumTopicInput): Promise<ForumTopic> {
    return this.forumTopicService.createForumTopic(input);
  }

  async editForumTopic(chatId: string, topicId: string, name: string) {
    return this.forumTopicService.editForumTopic(chatId, topicId, name);
  }

  async setForumTopicClosed(chatId: string, topicId: string, closed: boolean) {
    return this.forumTopicService.setForumTopicClosed(chatId, topicId, closed);
  }

  async setForumTopicPinned(chatId: string, topicId: string, pinned: boolean) {
    return this.forumTopicService.setForumTopicPinned(chatId, topicId, pinned);
  }

  async getMessageContext(chatId: string, messageId: string, limit = 31) {
    return this.messageMediaService.getMessageContext(chatId, messageId, limit);
  }

  async getMessage(chatId: string, messageId: string) {
    return this.messageMediaService.getMessage(chatId, messageId);
  }

  async getMessageProperties(
    chatId: string,
    messageId: string,
  ): Promise<MessagePermissions> {
    return this.messageMediaService.getMessageProperties(chatId, messageId);
  }

  async setMessageReaction(input: SetMessageReactionInput) {
    return this.messageMediaService.setMessageReaction(input);
  }

  async setPollAnswer(input: SetPollAnswerInput) {
    return this.messageMediaService.setPollAnswer(input);
  }

  async getPinnedMessages(chatId: string) {
    return this.messageMediaService.getPinnedMessages(chatId);
  }

  async pinMessage(input: PinMessageInput) {
    return this.messageMediaService.pinMessage(input);
  }

  async unpinMessage(chatId: string, messageId: string) {
    return this.messageMediaService.unpinMessage(chatId, messageId);
  }

  async setChatMessageAutoDeleteTime(input: SetChatMessageAutoDeleteTimeInput) {
    return this.messageMediaService.setChatMessageAutoDeleteTime(input);
  }

  async getEmojiPickerCatalog(): Promise<EmojiPickerCatalog> {
    return this.messageMediaService.getEmojiPickerCatalog();
  }

  async getStickerSet(stickerSetId: string): Promise<StickerSet> {
    return this.messageMediaService.getStickerSet(stickerSetId);
  }

  async searchStickers(query: string, chatId: string): Promise<EmojiPickerAsset[]> {
    return this.messageMediaService.searchStickers(query, chatId);
  }

  async loadEmojiAsset(asset: EmojiPickerAsset) {
    return this.messageMediaService.loadEmojiAsset(asset);
  }

  async sendSticker(input: SendEmojiAssetInput) {
    return this.messageMediaService.sendSticker(input);
  }

  async sendAnimation(input: SendEmojiAssetInput) {
    return this.messageMediaService.sendAnimation(input);
  }

  async sendMessage(input: SendMessageInput) {
    return this.messageMediaService.sendMessage(input);
  }

  async editMessage(input: EditMessageInput) {
    return this.messageMediaService.editMessage(input);
  }

  async deleteMessage(input: DeleteMessageInput) {
    return this.messageMediaService.deleteMessage(input);
  }

  async forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult> {
    return this.messageMediaService.forwardMessages(input);
  }

  async setChatDraft(input: SetChatDraftInput) {
    return this.messageMediaService.setChatDraft(input);
  }

  async setChatTyping(chatId: string, typing: boolean, topicId?: string) {
    return this.messageMediaService.setChatTyping(chatId, typing, topicId);
  }

  async downloadFile(fileId: number, fileName: string) {
    return this.messageMediaService.downloadFile(fileId, fileName);
  }

  async cancelFileDownload(fileId: number) {
    return this.messageMediaService.cancelFileDownload(fileId);
  }

  async openFile(sourcePath: string) {
    return this.messageMediaService.openFile(sourcePath);
  }

  async saveFileAs(sourcePath: string, fileName: string) {
    return this.messageMediaService.saveFileAs(sourcePath, fileName);
  }

  async openDownloadDirectory() {
    return this.messageMediaService.openDownloadDirectory();
  }

  cacheFile(fileId: number, priority = 16) {
    return this.messageMediaService.cacheFile(fileId, priority);
  }

  recoverFile(fileId: number, priority = 32) {
    return this.messageMediaService.recoverFile(fileId, priority);
  }

  async streamFile(input: StreamFileInput) {
    return this.messageMediaService.streamFile(input);
  }

  async suspendFileStream(fileId: number) {
    return this.messageMediaService.suspendFileStream(fileId);
  }

  async retryMessage(chatId: string, messageId: string) {
    return this.messageMediaService.retryMessage(chatId, messageId);
  }

  async sendFile(input: SendFileInput) {
    return this.messageMediaService.sendFile(input);
  }

  async sendFiles(input: SendFilesInput) {
    return this.messageMediaService.sendFiles(input);
  }

  async cancelFileUpload(chatId: string, messageId: string) {
    return this.messageMediaService.cancelFileUpload(chatId, messageId);
  }



  async markChatRead(chatId: string) {
    const rawChat = this.rawChats.get(chatId) ?? await this.refreshChat(chatId);
    const unreadCount = tdNumber(rawChat.unread_count) ?? 0;
    const unreadMentionCount = tdNumber(rawChat.unread_mention_count) ?? 0;
    const isMarkedAsUnread = rawChat.is_marked_as_unread === true;
    if (unreadCount === 0 && unreadMentionCount === 0 && !isMarkedAsUnread) return;
    const lastMessageId = tdNumber(asTdObject(rawChat.last_message)?.id);
    if (unreadCount > 0 && lastMessageId !== undefined) {
      await this.request({
        "@type": "viewMessages",
        chat_id: numericId(chatId),
        message_ids: [lastMessageId],
        source: { "@type": "messageSourceChatHistory" },
        force_read: true,
      });
    }
    if (unreadMentionCount > 0) {
      await this.request({
        "@type": "readAllChatMentions",
        chat_id: numericId(chatId),
      });
    }
    if (isMarkedAsUnread) {
      await this.request({
        "@type": "toggleChatIsMarkedAsUnread",
        chat_id: numericId(chatId),
        is_marked_as_unread: false,
      });
    }
    this.upsertChat({
      ...rawChat,
      unread_count: 0,
      unread_mention_count: 0,
      is_marked_as_unread: false,
      last_read_inbox_message_id: lastMessageId ?? rawChat.last_read_inbox_message_id,
    });
  }

  async markForumTopicRead(chatId: string, topicId: string, messageId: string) {
    numericId(topicId);
    await this.request({
      "@type": "viewMessages",
      chat_id: numericId(chatId),
      message_ids: [numericId(messageId)],
      source: { "@type": "messageSourceChatHistory" },
      force_read: true,
    });
    await this.request({
      "@type": "readAllForumTopicMentions",
      chat_id: numericId(chatId),
      forum_topic_id: numericId(topicId),
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

  private async requestPreparedFile(chatId: string, topicId?: string) {
    return this.requestBroker.requestPreparedFile(chatId, (error) => {
      this.listener?.({ type: "sync.error", message: error.message, fatal: false });
    }, topicId);
  }

  private requestPreparedPastedFiles(
    chatId: string,
    files: PreparedPastedAttachment[],
    caption?: string,
    captionEntities?: import("./types").MessageTextEntity[],
    topicId?: string,
  ) {
    return this.requestBroker.requestPreparedPastedFiles(chatId, files, caption, (error) => {
      this.listener?.({ type: "sync.error", message: error.message, fatal: false });
    }, topicId, captionEntities);
  }


  private requestPreparedProfilePhoto() {
    return this.requestBroker.requestPreparedProfilePhoto();
  }

  private requestPreparedChatPhoto(chatId: string) {
    return this.requestBroker.requestPreparedChatPhoto(chatId);
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
    if (!this.connectingThroughProxy && this.proxyConnectionTimer) {
      globalThis.clearTimeout(this.proxyConnectionTimer);
      this.proxyConnectionTimer = undefined;
    }
    if (
      state?.["@type"] === "connectionStateReady" ||
      state?.["@type"] === "connectionStateWaitingForNetwork"
    ) {
      this.proxyRecoveryAttempt = 0;
    }
    this.emitConnectionStatus(
      status === "online" && this.initialChatSyncPending ? "syncing" : status,
    );

    if (this.connectingThroughProxy) this.scheduleProxyRecovery();
  }

  private emitConnectionStatus(status: ConnectionStatus) {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.listener?.({ type: "connection.changed", status });
  }

  private scheduleProxyRecovery() {
    if (
      !this.connectingThroughProxy ||
      this.proxyConnectionTimer ||
      this.networkReopenPromise
    ) return;
    const delay = PROXY_RECOVERY_DELAYS_MS[
      Math.min(this.proxyRecoveryAttempt, PROXY_RECOVERY_DELAYS_MS.length - 1)
    ];
    this.proxyConnectionTimer = globalThis.setTimeout(() => {
      this.proxyConnectionTimer = undefined;
      void this.recoverStalledProxy();
    }, delay);
  }

  private async recoverStalledProxy() {
    if (!this.connectingThroughProxy) return;
    this.proxyRecoveryAttempt += 1;
    try {
      // TDLib documents that setting the same network type forces all network
      // connections to reopen. This keeps the configured proxy enabled while
      // replacing a socket that became stuck on a weak or changing network.
      await this.reopenNetworkConnections();
    } catch {
      // TDLib keeps its own retry loop; the next bounded watchdog attempt is
      // still useful even if this local recovery request failed.
    } finally {
      if (!this.connectingThroughProxy) return;
      if (this.proxyRecoveryAttempt >= PROXY_ERROR_AFTER_RECOVERY_ATTEMPTS) {
        this.emitConnectionStatus("proxyError");
      }
      this.scheduleProxyRecovery();
    }
  }

  private reopenNetworkConnections() {
    if (this.networkReopenPromise) return this.networkReopenPromise;
    const pending = this.request({
      "@type": "setNetworkType",
      type: { "@type": "networkTypeOther" },
    }).then(() => undefined);
    this.networkReopenPromise = pending;
    const clear = () => {
      if (this.networkReopenPromise === pending) this.networkReopenPromise = undefined;
    };
    void pending.then(clear, clear);
    return pending;
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

    if (this.settingsOnly) return;

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
    const loadedIds = this.chatListIds.get(key) ?? new Set<string>();
    const newIds = ids.filter((id) => !loadedIds.has(id));
    this.chatListCounts.set(key, Math.max(previousCount, ids.length));
    for (const id of ids) loadedIds.add(id);
    this.chatListIds.set(key, loadedIds);

    // Keep TDLib and React work bounded when a list grows or is restored from a
    // large cache. Re-fetching every returned chat turns pagination into O(n^2).
    const fetchedChats: Chat[] = [];
    const batchSize = 8;
    for (let index = 0; index < newIds.length; index += batchSize) {
      const batch = await Promise.all(newIds.slice(index, index + batchSize).map(async (id) => {
        const raw = this.rawChats.get(id) ?? await this.request({
          "@type": "getChat",
          chat_id: numericId(id),
        });
        this.rawChats.set(id, raw);
        return this.mapChat(raw);
      }));
      fetchedChats.push(...batch.filter((chat): chat is Chat => Boolean(chat)));
    }
    if (fetchedChats.length > 0 && !this.initialChatSyncPending) {
      this.listener?.({ type: "chats.upserted", chats: fetchedChats });
    }
    return {
      loadedCount: newIds.length,
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
    return this.profileService.loadUser(userId);
  }



  private async loadManagedMembers(values: TdObject[]): Promise<ManagedChatMember[]> {
    const details = values.flatMap((member) => {
      const sender = asTdObject(member.member_id);
      const userId = sender?.["@type"] === "messageSenderUser" ? tdId(sender.user_id) : "";
      if (!userId) return [];
      const status = asTdObject(member.status);
      const statusKind = managedMemberStatusFromTd(member.status);
      return [{
        userId,
        status: statusKind,
        role: (statusKind === "owner" ? "owner" : statusKind === "administrator" ? "administrator" : "member") as ChatProfile["members"][number]["role"],
        adminRights: statusKind === "administrator" ? mapChatAdminRightsFromTd(status?.rights) : undefined,
        permissions: statusKind === "restricted" ? mapChatPermissionsFromTd(status?.permissions) : undefined,
        untilDate: tdNumber(status?.restricted_until_date ?? status?.banned_until_date ?? status?.member_until_date),
        customTitle: typeof member.tag === "string" && member.tag.trim() ? member.tag.trim() : undefined,
        canBeEdited: statusKind === "administrator" ? status?.can_be_edited === true : true,
      }];
    });
    const users = await Promise.all(details.map((detail) => this.loadUser(detail.userId)));
    return details.flatMap((detail, index) => {
      const user = users[index];
      return user ? [{
        user,
        role: detail.role,
        status: detail.status,
        adminRights: detail.adminRights,
        permissions: detail.permissions,
        untilDate: detail.untilDate,
        customTitle: detail.customTitle,
        canBeEdited: detail.canBeEdited,
      }] : [];
    });
  }

  private upsertUser(raw?: TdObject, cacheRelevant = true) {
    if (!raw) return;
    const id = tdId(raw.id);
    const user = mapTdUser(raw);
    if (!id || !user) return;
    this.rawUsers.set(id, raw);
    this.listener?.({
      type: "user.upsert",
      user,
      ...(cacheRelevant ? {} : { cacheRelevant: false }),
    });
  }

  private upsertBasicGroup(raw?: TdObject) {
    if (!raw) return;
    const id = tdId(raw.id);
    if (!id) return;
    this.rawBasicGroups.set(id, raw);
    for (const chat of this.rawChats.values()) {
      const type = asTdObject(chat.type);
      if (type?.["@type"] === "chatTypeBasicGroup" && tdId(type.basic_group_id) === id) {
        this.emitChat(chat);
      }
    }
  }

  private upsertSupergroup(raw?: TdObject) {
    if (!raw) return;
    const id = tdId(raw.id);
    if (!id) return;
    this.rawSupergroups.set(id, raw);
    for (const chat of this.rawChats.values()) {
      const type = asTdObject(chat.type);
      if (type?.["@type"] === "chatTypeSupergroup" && tdId(type.supergroup_id) === id) {
        this.emitChat(chat);
      }
    }
  }

  private updateUserStatus(update: TdObject) {
    const id = tdId(update.user_id);
    const current = this.rawUsers.get(id);
    if (current) this.upsertUser({ ...current, status: update.status });
  }

  private upsertChat(raw?: TdObject, cacheRelevant = true) {
    if (!raw) return;
    const id = tdId(raw.id);
    if (!id) return;
    this.rawChats.set(id, raw);
    this.emitChat(raw, cacheRelevant);
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

  private mapChat(raw: TdObject) {
    const type = asTdObject(raw.type);
    const basicGroupId = type?.["@type"] === "chatTypeBasicGroup"
      ? tdId(type.basic_group_id)
      : undefined;
    const supergroupId = type?.["@type"] === "chatTypeSupergroup"
      ? tdId(type.supergroup_id)
      : undefined;
    return mapTdChat(
      raw,
      this.currentUserId,
      supergroupId ? this.rawSupergroups.get(supergroupId) : undefined,
      basicGroupId ? this.rawBasicGroups.get(basicGroupId) : undefined,
    );
  }

  private emitChat(raw: TdObject, cacheRelevant = true) {
    const chat = this.mapChat(raw);
    if (chat && !this.initialChatSyncPending) {
      this.listener?.({
        type: "chat.upsert",
        chat,
        ...(cacheRelevant ? {} : { cacheRelevant: false }),
      });
    }
  }

  private finishInitialChatSync() {
    if (!this.initialChatSyncPending) return;
    this.initialChatSyncPending = false;
    const chats: Chat[] = [];
    for (const raw of this.rawChats.values()) {
      const chat = this.mapChat(raw);
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

  private updateChatAction(update: TdObject) {
    const chatId = tdId(update.chat_id);
    const senderId = messageSenderId(update.sender_id);
    if (!chatId || !senderId) return;
    this.listener?.({
      type: "chat.typingChanged",
      chatId,
      senderId,
      typing: asTdObject(update.action)?.["@type"] === "chatActionTyping",
    });
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

  private indexMessageFiles(chatId: string, messageId: string, raw: TdObject) {
    const reference = `${chatId}:${messageId}`;
    this.unindexMessageFiles(chatId, messageId);
    const fileIds = new Set<number>();
    collectFileIds(raw, fileIds);
    this.rawMessageFileIds.set(reference, fileIds);
    for (const fileId of fileIds) {
      const references = this.fileMessageReferences.get(fileId) ?? new Set<string>();
      references.add(reference);
      this.fileMessageReferences.set(fileId, references);
    }
  }

  private unindexMessageFiles(chatId: string, messageId: string) {
    const reference = `${chatId}:${messageId}`;
    for (const fileId of this.rawMessageFileIds.get(reference) ?? []) {
      const references = this.fileMessageReferences.get(fileId);
      references?.delete(reference);
      if (references?.size === 0) this.fileMessageReferences.delete(fileId);
    }
    this.rawMessageFileIds.delete(reference);
  }

  private updateFile(file?: TdObject) {
    const fileId = tdNumber(file?.id);
    if (!file || fileId === undefined) return;
    const local = asTdObject(file.local);
    const cacheRelevant = local?.is_downloading_completed === true;
    this.fileDownloads.handleFile(
      fileId,
      local?.is_downloading_completed === true,
      local?.is_downloading_active === true,
      tdNumber(local?.downloaded_size),
    );

    for (const raw of [...this.rawChats.values()]) {
      const photo = asTdObject(raw.photo);
      const small = asTdObject(photo?.small);
      if (tdNumber(small?.id) !== fileId || !photo) continue;
      this.upsertChat({ ...raw, photo: { ...photo, small: file } }, cacheRelevant);
    }

    for (const raw of [...this.rawUsers.values()]) {
      const profilePhoto = asTdObject(raw.profile_photo);
      const small = asTdObject(profilePhoto?.small);
      if (tdNumber(small?.id) !== fileId || !profilePhoto) continue;
      this.upsertUser({
        ...raw,
        profile_photo: { ...profilePhoto, small: file },
      }, cacheRelevant);
    }

    const references = [...(this.fileMessageReferences.get(fileId) ?? [])];
    for (const reference of references) {
      const separator = reference.indexOf(":");
      const chatId = reference.slice(0, separator);
      const messageId = reference.slice(separator + 1);
      const raw = this.rawMessages.get(chatId)?.get(messageId);
      if (!raw) continue;
      const replaced = replaceFileReference(raw, fileId, file);
      if (replaced.changed) {
        this.emitMessage(asTdObject(replaced.value), false, cacheRelevant);
      }
    }

    const pending = this.pendingDownloads.get(fileId);
    if (pending && local?.is_downloading_completed === true) {
      this.pendingDownloads.delete(fileId);
      if (typeof local.path !== "string" || !local.path) {
        pending.reject(new Error("TDLib 下载完成但未提供本地文件路径"));
        return;
      }
      void invoke<string>("telegram_save_downloaded_file", {
        sourcePath: local.path,
        fileName: pending.fileName,
      }).then(() => pending.resolve()).catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error("无法保存下载文件"));
      });
    }
  }

  private emitMessage(raw?: TdObject, animateEntrance = false, cacheRelevant = true) {
    if (!raw) return;
    if (raw.is_outgoing !== true && raw.is_pending !== true) this.clearPendingBotDrafts(tdId(raw.chat_id));
    const message = this.mapMessage(raw);
    if (!message) return;
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.indexMessageFiles(message.chatId, message.id, raw);
    this.listener?.({
      type: "message.upsert",
      message,
      animateEntrance,
      ...(cacheRelevant ? {} : { cacheRelevant: false }),
    });
    this.ensureMessageSenderChat(raw);
    if (raw.is_pending !== true) {
      this.ensureReplyContent(raw);
      this.ensureFullRichMessage(raw);
    }
  }

  private emitForumTopicsChanged(chatIdValue: unknown) {
    const chatId = tdId(chatIdValue);
    if (chatId) this.listener?.({ type: "forumTopics.changed", chatId });
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
      this.indexMessageFiles(message.chatId, message.id, raw);
      const key = `${message.chatId}:${message.id}`;
      messages.set(key, message);
      uniqueRawMessages.set(key, raw);
      this.ensureMessageSenderChat(raw);
    }
    if (messages.size > 0) {
      this.listener?.({ type: "messages.upserted", messages: [...messages.values()] });
    }
    for (const raw of uniqueRawMessages.values()) this.ensureReplyContent(raw);
    for (const raw of uniqueRawMessages.values()) this.ensureFullRichMessage(raw);
  }

  private ensureMessageSenderChat(raw: TdObject) {
    const sender = asTdObject(raw.sender_id);
    if (sender?.["@type"] !== "messageSenderChat") return;
    const chatId = tdId(sender.chat_id);
    if (!chatId || this.rawChats.has(chatId) || this.pendingSenderChatLoads.has(chatId)) return;
    this.pendingSenderChatLoads.add(chatId);
    void this.request({ "@type": "getChat", chat_id: numericId(chatId) })
      .then((chat) => {
        this.upsertChat(chat);
        for (const messages of this.rawMessages.values()) {
          for (const message of messages.values()) {
            const messageSender = asTdObject(message.sender_id);
            if (
              messageSender?.["@type"] === "messageSenderChat" &&
              tdId(messageSender.chat_id) === chatId
            ) this.emitMessage(message);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => this.pendingSenderChatLoads.delete(chatId));
  }

  private ensureMessageSenderUser(raw: TdObject) {
    const sender = asTdObject(raw.sender_id);
    if (sender?.["@type"] !== "messageSenderUser") return;
    const userId = tdId(sender.user_id);
    if (!userId || this.rawUsers.has(userId) || this.pendingSenderUserLoads.has(userId)) return;
    this.pendingSenderUserLoads.add(userId);
    void this.request({ "@type": "getUser", user_id: numericId(userId) })
      .then((user) => this.upsertUser(user))
      .catch(() => undefined)
      .finally(() => this.pendingSenderUserLoads.delete(userId));
  }

  private ensureFullRichMessage(raw: TdObject) {
    const content = asTdObject(raw.content);
    const richMessage = asTdObject(content?.message);
    const chatId = tdId(raw.chat_id);
    const messageId = tdId(raw.id);
    if (!chatId || !messageId) return;
    const key = `${chatId}:${messageId}`;
    if (content?.["@type"] !== "messageRichMessage" || richMessage?.is_full !== false) {
      this.clearRichMessageHydration(key);
      return;
    }
    if (
      this.pendingRichMessageHydrations.has(key) ||
      this.unavailableRichMessageHydrations.has(key)
    ) return;
    const scheduled = this.richMessageHydrationTimers.get(key);
    if (scheduled) {
      globalThis.clearTimeout(scheduled);
      this.richMessageHydrationTimers.delete(key);
    }
    this.pendingRichMessageHydrations.add(key);
    let retry = false;
    void this.request({
      "@type": "getFullRichMessage",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    }).then((fullMessage) => {
      if (fullMessage["@type"] !== "richMessage") {
        this.unavailableRichMessageHydrations.add(key);
        return;
      }
      this.richMessageHydrationFailures.delete(key);
      const latest = this.rawMessages.get(chatId)?.get(messageId);
      const latestContent = asTdObject(latest?.content);
      if (!latest || latestContent?.["@type"] !== "messageRichMessage") return;
      retry = fullMessage.is_full === false;
      this.emitMessage({
        ...latest,
        content: { ...latestContent, message: fullMessage },
      });
    }).catch(() => {
      const failures = (this.richMessageHydrationFailures.get(key) ?? 0) + 1;
      this.richMessageHydrationFailures.set(key, failures);
      if (failures >= 8) this.unavailableRichMessageHydrations.add(key);
      else retry = true;
    }).finally(() => {
      this.pendingRichMessageHydrations.delete(key);
      if (retry && !this.unavailableRichMessageHydrations.has(key)) {
        const failures = this.richMessageHydrationFailures.get(key) ?? 0;
        const delay = Math.min(1_500, 420 * Math.max(1, failures));
        const timer = globalThis.setTimeout(() => {
          this.richMessageHydrationTimers.delete(key);
          const latest = this.rawMessages.get(chatId)?.get(messageId);
          if (latest) this.ensureFullRichMessage(latest);
        }, delay);
        this.richMessageHydrationTimers.set(key, timer);
      }
    });
  }

  private clearRichMessageHydration(key: string) {
    const timer = this.richMessageHydrationTimers.get(key);
    if (timer) globalThis.clearTimeout(timer);
    this.richMessageHydrationTimers.delete(key);
    this.richMessageHydrationFailures.delete(key);
    this.pendingRichMessageHydrations.delete(key);
    this.unavailableRichMessageHydrations.delete(key);
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
        this.ensureMessageSenderChat(replied);
        this.ensureMessageSenderUser(replied);

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
            sender_id: replied.sender_id,
            origin_send_date: replied.date,
            content: replied.content,
            is_outgoing: replied.is_outgoing === true,
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
    const message = this.mapMessage(raw);
    if (!message) return;
    const chatId = tdId(raw.chat_id);
    const oldId = tdId(update.old_message_id);
    if (chatId && oldId) {
      this.rawMessages.get(chatId)?.delete(oldId);
      this.unindexMessageFiles(chatId, oldId);
    }
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.indexMessageFiles(message.chatId, message.id, raw);
    if (oldId) {
      this.listener?.({ type: "message.replace", oldMessageId: oldId, message });
    } else {
      this.listener?.({ type: "message.upsert", message });
    }
    this.ensureMessageSenderChat(raw);
    this.ensureReplyContent(raw);
    this.ensureFullRichMessage(raw);
  }

  private updateMessageContent(update: TdObject) {
    this.patchMessage(update.chat_id, update.message_id, {
      content: update.new_content,
    });
  }

  private pendingBotDraftKey(chatId: string, topicId: string, draftId: string) {
    return `${chatId}:${topicId || "0"}:${draftId}`;
  }

  private clearPendingBotDrafts(chatId: string) {
    if (!chatId) return;
    for (const [key, messageId] of this.pendingBotDrafts) {
      if (!key.startsWith(`${chatId}:`)) continue;
      this.pendingBotDrafts.delete(key);
      this.rawMessages.get(chatId)?.delete(messageId);
      this.unindexMessageFiles(chatId, messageId);
      this.listener?.({ type: "message.remove", chatId, messageId, immediate: true });
    }
  }

  private updatePendingMessage(update: TdObject) {
    const chatId = tdId(update.chat_id);
    const draftId = tdId(update.draft_id);
    if (!chatId || !draftId || !update.content) return;
    const topicId = tdId(update.forum_topic_id);
    const key = this.pendingBotDraftKey(chatId, topicId, draftId);
    const existingMessageId = this.pendingBotDrafts.get(key);
    const messageId = existingMessageId ?? `pending:${chatId}:${topicId || "0"}:${draftId}`;
    this.pendingBotDrafts.set(key, messageId);
    const chat = this.rawChats.get(chatId);
    const chatType = asTdObject(chat?.type);
    const peerId = tdId(chatType?.user_id);
    const senderId = chatType?.["@type"] === "chatTypePrivate" && peerId
      ? { "@type": "messageSenderUser", user_id: numericId(peerId) }
      : { "@type": "messageSenderChat", chat_id: numericId(chatId) };
    this.emitMessage({
      "@type": "message",
      id: messageId,
      chat_id: numericId(chatId),
      sender_id: senderId,
      is_outgoing: false,
      is_pending: true,
      date: Math.floor(Date.now() / 1_000),
      content: update.content,
    }, existingMessageId === undefined);
  }

  private updatePoll(update: TdObject) {
    const poll = asTdObject(update.poll);
    const pollId = tdId(poll?.id);
    if (!poll || !pollId) return;
    const affected: TdObject[] = [];
    for (const messages of this.rawMessages.values()) {
      for (const raw of messages.values()) {
        const content = asTdObject(raw.content);
        if (content?.["@type"] !== "messagePoll") continue;
        if (tdId(asTdObject(content.poll)?.id) !== pollId) continue;
        affected.push({ ...raw, content: { ...content, poll } });
      }
    }
    for (const raw of affected) this.emitMessage(raw);
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
      this.clearRichMessageHydration(`${chatId}:${messageId}`);
      this.rawMessages.get(chatId)?.delete(messageId);
      this.unindexMessageFiles(chatId, messageId);
      this.listener?.({ type: "message.remove", chatId, messageId });
    }
  }

  private resetSessionState() {
    if (this.proxyConnectionTimer) globalThis.clearTimeout(this.proxyConnectionTimer);
    this.proxyConnectionTimer = undefined;
    this.connectingThroughProxy = false;
    this.proxyRecoveryAttempt = 0;
    this.networkReopenPromise = undefined;
    if (this.networkOnlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", this.networkOnlineHandler);
    }
    this.networkOnlineHandler = undefined;
    this.connectionStatus = undefined;
    this.rawChats.clear();
    this.rawBasicGroups.clear();
    this.rawSupergroups.clear();
    this.rawUsers.clear();
    this.rawMessages.clear();
    this.rawMessageFileIds.clear();
    this.fileMessageReferences.clear();
    this.exhaustedHistories.clear();
    this.historyCursors.clear();
    this.historyLoads.clear();
    this.forumTopicService.reset();
    this.pendingReplyHydrations.clear();
    this.unavailableReplyHydrations.clear();
    this.pendingRichMessageHydrations.clear();
    this.pendingBotDrafts.clear();
    this.unavailableRichMessageHydrations.clear();
    for (const timer of this.richMessageHydrationTimers.values()) globalThis.clearTimeout(timer);
    this.richMessageHydrationTimers.clear();
    this.richMessageHydrationFailures.clear();
    this.pendingSenderChatLoads.clear();
    this.pendingSenderUserLoads.clear();
    this.chatListLoads.clear();
    this.chatListCounts.clear();
    this.chatListIds.clear();
    this.exhaustedChatLists.clear();
    this.fileDownloads.reset();
    for (const pending of this.pendingDownloads.values()) {
      pending.reject(new Error("TDLib 会话已重置，下载未完成"));
    }
    this.pendingDownloads.clear();
    this.rawFolderInfos = [];
    this.mainChatListPosition = 0;
    this.currentUserId = undefined;
    this.bootstrapPromise = undefined;
    this.initialChatSyncPending = true;
  }

}
