import { chatReportRequest, mapChatReportResult } from "./chatReport";
import { mapChatInvitePreview, mapChatJoinResult } from "./chatJoin";
import { telegramInviteLink } from "./telegramLinks";
import type { JoinChatInput, JoinChatResult } from "./types";
import { isInDeletedHistory } from "./deletedHistory";
import { translate } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asTdObject,
  asTdObjects,
  fileDetails,
  chatIdFromBasicGroupId,
  chatIdFromSupergroupId,
  mapTdChat,
  mapTdChatDraft,
  mapTdChatFolders,
  mapTdMessage,
  mapTdSponsoredMessages,
  messageSenderId,
  mapTdUser,
  tdId,
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import { FileDownloadQueue } from "./fileDownloadQueue";
import { TdFileStateCache } from "./tdFileStateCache";
import { loadHistoryWindow } from "./historyPager";
import { installConnectionRecoveryMonitor } from "./connectionRecoveryMonitor";
import { TdUpdateStream } from "./tdUpdateStream";
import { proxyPreferences } from "./proxySettings";
import { isRetryableSyncError } from "./syncRetryQueue";
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
} from "./tdlibRequests";
import { routeTdUpdate, type TdUpdateHandlers } from "./tdUpdateRouter";
import { FOLDER_DIRECT_CHAT_LIMIT } from "../utils/folderChatSelection";
import { TauriSearchService } from "./tauriSearchService";
import { TauriForumTopicService } from "./tauriForumTopicService";
import {
  identityTextField,
  normalizeIdentityText,
  sanitizeIdentityText,
} from "./identityText";
import {
  PROFILE_ADMIN_PAGE_SIZE,
  PROFILE_MEMBER_PAGE_SIZE,
  TauriProfileService,
  profileField,
} from "./tauriProfileService";
import {
  TauriMessageMediaService,
  mapEmojiStickerSet,
  type PendingDownload,
} from "./tauriMessageMediaService";
import {
  getActiveConversationTraceId,
  logPerformance,
  isPerformanceMonitoringEnabled,
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
  ChatReportResult,
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
  HistoryPageRequest,
  ChatSponsoredMessages,
  ChatListPage,
  DeleteMessageInput,
  EditMessageInput,
  SendMediaCopyInput,
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
  GetMessageReactionSendersInput,
  SetPollAnswerInput,
  StorageSettings,
  StorageLayer,
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
  parseTelegramUrl,
  telegramBotStartParameters,
  telegramStickerSetName,
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

const BOOTSTRAP_RETRY_DELAYS_MS = [5_000, 10_000, 15_000] as const;
const GROUP_BOT_DISCOVERY_TIMEOUT_MS = 1_500;
// Keep short TDLib disconnect/reconnect blips out of the user-facing status.
const CONNECTION_LOSS_GRACE_MS = 2_000;

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
    name: typeof raw.name === "string" ? raw.name : translate("邀请链接"),
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
  private updateStream?: TdUpdateStream;
  private unlistenError?: UnlistenFn;
  private unlistenProxySettings?: UnlistenFn;
  private requestBroker = new TdRequestBroker();
  private rawChats = new Map<string, TdObject>();
  private refreshedChats = new Set<string>();
  private chatRefreshes = new Map<string, Promise<TdObject>>();
  // Recognize snapshots already consumed in TDLib receive order. Async callers
  // may still hold one after a later update has replaced it.
  private consumedChatSnapshots = new WeakSet<TdObject>();
  private rawUsers = new Map<string, TdObject>();
  private searchService = new TauriSearchService({
    request: (request) => this.request(request),
    rawChats: this.rawChats,
    rawUsers: this.rawUsers,
    upsertChat: (raw) => this.upsertChat(raw),
    upsertUser: (raw) => this.upsertUser(raw),
    mapChat: (raw) => this.mapChat(raw),
    mapMessage: (raw) => this.mapMessage(raw),
    emitMessages: (rawMessages) => { this.emitMessages(rawMessages); },
  });
  private forumTopicService = new TauriForumTopicService({
    request: (request) => this.request(request),
    emitMessages: (rawMessages, notify) => this.emitMessages(rawMessages, true, notify),
    emitForumTopicsChanged: (chatId) => this.emitForumTopicsChanged(chatId),
  });
  private rawBasicGroups = new Map<string, TdObject>();
  private rawSupergroups = new Map<string, TdObject>();
  private basicGroupUpgrades = new Map<string, string>();
  private chatIdAliases = new Map<string, string>();
  private emittedChatMigrations = new Set<string>();
  private basicGroupLoads = new Map<string, Promise<void>>();
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
  private localDeleteIntents = new Set<string>();
  private localHistoryDeleteIntents = new Set<string>();
  private deletedHistory = new Map<string, string>();
  private scopeNotificationSettings = new Map<string, TdObject>();
  // Session facts, independent of the evictable raw message cache and sync resets.
  private invalidatedMessageIds = new Set<string>();
  private pendingMessagePatches = new Map<string, TdObject>();
  private pendingDownloads = new Map<number, PendingDownload>();
  private rawMessageFileIds = new Map<string, Set<number>>();
  private fileMessageReferences = new Map<number, Set<string>>();
  private handlingUpdateBatch = false;
  private pendingFileMessageUpdates = new Map<string, {
    fileUpdates: Map<number, TdObject>;
    cacheRelevant: boolean;
  }>();
  private exhaustedHistories = new Set<string>();
  private historyCursors = new Map<string, number>();
  private historyLoads = new Map<string, Promise<ChatHistoryPage>>();
  private pendingReplyHydrations = new Map<string, symbol>();
  private unavailableReplyHydrations = new Set<string>();
  private pendingRichMessageHydrations = new Set<string>();
  private unavailableRichMessageHydrations = new Set<string>();
  private hydrationQueue: Array<{
    generation: number;
    task: () => Promise<unknown> | unknown;
  }> = [];
  private activeHydrations = 0;
  private hydrationGeneration = 0;
  private hydrationFocusChatId: string | undefined;
  private hydrationDrainScheduled = false;
  private readonly maxHydrationConcurrency = 4;
  private richMessageHydrationTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  private richMessageHydrationFailures = new Map<string, number>();
  private pendingSenderChatLoads = new Set<string>();
  private pendingSenderUserLoads = new Set<string>();
  private pendingBotDrafts = new Map<string, string>();
  private chatListLoads = new Map<string, Promise<ChatListPage>>();
  private chatListCounts = new Map<string, number>();
  private chatListIds = new Map<string, Set<string>>();
  private chatListsNeedingRefresh = new Set<string>();
  private exhaustedChatLists = new Set<string>();
  private fileStates = new TdFileStateCache();
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
    sessionGeneration: () => this.hydrationGeneration,
    recoverFile: (fileId) => this.requestBroker.recoverFile(fileId),
    request: (request) => this.request(request),
    rawMessages: this.rawMessages,
    emitMessage: (raw, animateEntrance) => this.emitMessage(raw, animateEntrance),
    emitMessages: (rawMessages: TdObject[], notify?: boolean) => this.emitMessages(rawMessages, true, notify),
    mapMessage: (raw) => this.mapMessage(raw),
    ensureReplyContent: (raw) => this.ensureReplyContent(raw),
    patchMessage: (chatId, messageId, patch) => this.patchMessage(chatId, messageId, patch),
    refreshChat: (chatId) => this.refreshChat(chatId),
    fileDownloads: this.fileDownloads,
    pendingDownloads: this.pendingDownloads,
    updateFile: (file) => this.updateFile(file),
    requestPreparedFile: (chatId, topicId) => this.requestPreparedFile(chatId, topicId),
    requestPreparedPastedFiles: (
      chatId,
      files,
      caption,
      captionEntities,
      topicId,
      replyToMessageId,
      replyQuote,
      disableNotification,
    ) => this.requestPreparedPastedFiles(
      chatId,
      files,
      caption,
      captionEntities,
      topicId,
      replyToMessageId,
      replyQuote,
      disableNotification,
    ),
  });
  private updateHandlers: TdUpdateHandlers = {
    authorization: (update) => this.handleAuthorizationUpdate(update),
    connection: (update) => this.handleConnectionUpdate(update),
    upsertUser: (user) => this.upsertUser(user),
    upsertBasicGroup: (basicGroup) => this.upsertBasicGroup(basicGroup),
    upsertSupergroup: (supergroup) => this.upsertSupergroup(supergroup),
    updateUserStatus: (update) => this.updateUserStatus(update),
    updateChatFolders: (update) => this.updateChatFolders(update),
    updateScopeNotificationSettings: (update) => {
      const scope = asTdObject(update.scope)?.["@type"];
      const settings = asTdObject(update.notification_settings);
      if (typeof scope !== "string" || !settings) return;
      this.scopeNotificationSettings.set(scope, settings);
      for (const raw of this.rawChats.values()) {
        if (this.notificationScope(raw) === scope && asTdObject(raw.notification_settings)?.use_default_mute_for === true) {
          this.emitChat(raw);
        }
      }
    },
    upsertChat: (chat) => this.upsertChat(chat),
    emitDraft: (chatId, draft) => this.emitDraft(chatId, draft),
    updateChatAction: (update) => this.updateChatAction(update),
    patchChat: (chatId, patch) => this.patchChat(chatId, patch),
    patchChatWithPositions: (chatId, patch, positions) =>
      this.patchChatWithPositions(chatId, patch, positions),
    updateChatPosition: (update) => this.updateChatPosition(update),
    updateChatList: (update, added) => this.updateChatList(update, added),
    updateForumTopic: (update) => this.updateForumTopic(update),
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
    updateEmoji: (update) => {
      const type = update["@type"];
      if (type === "updateStickerSet") {
        const raw = asTdObject(update.sticker_set);
        if (asTdObject(raw?.sticker_type)?.["@type"] !== "stickerTypeRegular") return;
        const stickerSet = mapEmojiStickerSet(raw);
        if (stickerSet) this.listener?.({ type: "stickerSet.updated", stickerSet });
      } else if (type === "updateInstalledStickerSets") {
        if (asTdObject(update.sticker_type)?.["@type"] !== "stickerTypeRegular") return;
        this.listener?.({
          type: "emoji.catalogChanged",
          installedStickerSetIds: Array.isArray(update.sticker_set_ids) ? update.sticker_set_ids.map(tdId) : [],
        });
      } else if (type !== "updateRecentStickers" || update.is_attached !== true) {
        this.listener?.({ type: "emoji.catalogChanged" });
      }
    },
  };
  private rawFolderInfos: TdObject[] = [];
  private mainChatListPosition = 0;
  private currentUserId?: string;
  private bootstrapPromise?: Promise<void>;
  private bootstrapComplete = false;
  private bootstrapFailed = false;
  private bootstrapRetryTimer?: ReturnType<typeof globalThis.setTimeout>;
  private bootstrapRetryAttempt = 0;
  private authorizationReady = false;
  private tdConnectionStatus?: ConnectionStatus;
  private sessionGeneration = 0;
  private syncGeneration = 0;
  private initialChatSyncPending = true;
  private initialUserSyncPending = false;
  private initialUsers = new Map<string, User>();
  private connectionStatus?: ConnectionStatus;
  private hasEstablishedConnection = false;
  private connectionStatusTimer?: ReturnType<typeof globalThis.setTimeout>;
  private pendingConnectionStatus?: ConnectionStatus;
  private connectionSyncPending = false;
  private connectionSyncTimer?: ReturnType<typeof globalThis.setTimeout>;
  private settingsOnly = false;
  private recoverySignal?: Promise<void>;
  private nativeRecoveryPhase = "idle";
  private disposeConnectionMonitor?: () => void;

  async connect(
    listener: TelegramEventListener,
    options: TelegramConnectOptions = {},
  ): Promise<TelegramSnapshot> {
    this.resetSessionState();
    this.settingsOnly = options.settingsOnly === true;
    this.listener = listener;
    this.initialChatSyncPending = true;
    this.initialUserSyncPending = true;
    this.emitConnectionStatus("connecting");
    const status = await invoke<RuntimeStatus>("telegram_runtime_status");
    if (!status.linked) {
      const detail =
        status.error ??
        translate("未找到 tdjson 动态库。搜索路径：{{value0}}", { value0: status.searchedPaths.join("、") });
      throw new Error(detail);
    }
    if (!status.credentialsConfigured) {
      throw new Error(translate("TDLib 已加载，但缺少 NOTGRAM_API_ID / NOTGRAM_API_HASH。"));
    }

    this.updateStream = new TdUpdateStream(
      (updates, offset, budget) => this.handleUpdateBatch(updates, offset, budget),
      (error, fatal) => this.listener?.({ type: "sync.error", message: error instanceof Error ? error.message : String(error), fatal }),
      (batch, durationMs) => {
        if (isPerformanceMonitoringEnabled() && (batch.pendingCount >= 64 || batch.oldestAgeMs >= 1000)) {
          logPerformance("ui_tdlib_update_batch", { deliveryDurationMs: durationMs, batchCount: batch.updates.length,
            pendingUpdateCount: batch.pendingCount, oldestUpdateAgeMs: batch.oldestAgeMs });
        }
      },
    );
    try { await this.updateStream.start(); }
    catch (error) { this.updateStream.dispose(); throw error; }
    this.unlistenError = await listen<{ message: string }>(
      "telegram://bridge-error",
      (event) => {
        const error = new Error(event.payload.message);
        this.requestBroker.rejectAll(error);
        this.emitConnectionStatus("offline", { immediate: true });
        this.listener?.({ type: "sync.error", message: error.message, fatal: true });
      },
    );
    this.unlistenProxySettings = await listen("telegram://proxy-settings-changed", () => {
      this.listener?.({ type: "proxy.settingsChanged" });
    });
    await invoke("telegram_start");
    this.handleNativeConnectionState(await invoke<TdObject>("telegram_connection_state"));
    if (!this.settingsOnly) this.installConnectionRecoveryListeners();
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
      if (!this.settingsOnly) await invoke("telegram_shutdown");
    } finally {
      this.emitConnectionStatus("offline", { immediate: true });
      this.updateStream?.dispose();
      this.unlistenError?.();
      this.unlistenProxySettings?.();
      this.updateStream = undefined;
      this.unlistenError = undefined;
      this.unlistenProxySettings = undefined;
      this.requestBroker.rejectAll(new Error(translate("TDLib runtime 已关闭。")));
      this.listener = undefined;
      this.resetSessionState();
    }
  }

  private handleUpdateBatch(updates: TdObject[], offset = 0, budgetMs = Infinity) {
    if (offset >= updates.length) return 0;
    const startedAt = performance.now();
    let count = 0;
    const nestedBatch = this.handlingUpdateBatch;
    const shouldBatchFileUpdates = updates.length > 1;
    this.handlingUpdateBatch = nestedBatch || shouldBatchFileUpdates;
    try {
      do {
        this.handleUpdate(updates[offset + count]);
        count += 1;
      } while (offset + count < updates.length && performance.now() - startedAt < budgetMs);
    } finally {
      if (!nestedBatch) {
        this.handlingUpdateBatch = false;
        if (shouldBatchFileUpdates) this.flushPendingFileMessageUpdates();
      } else {
        this.handlingUpdateBatch = true;
      }
    }
    if (!isPerformanceMonitoringEnabled()) return count;
    const durationMs = performance.now() - startedAt;
    if (durationMs >= 4 || count >= 32) {
      const traceId = getActiveConversationTraceId();
      let messageUpdateCount = 0;
      let chatUpdateCount = 0;
      let fileUpdateCount = 0;
      let otherUpdateCount = 0;
      for (const update of updates.slice(offset, offset + count)) {
        const type = typeof update["@type"] === "string" ? update["@type"] : "";
        if (type === "updateFile") fileUpdateCount += 1;
        else if (type.startsWith("updateChat")) chatUpdateCount += 1;
        else if (type.includes("Message") || type === "updateNewMessage") messageUpdateCount += 1;
        else otherUpdateCount += 1;
      }
      logPerformance("ui_tdlib_update_batch", {
        startTimeMs: startedAt,
        durationMs,
        batchCount: count,
        traceId,
        duringConversationSwitch: traceId !== undefined,
        messageUpdateCount,
        chatUpdateCount,
        fileUpdateCount,
        otherUpdateCount,
      });
    }
    return count;
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

  async loadLocalState(accountId: string) {
    return (await invoke<import("./types").LocalUnsentState | null>("telegram_read_local_state", { accountId })) ?? undefined;
  }

  async saveLocalState(accountId: string, value: import("./types").LocalUnsentState) {
    if (this.settingsOnly) return;
    await invoke("telegram_write_local_state", { accountId, value });
  }

  async loadCachedSnapshot() {
    return this.accountStorage.loadCachedSnapshot();
  }

  async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    if (this.settingsOnly) return;
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
          first_name: identityTextField(action.firstName, 64, translate("名字"), true),
          last_name: identityTextField(action.lastName, 64, translate("姓氏")),
          disable_notification: false,
        });
    }
  }

  async getProxySettings() {
    return invoke<ProxySettings>("telegram_proxy_settings");
  }

  async saveProxySettings(settings: ProxySettings) {
    await invoke("telegram_save_proxy_settings", {
      preferences: proxyPreferences(settings), revision: settings.revision,
    });
  }

  async testProxy(settings: ProxySettings) {
    const current = settings.mode === "system" ? await this.getProxySettings() : settings;
    if (current.mode === "system" && current.systemStatus &&
        ["unavailable", "unsupported"].includes(current.systemStatus.kind) && !current.system) {
      throw new Error(translate("系统代理暂不可用，请检查系统代理设置"));
    }
    const endpoint = effectiveProxy(current);
    const response = await this.request({
      "@type": "pingProxy",
      proxy: endpoint ? proxyValue(endpoint) : null,
    });
    const seconds = tdNumber(response.seconds);
    if (seconds === undefined) throw new Error(translate("TDLib 未返回代理延迟"));
    return Math.max(0, Math.round(seconds * 1000));
  }

  async getStorageSettings() {
    return this.accountStorage.getStorageSettings();
  }

  async saveStorageSettings(settings: StorageSettings) {
    return this.accountStorage.saveStorageSettings(settings);
  }

  async getStorageInventory() {
    return invoke<StorageLayer[]>("telegram_storage_inventory");
  }

  async removeMigrationBackup(id: string) {
    return invoke<number>("telegram_remove_migration_backup", { id });
  }

  async getCacheUsage() {
    return this.accountStorage.getCacheUsage();
  }

  async clearMediaCache(input: import("./types").CacheCleanupInput) {
    const generation = this.hydrationGeneration;
    const deleted = await this.requestBroker.optimizeStorage(input.categories, input.olderThanDays, this.hydrationFocusChatId);
    if (generation !== this.hydrationGeneration) throw new Error("Account changed during cleanup");
    const result = await this.accountStorage.clearMediaCache(input);
    return { ...result, removedBytes: result.removedBytes + (tdNumber(deleted.size) ?? 0),
      removedFiles: result.removedFiles + (tdNumber(deleted.count) ?? 0) };
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

  async getChatAdministratorLabels(chatId: string): Promise<Record<string, string>> {
    return this.profileService.getChatAdministratorLabels(chatId);
  }

  async getChatMentionSuggestions(chatId: string, query: string, recentUserIds: readonly string[]): Promise<User[]> {
    return this.profileService.getChatMentionSuggestions(chatId, query, recentUserIds);
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
    if (!chat) throw new Error(translate("TDLib 未返回私聊"));
    return chat;
  }

  async createChat(input: CreateChatInput) {
    const title = identityTextField(input.title, 128, translate("名称"), true);
    const description = profileField(input.description ?? "", 255, translate("简介"));
    const username = profileField(input.username ?? "", 32, translate("公开用户名"));
    if (input.isPublic && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) {
      throw new Error(translate("公开用户名需包含 5 至 32 个英文字母、数字或下划线，并以字母开头"));
    }
    const memberUserIds = [...new Set(input.memberUserIds)];
    if (memberUserIds.length > 200) throw new Error(translate("初始成员不能超过 200 人"));
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
      if (!chatId) throw new Error(translate("TDLib 未返回新群组标识"));
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
      if (!chatId) throw new Error(translate("TDLib 未返回新超级群组标识"));
      if (numericUserIds.length > 0) {
        await this.request({
          "@type": "addChatMembers",
          chat_id: numericId(chatId),
          user_ids: numericUserIds,
        });
      }
      const type = asTdObject(rawChat.type);
      const supergroupId = tdId(type?.supergroup_id);
      if (!supergroupId) throw new Error(translate("TDLib 未返回超级群组类型信息"));
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
    if (!chat) throw new Error(translate("TDLib 未返回已创建的聊天"));
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
      throw new Error(translate("只有群组和频道支持成员管理"));
    }
    const isBasic = type["@type"] === "chatTypeBasicGroup";
    const chatType = isBasic
      ? "basicGroup" as const
      : type.is_channel === true ? "channel" as const : "supergroup" as const;
    const groupId = tdId(isBasic ? type.basic_group_id : type.supergroup_id);
    if (!groupId) throw new Error(translate("群组标识无效"));
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
    if (!capabilities.canOpenManagement) throw new Error(translate("当前账号没有群组管理权限"));
    const offset = Math.max(0, memberOffset);
    const administratorLabelsPromise = this.getChatAdministratorLabels(chatId).catch((): Record<string, string> => {
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
    await this.request({
      "@type": "setChatMemberTag",
      chat_id: numericId(chatId),
      user_id: numericId(userId),
      tag: normalizeIdentityText(tag),
    });
  }

  async setChatPermissions(chatId: string, permissions: ChatPermissions): Promise<void> {
    await this.request({ "@type": "setChatPermissions", chat_id: numericId(chatId), permissions: chatPermissionsObject(permissions) });
  }

  async setChatSlowModeDelay(chatId: string, delaySeconds: number): Promise<void> {
    const rawChat = this.rawChats.get(chatId) ?? await this.request({ "@type": "getChat", chat_id: numericId(chatId) });
    const type = asTdObject(rawChat.type);
    const supergroupId = tdId(type?.supergroup_id);
    if (!supergroupId || type?.["@type"] !== "chatTypeSupergroup" || type.is_channel === true) throw new Error(translate("慢速模式只适用于超级群组"));
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
      const summary = kind.replace(/^chatEventAction/, "").replace(/([A-Z])/g, " $1").trim() || translate("群组设置更新");
      return { id: tdId(event.id) || `${event.date ?? 0}`, date: new Date((tdNumber(event.date) ?? 0) * 1000).toISOString(), actor, summary, kind };
    }));
    const nextEventId = events.at(-1)?.id;
    return { events, nextEventId, hasMore: events.length >= Math.max(1, Math.min(limit, 100)) };
  }

  async getChatInviteLinks({ chatId, creatorUserId, revoked = false, offsetDate = 0, offsetLink = "", limit = 30 }: GetChatInviteLinksInput): Promise<ChatInviteLinkPage> {
    const creatorId = creatorUserId || this.currentUserId;
    if (!creatorId) throw new Error(translate("无法确定邀请链接创建者"));
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
    if (!link) throw new Error(translate("TDLib 未返回邀请链接"));
    return link;
  }

  async editChatInviteLink(input: CreateChatInviteLinkInput & { inviteLink: string }): Promise<ChatInviteLink> {
    const request = input.subscriptionStars && input.subscriptionStars > 0 ? {
      "@type": "editChatSubscriptionInviteLink", chat_id: numericId(input.chatId), invite_link: input.inviteLink, name: input.name.trim(),
    } : {
      "@type": "editChatInviteLink", chat_id: numericId(input.chatId), invite_link: input.inviteLink, name: input.name.trim(), expiration_date: input.expirationDate ?? 0, member_limit: input.memberLimit ?? 0, creates_join_request: input.createsJoinRequest === true,
    };
    const link = mapChatInviteLink(await this.request(request));
    if (!link) throw new Error(translate("TDLib 未返回已更新的邀请链接"));
    return link;
  }

  async revokeChatInviteLink(chatId: string, inviteLink: string): Promise<ChatInviteLink> {
    const link = mapChatInviteLink(await this.request({ "@type": "revokeChatInviteLink", chat_id: numericId(chatId), invite_link: inviteLink }));
    if (!link) throw new Error(translate("TDLib 未返回已撤销的邀请链接"));
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
    if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error(translate("机器人用户名无效"));
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
    throw new Error(translate("找不到这个机器人"));
  }

  async getBotCommandSuggestions(
    chatId: string,
    query = "",
    botUsername?: string,
  ): Promise<BotCommandSuggestion[]> {
    let commandGroups: TdObject[] = [];
    let canDiscoverGroupBots = false;
    if (botUsername) {
      // In a private bot chat the peer id is authoritative. Searching public
      // chats for every slash keystroke fails for bots that are not returned by
      // searchPublicChats (and is unnecessary network work).
      const chat = this.rawChats.get(chatId);
      const type = asTdObject(chat?.type);
      let bot: { userId: string; username: string } | undefined;
      if (type?.["@type"] === "chatTypePrivate") {
        const peerId = tdId(type.user_id);
        if (peerId) {
          const peer = await this.loadUser(peerId).catch(() => undefined);
          const rawUsernames = asTdObject(this.rawUsers.get(peerId)?.usernames);
          const peerUsernames = [
            rawUsernames?.editable_username,
            ...(Array.isArray(rawUsernames?.active_usernames) ? rawUsernames.active_usernames : []),
          ].filter((value): value is string => typeof value === "string" && Boolean(value));
          const requestedUsername = botUsername.replace(/^@/, "").trim().toLocaleLowerCase();
          const peerUsername = peerUsernames.find(
            (candidate) => candidate.toLocaleLowerCase() === requestedUsername,
          ) ?? peer?.username ?? "";
          if (peer?.isBot && (
            !botUsername ||
            peerUsername.toLocaleLowerCase() === requestedUsername
          )) {
            bot = { userId: peerId, username: peerUsername };
          }
        }
      }
      if (!bot) bot = await this.resolveBotUser(botUsername);
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
          try {
            const full = await this.request({ "@type": "getBasicGroupFullInfo", basic_group_id: numericId(groupId) });
            commandGroups = asTdObjects(full.bot_commands);
          } catch {
            // Bot commands can still be discovered from bot members when full
            // group metadata is unavailable or stale.
          }
        }
      } else if (type?.["@type"] === "chatTypeSupergroup") {
        canDiscoverGroupBots = true;
        const groupId = tdId(type.supergroup_id);
        if (groupId) {
          try {
            const full = await this.request({ "@type": "getSupergroupFullInfo", supergroup_id: numericId(groupId) });
            commandGroups = asTdObjects(full.bot_commands);
          } catch {
            // Bot commands can still be discovered from bot members when full
            // group metadata is unavailable or stale.
          }
        }
      }
    }
    const needsGroupBotDiscovery = canDiscoverGroupBots && (
      commandGroups.length === 0 ||
      commandGroups.some((group) => asTdObjects(group.commands).length === 0)
    );
    if (needsGroupBotDiscovery) {
      let discoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        const members = await Promise.race([
          this.request({
            "@type": "searchChatMembers",
            chat_id: numericId(chatId),
            query: "",
            limit: 200,
            filter: { "@type": "chatMembersFilterBots" },
          }),
          new Promise<TdObject | undefined>((resolve) => {
            discoveryTimer = globalThis.setTimeout(
              () => resolve(undefined),
              GROUP_BOT_DISCOVERY_TIMEOUT_MS,
            );
          }),
        ]);
        if (members) {
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
      } catch {
        // Some groups hide member search from non-administrators. Preserve
        // commands already returned in *GroupFullInfo instead of dropping all
        // suggestions because the optional discovery request failed.
      } finally {
        if (discoveryTimer) globalThis.clearTimeout(discoveryTimer);
      }
    }
    const normalized = query.replace(/^\//, "").toLocaleLowerCase();
    const suggestions = await Promise.all(commandGroups.map(async (group) => {
      const botUserId = tdId(group.bot_user_id);
      if (!botUserId) return [];
      const commands = asTdObjects(group.commands);
      if (commands.length === 0) return [];
      let username = "";
      try {
        username = (await this.loadUser(botUserId))?.username ?? "";
      } catch {
        // Commands remain useful even if a deleted/inaccessible bot profile can't be loaded.
      }
      return commands.flatMap((raw) => {
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
      const messageText = typeof formatted?.text === "string" ? formatted.text : typeof raw.title === "string" ? raw.title : translate("Inline 结果");
      const kind = raw["@type"] === "inlineQueryResultPhoto" ? "photo" : raw["@type"] === "inlineQueryResultVideo" ? "video" : raw["@type"] === "inlineQueryResultDocument" ? "file" : "article";
      return [{ id, kind, title: typeof raw.title === "string" ? raw.title : translate("Inline 结果"), description: typeof raw.description === "string" ? raw.description : undefined, messageText, fileName: typeof raw.title === "string" ? raw.title : undefined }];
    });
    const nextOffset = typeof result.next_offset === "string" && result.next_offset ? result.next_offset : undefined;
    return { queryId: String(result.inline_query_id ?? ""), results: mapped, nextOffset, hasMore: Boolean(nextOffset) };
  }

  async sendInlineQueryResultMessage(chatId: string, botUserId: string, queryId: string, resultId: string, replyToMessageId?: string, topicId?: string): Promise<void> {
    void botUserId;
    await this.request({ "@type": "sendInlineQueryResultMessage", chat_id: numericId(chatId), topic_id: forumTopicObject(topicId), reply_to: replyToMessageId ? { "@type": "inputMessageReplyToMessage", message_id: numericId(replyToMessageId), quote: null, checklist_task_id: 0 } : null, options: { "@type": "messageSendOptions", disable_notification: false, from_background: false, protect_content: false, update_order_of_installed_sticker_sets: false, scheduling_state: null, paid_message_star_count: 0 }, query_id: numericId(queryId), result_id: resultId, hide_via_bot: false });
  }

  async sendBotStartMessage(chatId: string, botUserId: string, parameter = ""): Promise<void> {
    await this.request({ "@type": "sendBotStartMessage", bot_user_id: numericId(botUserId), chat_id: numericId(chatId), parameter });
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
        const mappedChat = chat ? this.mapChat(chat) : undefined;
        return chat && id ? {
          id,
          kind: "chat" as const,
          title: mappedChat?.title ?? translate("已屏蔽频道"),
          avatar: mappedChat?.avatar ?? { label: "?", color: "#73808c" },
        } : undefined;
      }
      return undefined;
    }));
    return senders.filter((sender): sender is BlockedSender => Boolean(sender));
  }

  async setMessageSenderBlocked(senderId: string, kind: "user" | "chat", blocked: boolean): Promise<void> {
    const generation = this.sessionGeneration;
    await this.request({ "@type": "setMessageSenderBlockList", sender_id: kind === "user" ? { "@type": "messageSenderUser", user_id: numericId(senderId) } : { "@type": "messageSenderChat", chat_id: numericId(senderId) }, block_list: blocked ? { "@type": "blockListMain" } : null });
    if (generation !== this.sessionGeneration) return;
    for (const [chatId, raw] of this.rawChats) {
      const type = asTdObject(raw.type);
      if (kind === "chat" ? chatId === senderId :
        type?.["@type"] === "chatTypePrivate" && tdId(type.user_id) === senderId) {
        this.patchChat(chatId, { block_list: blocked ? { "@type": "blockListMain" } : null });
      }
    }
  }

  async getChatReportOptions(chatId: string, messageIds: string[]): Promise<ChatReportResult> {
    return this.reportChat({ chatId, messageIds, optionId: "", text: "" });
  }

  async reportChat(input: ReportChatInput): Promise<ChatReportResult> {
    return mapChatReportResult(await this.request(chatReportRequest(input)));
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
    const generation = this.sessionGeneration;
    const parsed = parseTelegramUrl(url);
    if (!parsed) return undefined;

    const inviteLink = telegramInviteLink(url);
    if (inviteLink) {
      const raw = await this.request({ "@type": "checkChatInviteLink", invite_link: inviteLink });
      if (generation !== this.sessionGeneration) return undefined;
      const preview = mapChatInvitePreview(this.fileStates.resolve(raw), inviteLink);
      if (preview.chatId) {
        const chat = await this.refreshChatMembership(preview.chatId).catch(() => undefined);
        if (generation !== this.sessionGeneration) return undefined;
        if (chat?.isMember === true) return { chatId: chat.id };
      }
      // A nonzero chat_id may only grant temporary preview access. It never
      // authorizes sending or means that an approval request has succeeded.
      return { kind: "chatInvite", preview };
    }

    const stickerName = telegramStickerSetName(url);
    if (stickerName) {
      const raw = await this.request({ "@type": "searchStickerSet", name: stickerName, ignore_cache: false });
      if (asTdObject(raw.sticker_type)?.["@type"] !== "stickerTypeRegular") {
        return unsupportedTelegramLink("internalLinkTypeStickerSet");
      }
      const stickerSet = mapEmojiStickerSet(raw);
      if (!stickerSet) throw new Error(translate("找不到贴纸包"));
      return { kind: "stickerSet", stickerSet };
    }

    const knownUnsupported = knownUnsupportedTelegramLink(parsed.href);
    if (knownUnsupported) return knownUnsupported;

    if (parsed.protocol === "tg:" && parsed.hostname.toLowerCase() === "user") {
      const userId = parsed.searchParams.get("id");
      if (!userId || !/^-?\d+$/.test(userId)) {
        return unsupportedTelegramLink(undefined, translate("Telegram 用户链接无效"));
      }
      const rawUser = this.rawUsers.get(userId) ?? await this.request({
        "@type": "getUser",
        user_id: numericId(userId),
      }).catch(() => undefined);
      if (!rawUser || !tdId(rawUser.id)) {
        return unsupportedTelegramLink(undefined, translate("找不到链接中的 Telegram 用户"));
      }
      this.upsertUser(rawUser);
      return { kind: "user", userId };
    }

    let rawLinkType = await this.request({
      "@type": "getInternalLinkType",
      link: parsed.toString(),
    }).catch(() => undefined);
    if (generation !== this.sessionGeneration) return undefined;
    const legacyStart = rawLinkType?.["@type"] === "internalLinkTypePublicChat"
      ? telegramBotStartParameters(parsed.href)
      : undefined;
    if (legacyStart?.parameter.includes("=")) {
      // TDLib drops non-base64url payloads when classifying links. Ask it for
      // the same bot's start policy without the payload, then restore it verbatim.
      // Do not infer autostart from cached messages or mark the link as trusted.
      const startType = await this.request({
        "@type": "getInternalLinkType",
        link: `https://t.me/${legacyStart.botUsername}?start`,
      }).catch(() => undefined);
      if (generation !== this.sessionGeneration) return undefined;
      if (startType?.["@type"] !== "internalLinkTypeBotStart" ||
        String(startType.bot_username).toLowerCase() !== legacyStart.botUsername.toLowerCase()) {
        return unsupportedTelegramLink("internalLinkTypeBotStart", translate("Telegram 机器人链接无效"));
      }
      rawLinkType = { ...startType, start_parameter: legacyStart.parameter };
    }
    const linkType = typeof rawLinkType?.["@type"] === "string"
      ? rawLinkType["@type"]
      : undefined;
    if (linkType === "internalLinkTypeBotStart") {
      const botUsername = typeof rawLinkType?.bot_username === "string"
        ? rawLinkType.bot_username
        : "";
      const parameter = typeof rawLinkType?.start_parameter === "string"
        ? rawLinkType.start_parameter
        : "";
      if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
        return unsupportedTelegramLink(linkType, translate("Telegram 机器人链接无效"));
      }
      const rawChat = await this.request({
        "@type": "searchPublicChat",
        username: botUsername,
      }).catch(() => undefined);
      if (generation !== this.sessionGeneration) return undefined;
      const chatId = tdId(rawChat?.id);
      const chatType = asTdObject(rawChat?.type);
      const botUserId = tdId(chatType?.user_id);
      if (!rawChat || !chatId || chatType?.["@type"] !== "chatTypePrivate" || !botUserId) {
        return unsupportedTelegramLink(linkType, translate("找不到链接中的 Telegram 机器人"));
      }
      const rawUser = this.rawUsers.get(botUserId) ?? await this.request({
        "@type": "getUser",
        user_id: numericId(botUserId),
      }).catch(() => undefined);
      if (generation !== this.sessionGeneration) return undefined;
      if (asTdObject(rawUser?.type)?.["@type"] !== "userTypeBot") {
        return unsupportedTelegramLink(linkType, translate("链接目标不是 Telegram 机器人"));
      }
      this.upsertUser(rawUser);
      this.upsertChat(rawChat);
      return {
        kind: "botStart",
        chatId,
        botUserId,
        parameter,
        autostart: rawLinkType?.autostart === true,
      };
    }
    if (linkType === "internalLinkTypeUserPhoneNumber") {
      const phoneNumber = typeof rawLinkType?.phone_number === "string"
        ? rawLinkType.phone_number
        : undefined;
      if (!phoneNumber) return unsupportedTelegramLink(linkType, translate("Telegram 用户链接无效"));
      const rawUser = await this.request({
        "@type": "searchUserByPhoneNumber",
        phone_number: phoneNumber,
        only_local: false,
      }).catch(() => undefined);
      const userId = tdId(rawUser?.id);
      if (!rawUser || !userId) {
        return unsupportedTelegramLink(linkType, translate("找不到链接中的 Telegram 用户"));
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
      if (generation !== this.sessionGeneration) return undefined;
      const linkedChatId = tdId(linkInfo?.chat_id) || tdId(linkedMessage?.chat_id);
      const linkedMessageId = tdId(linkedMessage?.id);
      if (linkedChatId && linkedMessageId) {
        // Always refresh the target chat for a deep link. rawChats may contain a
        // stale entry after a group/channel was deleted during this session.
        const rawChat = await this.request({
          "@type": "getChat",
          chat_id: numericId(linkedChatId),
        }).catch(() => undefined);
        // TDLib can still return the numeric chat_id for a message link after the
        // group/channel has been deleted or is no longer accessible. Do not expose
        // that stale id to the UI, otherwise it becomes an empty active conversation.
        if (generation !== this.sessionGeneration) return undefined;
        if (!rawChat) {
          return unsupportedTelegramLink(linkType, translate("链接目标会话不存在或当前账号无权访问"));
        }
        if (!this.mapChat(rawChat)) {
          return unsupportedTelegramLink(linkType, translate("链接目标会话不存在或当前账号无权访问"));
        }
        this.upsertChat(rawChat);
        await this.refreshChatMembership(linkedChatId);
        if (generation !== this.sessionGeneration) return undefined;
        this.emitMessage(linkedMessage);
        return { chatId: linkedChatId, messageId: linkedMessageId };
      }
      return unsupportedTelegramLink(linkType, translate("找不到链接中的 Telegram 消息，或当前账号无权访问"));
    }
    if (parsed.protocol !== "tg:" && path[0]?.toLowerCase() === "c" && /^\d+$/.test(path[1] ?? "")) {
      const internalChatId = `-100${path[1]}`;
      const raw = await this.request({ "@type": "getChat", chat_id: numericId(internalChatId) }).catch(() => undefined);
      if (raw && this.mapChat(raw)) {
        this.upsertChat(raw);
        return { chatId: internalChatId };
      }
      return unsupportedTelegramLink(undefined, translate("找不到链接中的 Telegram 会话，或当前账号无权访问"));
    }
    const domain = linkType === "internalLinkTypePublicChat" && typeof rawLinkType?.chat_username === "string"
      ? rawLinkType.chat_username
      : parsed.protocol === "tg:" ? parsed.searchParams.get("domain") : path[0];
    if (!domain || !/^[A-Za-z0-9_]{5,32}$/.test(domain)) {
      return unsupportedTelegramLink(linkType ?? "internalLinkTypeUnknownDeepLink");
    }
    const raw = await this.request({ "@type": "searchPublicChat", username: domain }).catch(() => undefined);
    if (generation !== this.sessionGeneration) return undefined;
    if (!raw) return unsupportedTelegramLink(linkType, translate("找不到链接中的 Telegram 会话或用户"));
    const chatId = tdId(raw.id);
    const chatType = asTdObject(raw.type);
    if (!chatId || !["chatTypePrivate", "chatTypeSupergroup", "chatTypeBasicGroup"].includes(String(chatType?.["@type"]))) {
      return unsupportedTelegramLink(linkType, translate("此 Telegram 会话类型暂时无法在 Notgram 中打开"));
    }
    this.upsertChat(raw);
    if (chatType?.["@type"] !== "chatTypePrivate") await this.refreshChatMembership(chatId);
    if (generation !== this.sessionGeneration) return undefined;
    return { chatId };
  }

  async refreshChatMembership(chatId: string): Promise<Chat> {
    const generation = this.sessionGeneration;
    const raw = await this.refreshChat(chatId);
    if (generation !== this.sessionGeneration) throw new Error(translate("账号已切换"));
    const type = asTdObject(raw.type);
    if (type?.["@type"] === "chatTypeBasicGroup") {
      const group = await this.request({ "@type": "getBasicGroup", basic_group_id: type.basic_group_id });
      if (generation !== this.sessionGeneration) throw new Error(translate("账号已切换"));
      this.upsertBasicGroup(group);
    } else if (type?.["@type"] === "chatTypeSupergroup") {
      const group = await this.request({ "@type": "getSupergroup", supergroup_id: type.supergroup_id });
      if (generation !== this.sessionGeneration) throw new Error(translate("账号已切换"));
      this.upsertSupergroup(group);
    }
    const chat = this.mapChat(raw);
    if (!chat) throw new Error(translate("无法读取会话状态"));
    return chat;
  }

  async joinChat(input: JoinChatInput): Promise<JoinChatResult> {
    const generation = this.sessionGeneration;
    let request: TdObject;
    if ("inviteLink" in input) {
      const inviteLink = telegramInviteLink(input.inviteLink);
      if (!inviteLink) throw new Error(translate("邀请链接无效或已过期"));
      const info = await this.request({ "@type": "checkChatInviteLink", invite_link: inviteLink });
      if (generation !== this.sessionGeneration) throw new Error(translate("账号已切换"));
      const preview = mapChatInvitePreview(info, inviteLink);
      if (preview.requiresSubscription) throw new Error(translate("此邀请需要付费订阅，Notgram 暂不支持通过此链接加入"));
      request = { "@type": "joinChatByInviteLink", invite_link: inviteLink };
    } else {
      request = { "@type": "joinChat", chat_id: numericId(input.chatId) };
    }
    const raw = await this.request(request);
    if (generation !== this.sessionGeneration) throw new Error(translate("账号已切换"));
    const result = mapChatJoinResult(raw);
    if (result.kind === "joined") {
      // Joining is committed. Failed metadata reads must not repeat the join.
      await this.refreshChatMembership(result.chatId).catch(() => undefined);
      if (generation !== this.sessionGeneration) throw new Error(translate("账号已切换"));
    }
    return result;
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
    if (!currentSettings) throw new Error(translate("无法读取会话通知设置"));
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
    const generation = this.sessionGeneration;
    await this.request({
      "@type": "leaveChat",
      chat_id: numericId(chatId),
    });
    if (generation !== this.sessionGeneration) return;
    // List positions can survive leaving a public chat; membership is authoritative.
    await this.refreshChatMembership(chatId);
  }

  async deletePrivateChat(chatId: string) {
    const generation = this.sessionGeneration;
    const raw = await this.refreshChat(chatId);
    if (generation !== this.sessionGeneration) return;
    if (this.mapChat(raw)?.kind !== "direct" || raw.can_be_deleted_only_for_self !== true) {
      throw new Error(translate("此会话不支持仅为自己删除"));
    }
    this.localHistoryDeleteIntents.add(chatId);
    let lastMessageId = this.deletedHistory.get(chatId) ?? "0";
    // Pending/scheduled IDs can be ahead of delivered messages. They must not
    // become a boundary that rejects later successful deliveries.
    for (const message of [...(this.rawMessages.get(chatId)?.values() ?? []), asTdObject(raw.last_message)]) {
      const id = tdId(message?.id);
      if (message && !message.sending_state && message.is_scheduled !== true && /^[1-9]\d*$/.test(id) &&
        BigInt(id) > BigInt(lastMessageId)) lastMessageId = id;
    }
    try {
      await this.request({
        "@type": "deleteChatHistory",
        chat_id: numericId(chatId),
        remove_from_chat_list: true,
        revoke: false,
      });
      if (generation !== this.sessionGeneration) return;
      this.deletedHistory.set(chatId, lastMessageId);
      this.deleteMessages({ chat_id: chatId, message_ids: [...(this.rawMessages.get(chatId)?.keys() ?? [])]
        .filter(id => isInDeletedHistory(id, lastMessageId)), is_permanent: true });
      this.localHistoryDeleteIntents.delete(chatId);
      this.listener?.({ type: "chat.historyDeleted", chatId, lastMessageId });
      // Deletion is committed. A failed follow-up read must not invite a retry
      // that could delete messages received after the original confirmation.
      await this.refreshChat(chatId).catch(() => undefined);
    } finally {
      if (generation === this.sessionGeneration) this.localHistoryDeleteIntents.delete(chatId);
    }
  }

  async createChatFolder(title: string, chatIds: string[]) {
    const includedChatIds = [...new Set(chatIds)].map(numericId);
    if (includedChatIds.length > FOLDER_DIRECT_CHAT_LIMIT) {
      throw new Error(translate("文件夹最多可直接包含 {{value0}} 个会话", { value0: FOLDER_DIRECT_CHAT_LIMIT }));
    }
    const info = await this.request({
      "@type": "createChatFolder",
      folder: this.newChatFolder(title, includedChatIds),
    });
    const folder = this.upsertFolderInfo(info);
    // Folder creation is already confirmed by createChatFolder. A stale chat
    // can disappear between selection and refresh; one failed refresh must not
    // turn a successful folder creation into a misleading error.
    await Promise.allSettled([...new Set(chatIds)].map((chatId) => this.refreshChat(chatId)));
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
      this.mapChat(raw)?.folderIds.includes(folderId) ||
        asTdObjects(raw.chat_lists).some((list) => chatListKey(list) === folderId) ? [chatId] : []
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

  async reorderChatFolders(folderIds: string[]) {
    const uniqueIds = [...new Set(folderIds)];
    const customFolderIds = uniqueIds
      .filter((folderId) => folderId !== "main")
      .map(chatFolderNumericId);
    const currentFolderIds = this.rawFolderInfos.map((info) => tdNumber(info.id));
    if (
      uniqueIds.length !== this.rawFolderInfos.length + 1 ||
      !uniqueIds.includes("main") ||
      currentFolderIds.some((folderId) =>
        folderId === undefined || !customFolderIds.includes(folderId)
      )
    ) {
      throw new Error(translate("文件夹顺序不完整"));
    }
    const mainChatListPosition = uniqueIds.indexOf("main");
    await this.request({
      "@type": "reorderChatFolders",
      chat_folder_ids: customFolderIds,
      main_chat_list_position: mainChatListPosition,
    });

    const infoById = new Map(this.rawFolderInfos.map((info) => [tdNumber(info.id), info]));
    // A concurrent folder creation/deletion supersedes the submitted membership set.
    // Do not drop new folders or reinsert deleted folders when the request completes.
    if (infoById.size !== customFolderIds.length || customFolderIds.some((id) => !infoById.has(id))) return;
    this.rawFolderInfos = customFolderIds.map((folderId) => infoById.get(folderId)!);
    this.mainChatListPosition = mainChatListPosition;
    this.emitFolders();
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
    const directChatCount = new Set([...pinned, ...alwaysIncluded]).size;
    if (included && !alwaysIncluded.includes(numericChatId) && directChatCount >= FOLDER_DIRECT_CHAT_LIMIT) {
      throw new Error(translate("文件夹最多可直接包含 {{value0}} 个会话", { value0: FOLDER_DIRECT_CHAT_LIMIT }));
    }
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

  resetSyncState() {
    this.syncGeneration += 1;
    this.refreshedChats.clear();
    this.chatRefreshes.clear();
    this.historyCursors.clear();
    this.exhaustedHistories.clear();
    this.historyLoads.clear();
    this.forumTopicService.reset();
    this.chatListLoads.clear();
    this.exhaustedChatLists.clear();
    this.chatListsNeedingRefresh = new Set(this.chatListCounts.keys());
    this.chatListIds.clear();
  }

  discardChatHistoryCache(chatId: string) {
    if (this.historyLoads.has(chatId)) return;
    this.exhaustedHistories.delete(chatId);
    this.historyCursors.delete(chatId);
    for (const id of this.rawMessages.get(chatId)?.keys() ?? []) this.unindexMessageFiles(chatId, id);
    this.rawMessages.delete(chatId);
  }

  async loadChatHistory(chatId: string, limit = 30, request?: HistoryPageRequest): Promise<ChatHistoryPage> {
    chatId = this.canonicalChatId(chatId);
    if (!request && this.exhaustedHistories.has(chatId)) {
      return { loadedCount: 0, hasMore: false, messageIds: [] };
    }
    const key = request ? `${chatId}:${request.purpose}:${request.fromMessageId ?? "latest"}:${Math.max(1, Math.min(limit, 100))}` : chatId;
    const existing = this.historyLoads.get(key);
    if (existing) return existing;

    const load = this.loadNextHistoryPage(chatId, Math.max(1, Math.min(limit, 100)), request)
      .finally(() => {
        if (this.historyLoads.get(key) === load) this.historyLoads.delete(key);
      });
    this.historyLoads.set(key, load);
    return load;
  }

  async getChatSponsoredMessages(chatId: string): Promise<ChatSponsoredMessages> {
    chatId = this.canonicalChatId(chatId);
    const result = await this.request({
      "@type": "getChatSponsoredMessages",
      chat_id: numericId(chatId),
    });
    return mapTdSponsoredMessages(result, chatId);
  }

  async clickChatSponsoredMessage(
    chatId: string,
    messageId: string,
    isMediaClick = false,
  ) {
    await this.request({
      "@type": "clickChatSponsoredMessage",
      chat_id: numericId(this.canonicalChatId(chatId)),
      message_id: numericId(messageId),
      is_media_click: isMediaClick,
      from_fullscreen: false,
    });
  }

  async getForumTopics(input: GetForumTopicsInput): Promise<ForumTopicPage> {
    return this.forumTopicService.getForumTopics(input);
  }

  async getForumTopic(chatId: string, topicId: string): Promise<ForumTopic | undefined> {
    return this.forumTopicService.getForumTopic(chatId, topicId);
  }

  async loadForumTopicHistory(chatId: string, topicId: string, limit = 30, request?: HistoryPageRequest): Promise<ChatHistoryPage> {
    return this.forumTopicService.loadForumTopicHistory(chatId, topicId, limit, request);
  }

  async getMessageThreadHistory(chatId: string, messageId: string, limit = 100, fromMessageId?: string) {
    return this.messageMediaService.getMessageThreadHistory(chatId, messageId, limit, fromMessageId);
  }

  async getMessageThread(chatId: string, messageId: string) {
    return this.messageMediaService.getMessageThread(chatId, messageId);
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

  async getRawMessage(chatId: string, messageId: string) {
    return this.messageMediaService.getRawMessage(chatId, messageId);
  }

  async getMessageProperties(
    chatId: string,
    messageId: string,
  ): Promise<MessagePermissions> {
    const properties = await this.messageMediaService.getMessageProperties(chatId, messageId);
    const chatPinPermission = await this.chatPinPermission(chatId);
    return chatPinPermission === false
      ? { ...properties, canPin: false }
      : properties;
  }

  async setMessageReaction(input: SetMessageReactionInput) {
    return this.messageMediaService.setMessageReaction(input);
  }

  async getMessageReactionSenders(input: GetMessageReactionSendersInput) {
    return this.messageMediaService.getMessageReactionSenders(input);
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

  async addStickerSet(stickerSetId: string) {
    return this.messageMediaService.addStickerSet(stickerSetId);
  }

  async removeStickerSet(stickerSetId: string) {
    return this.messageMediaService.removeStickerSet(stickerSetId);
  }

  async getStickerOutline(fileId: number) {
    return this.messageMediaService.getStickerOutline(fileId);
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
    const key = `${this.canonicalChatId(input.chatId)}:${input.messageId}`;
    this.localDeleteIntents.add(key);
    try {
      const result = await this.messageMediaService.deleteMessage(input);
      this.invalidatedMessageIds.add(key);
      return result;
    } catch (error) {
      this.localDeleteIntents.delete(key);
      throw error;
    }
  }

  async forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult> {
    return this.messageMediaService.forwardMessages(input);
  }

  async sendMediaCopy(input: SendMediaCopyInput) {
    return this.messageMediaService.sendMediaCopy(input);
  }

  async setChatDraft(input: SetChatDraftInput) {
    return this.messageMediaService.setChatDraft(input);
  }

  async setChatTyping(chatId: string, typing: boolean, topicId?: string) {
    return this.messageMediaService.setChatTyping(chatId, typing, topicId);
  }

  async downloadFile(fileId: number, fileName: string, sourcePath?: string) {
    return this.messageMediaService.downloadFile(fileId, fileName, sourcePath);
  }

  async cancelFileDownload(fileId: number) {
    return this.messageMediaService.cancelFileDownload(fileId);
  }

  async openFile(sourcePath: string) {
    return this.messageMediaService.openFile(sourcePath);
  }

  async saveFileToDownloads(sourcePath: string, fileName: string) {
    return this.messageMediaService.saveFileToDownloads(sourcePath, fileName);
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

  releaseFile(fileId: number) {
    this.messageMediaService.releaseFile(fileId);
  }

  resolveRemoteFile(remoteId: string) {
    return this.messageMediaService.resolveRemoteFile(remoteId);
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
    chatId = this.canonicalChatId(chatId);
    const rawChat = this.rawChats.get(chatId) ?? await this.refreshChat(chatId);
    const unreadCount = tdNumber(rawChat.unread_count) ?? 0;
    const isMarkedAsUnread = rawChat.is_marked_as_unread === true;
    if (unreadCount === 0 && !isMarkedAsUnread) return;
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
    if (isMarkedAsUnread) {
      await this.request({
        "@type": "toggleChatIsMarkedAsUnread",
        chat_id: numericId(chatId),
        is_marked_as_unread: false,
      });
    }
    // A TDLib update received during either request owns the newer chat snapshot.
    if (this.rawChats.get(chatId) === rawChat) {
      this.upsertChat({
        ...rawChat,
        unread_count: unreadCount > 0 ? 0 : rawChat.unread_count,
        is_marked_as_unread: isMarkedAsUnread ? false : rawChat.is_marked_as_unread,
        last_read_inbox_message_id: unreadCount > 0 && lastMessageId !== undefined
          ? lastMessageId
          : rawChat.last_read_inbox_message_id,
      });
    }
  }

  async markForumTopicRead(chatId: string, topicId: string, messageId: string) {
    chatId = this.canonicalChatId(chatId);
    numericId(topicId);
    await this.request({
      "@type": "viewMessages",
      chat_id: numericId(chatId),
      message_ids: [numericId(messageId)],
      source: { "@type": "messageSourceChatHistory" },
      force_read: true,
    });
  }

  async markMessageThreadRead(chatId: string, messageIds: string[]) {
    if (messageIds.length === 0) return;
    await this.request({
      "@type": "viewMessages",
      chat_id: numericId(this.canonicalChatId(chatId)),
      message_ids: [...new Set(messageIds.map(numericId))],
      source: { "@type": "messageSourceMessageThreadHistory" },
      force_read: true,
    });
  }

  async markMessageAttentionRead(chatId: string, messageIds: string[]) {
    chatId = this.canonicalChatId(chatId);
    const uniqueMessageIds = [...new Set(messageIds.map(numericId))];
    if (uniqueMessageIds.length === 0) return;
    await this.request({
      "@type": "viewMessages",
      chat_id: numericId(chatId),
      message_ids: uniqueMessageIds,
      source: { "@type": "messageSourceChatHistory" },
      force_read: true,
    });
  }

  async markAllChatReactionsRead(chatId: string) {
    await this.request({
      "@type": "readAllChatReactions",
      chat_id: numericId(this.canonicalChatId(chatId)),
    });
  }

  private async loadNextHistoryPage(
    chatId: string,
    targetCount: number,
    request?: HistoryPageRequest,
  ): Promise<ChatHistoryPage> {
    const generation = this.syncGeneration;
    const rawMessages: TdObject[] = [];
    const result = await loadHistoryWindow({
      chatId,
      targetCount,
      cursor: request ? (request.fromMessageId ? numericId(request.fromMessageId) : 0) : this.historyCursors.get(chatId) ?? 0,
      // Stage the entire window: a timeout on a later TDLib page must not
      // consume messages or advance the committed cursor before the UI gets them.
      knownMessages: new Map(this.rawMessages.get(chatId)),
      request: async (request) => {
        const response = await this.request(request);
        this.assertSyncGeneration(generation);
        return response;
      },
      emitMessage: (message) => rawMessages.push(message),
    });
    this.assertSyncGeneration(generation);
    const messages = this.emitMessages(rawMessages, true, false);
    if (!request) {
      this.historyCursors.set(chatId, result.cursor);
      if (result.exhausted) this.exhaustedHistories.add(chatId);
    }

    return {
      loadedCount: result.loadedCount,
      hasMore: !result.exhausted,
      messageIds: result.messageIds,
      messages,
      stalled: result.stalled,
      nextFromMessageId: result.cursor ? String(result.cursor) : undefined,
    };
  }

  private async request(request: TdObject, timeoutMs?: number) {
    const generation = this.sessionGeneration;
    const response = await this.requestBroker.request(request, timeoutMs);
    if (generation !== this.sessionGeneration) throw new Error("TDLib session superseded");
    return this.fileStates.resolve(response);
  }

  private assertSyncGeneration(generation: number) {
    if (generation !== this.syncGeneration) throw new Error("TDLib synchronization superseded");
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
    replyToMessageId?: string,
    replyQuote?: { text: string; position: number },
    disableNotification = false,
  ) {
    return this.requestBroker.requestPreparedPastedFiles(chatId, files, caption, (error) => {
      this.listener?.({ type: "sync.error", message: error.message, fatal: false });
    }, topicId, captionEntities, replyToMessageId, replyQuote, disableNotification);
  }


  private requestPreparedProfilePhoto() {
    return this.requestBroker.requestPreparedProfilePhoto();
  }

  private requestPreparedChatPhoto(chatId: string) {
    return this.requestBroker.requestPreparedChatPhoto(chatId);
  }

  private handleUpdate(update: TdObject) {
    this.fileStates.observe(update);
    if (update["@type"] === "updateNotgramConnectionState") {
      this.handleNativeConnectionState(update);
      return;
    }
    if (this.requestBroker.settle(update)) {
      // Consume replies before the next update in this native batch, rather
      // than when the awaiting request resumes after the whole batch.
      if (update["@type"] === "chat") this.cacheChat(update);
      return;
    }
    routeTdUpdate(update, this.updateHandlers);
  }

  private handleAuthorizationUpdate(update: TdObject) {
    const state = asTdObject(update.authorization_state);
    if (!state) return;
    const mapped = mapAuthorizationState(state);
    this.authorizationReady = mapped.kind === "ready";
    this.listener?.({ type: "authorization.changed", state: mapped });
    if (mapped.kind === "ready") this.startBootstrap();
    if (mapped.kind === "closing" || mapped.kind === "closed") {
      this.emitConnectionStatus("offline", { immediate: true });
    }
  }

  private handleConnectionUpdate(update: TdObject) {
    const state = tdConnectionState(update);
    const status = mapTdConnectionStatus(state);
    if (!status || this.nativeRecoveryPhase !== "idle") return;
    this.tdConnectionStatus = status;

    this.emitConnectionStatus(
      status === "online" && (this.initialChatSyncPending || this.bootstrapFailed) ? "syncing" : status,
    );

    if (status === "online" && this.authorizationReady && !this.bootstrapComplete) this.startBootstrap();
  }

  private emitConnectionStatus(status: ConnectionStatus, options?: { immediate?: boolean }) {
    if (status !== "online") {
      if (this.connectionSyncTimer) globalThis.clearTimeout(this.connectionSyncTimer);
      this.connectionSyncTimer = undefined;
      if (this.hasEstablishedConnection) this.connectionSyncPending = true;
    }
    const immediate = options?.immediate === true ||
      !this.hasEstablishedConnection ||
      status === "online";
    if (!immediate) {
      this.pendingConnectionStatus = status;
      if (!this.connectionStatusTimer) {
        this.connectionStatusTimer = globalThis.setTimeout(() => {
          this.connectionStatusTimer = undefined;
          const pending = this.pendingConnectionStatus;
          this.pendingConnectionStatus = undefined;
          if (pending) this.emitConnectionStatus(pending, { immediate: true });
        }, CONNECTION_LOSS_GRACE_MS);
      }
      return;
    }
    if (this.connectionStatusTimer) globalThis.clearTimeout(this.connectionStatusTimer);
    this.connectionStatusTimer = undefined;
    this.pendingConnectionStatus = undefined;
    if (this.connectionStatus === status) {
      // Presentation debounce must not swallow a real recovery. Wait for a
      // quiet READY window so a burst of native/TDLib transitions refreshes once.
      if (status === "online" && this.connectionSyncPending && !this.connectionSyncTimer) {
        this.connectionSyncTimer = globalThis.setTimeout(() => {
          this.connectionSyncTimer = undefined;
          this.connectionSyncPending = false;
          this.listener?.({ type: "sync.required" });
        }, CONNECTION_LOSS_GRACE_MS);
      }
      return;
    }
    if (status === "online") {
      // A visible transition already asks the Store to refresh its data.
      if (this.connectionSyncTimer) globalThis.clearTimeout(this.connectionSyncTimer);
      this.connectionSyncTimer = undefined;
      this.connectionSyncPending = false;
    }
    this.connectionStatus = status;
    if (status === "online") this.hasEstablishedConnection = true;
    this.listener?.({ type: "connection.changed", status });
  }

  private handleNativeConnectionState(update: TdObject) {
    this.nativeRecoveryPhase = String(update.phase ?? "idle");
    if (this.nativeRecoveryPhase !== "idle") {
      // A recovery command acknowledgement never upgrades cached READY to online.
      this.tdConnectionStatus = "connecting";
      this.emitConnectionStatus(this.nativeRecoveryPhase === "configurationError" ? "proxyError"
        : this.nativeRecoveryPhase === "initializing" ? "connecting" : "recovering");
      return;
    }
    this.handleConnectionUpdate({ state: { "@type": update.state } });
  }

  private requestImmediateConnectionRecovery(force = false) {
    if (!this.listener || this.settingsOnly || this.recoverySignal) return;
    if (!force && this.connectionStatus === "online") return;
    const generation = this.sessionGeneration;
    const pending = invoke<void>("telegram_recover_connection", { force });
    this.recoverySignal = pending;
    void pending.catch(() => {
      if (generation === this.sessionGeneration) {
        this.listener?.({ type: "sync.error", message: translate("无法请求连接恢复，后台将继续重试") });
      }
    }).finally(() => {
      if (this.recoverySignal === pending) this.recoverySignal = undefined;
    });
  }

  private installConnectionRecoveryListeners() {
    this.disposeConnectionMonitor?.();
    this.disposeConnectionMonitor = installConnectionRecoveryMonitor((force) => {
      this.requestImmediateConnectionRecovery(force);
    });
  }

  private startBootstrap() {
    if (this.bootstrapPromise || this.bootstrapComplete) return;
    if (this.bootstrapRetryTimer) globalThis.clearTimeout(this.bootstrapRetryTimer);
    this.bootstrapRetryTimer = undefined;
    if (this.tdConnectionStatus === "online") this.emitConnectionStatus("syncing");
    const generation = this.sessionGeneration;
    let retryable = true;
    const pending = this.bootstrap()
      .then(() => {
        if (generation !== this.sessionGeneration) return;
        this.bootstrapComplete = true;
        this.bootstrapFailed = false;
        this.bootstrapRetryAttempt = 0;
        this.finishInitialChatSync();
        if (this.tdConnectionStatus === "online") this.emitConnectionStatus("online");
      })
      .catch((error) => {
        if (generation !== this.sessionGeneration) return;
        this.bootstrapFailed = true;
        retryable = isRetryableSyncError(error);
        this.finishInitialChatSync();
        this.listener?.({
          type: "sync.error",
          message: error instanceof Error ? error.message : translate("无法同步 Telegram 数据"),
        });
      })
      .finally(() => {
        if (this.bootstrapPromise !== pending) return;
        this.bootstrapPromise = undefined;
        if (!this.bootstrapComplete && this.authorizationReady && retryable) {
          const delay = BOOTSTRAP_RETRY_DELAYS_MS[Math.min(this.bootstrapRetryAttempt++, BOOTSTRAP_RETRY_DELAYS_MS.length - 1)];
          this.bootstrapRetryTimer = globalThis.setTimeout(() => {
            this.bootstrapRetryTimer = undefined;
            if (this.authorizationReady) this.startBootstrap();
          }, delay);
        }
      });
    this.bootstrapPromise = pending;
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
      .finally(() => {
        if (this.chatListLoads.get(key) === load) this.chatListLoads.delete(key);
      });
    this.chatListLoads.set(key, load);
    return load;
  }

  private async fetchChatList(chatList: TdObject, limit: number): Promise<ChatListPage> {
    const generation = this.syncGeneration;
    const key = chatListKey(chatList);
    const refresh = this.chatListsNeedingRefresh.has(key);
    if (!this.exhaustedChatLists.has(key)) {
      try {
        await this.request({ "@type": "loadChats", chat_list: chatList, limit });
      } catch (error) {
        this.assertSyncGeneration(generation);
        if (!(error instanceof Error) || !/(all chats are loaded|404)/i.test(error.message)) {
          throw error;
        }
        this.exhaustedChatLists.add(key);
      }
    }

    this.assertSyncGeneration(generation);
    const previousCount = this.chatListCounts.get(key) ?? 0;
    const requestedCount = previousCount + limit;
    const result = await this.request({
      "@type": "getChats",
      chat_list: chatList,
      limit: requestedCount,
    });
    this.assertSyncGeneration(generation);
    const ids = Array.isArray(result.chat_ids) ? result.chat_ids.map(tdId).filter(Boolean) : [];
    const loadedIds = this.chatListIds.get(key) ?? new Set<string>();
    const newIds = ids.filter((id) => !loadedIds.has(id));
    this.chatListCounts.set(key, Math.max(previousCount, ids.length));
    this.chatListIds.set(key, loadedIds);

    // Keep TDLib and React work bounded when a list grows or is restored from a
    // large cache. Re-fetching every returned chat turns pagination into O(n^2).
    const batchSize = 8;
    for (let index = 0; index < newIds.length; index += batchSize) {
      const batchIds = newIds.slice(index, index + batchSize);
      const batch = await Promise.allSettled(batchIds.map(async (id) => {
        const raw = await this.chatForList(id, refresh, generation);
        this.assertSyncGeneration(generation);
        const current = this.cacheChat(raw);
        await this.ensureBasicGroupMetadata(current);
        this.assertSyncGeneration(generation);
        return id;
      }));
      this.assertSyncGeneration(generation);
      const fetchedChats: Chat[] = [];
      for (const [offset, result] of batch.entries()) {
        const raw = result.status === "fulfilled" ? this.rawChats.get(result.value) : undefined;
        const chat = raw ? this.mapChat(raw) : undefined;
        if (chat) {
          loadedIds.add(batchIds[offset]);
          fetchedChats.push(chat);
        }
      }
      if (fetchedChats.length > 0 && !this.initialChatSyncPending) {
        this.listener?.({ type: "chats.upserted", chats: fetchedChats });
      }
      const failure = batch.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    this.chatListsNeedingRefresh.delete(key);
    return {
      loadedCount: newIds.length,
      hasMore: !this.exhaustedChatLists.has(key),
    };
  }

  private chatForList(id: string, refresh: boolean, generation: number): Promise<TdObject> {
    const cached = this.rawChats.get(id);
    if (cached && (!refresh || this.refreshedChats.has(id))) return Promise.resolve(cached);
    const pending = this.chatRefreshes.get(id);
    if (pending) return pending;
    // A chat can belong to many retained folder panels. Their refreshes share
    // one current-generation lookup, including when a slower folder starts later.
    const request = this.request({ "@type": "getChat", chat_id: numericId(id) }).then(raw => {
      this.assertSyncGeneration(generation);
      const current = this.cacheChat(raw);
      this.refreshedChats.add(id);
      return current;
    }).finally(() => {
      if (this.chatRefreshes.get(id) === request) this.chatRefreshes.delete(id);
    });
    this.chatRefreshes.set(id, request);
    return request;
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

  private ensureBasicGroupMetadata(raw?: TdObject) {
    const type = asTdObject(raw?.type);
    const groupId = type?.["@type"] === "chatTypeBasicGroup" ? tdId(type.basic_group_id) : "";
    if (!groupId || this.rawBasicGroups.has(groupId)) return Promise.resolve();
    const pending = this.basicGroupLoads.get(groupId);
    if (pending) return pending;
    const load = this.request({
      "@type": "getBasicGroup",
      basic_group_id: numericId(groupId),
    }).then((basicGroup) => {
      this.upsertBasicGroup(basicGroup);
    }).catch(() => undefined).finally(() => {
      if (this.basicGroupLoads.get(groupId) === load) this.basicGroupLoads.delete(groupId);
    });
    this.basicGroupLoads.set(groupId, load);
    return load;
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
        customTitle: typeof member.tag === "string"
          ? sanitizeIdentityText(member.tag, "", 16) || undefined
          : undefined,
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
    raw = this.fileStates.resolve(raw);
    const id = tdId(raw.id);
    const user = mapTdUser(raw);
    if (!id || !user) return;
    this.rawUsers.set(id, raw);
    if (this.initialUserSyncPending) {
      this.initialUsers.set(id, user);
      return;
    }
    this.listener?.({
      type: "user.upsert",
      user,
      ...(cacheRelevant ? {} : { cacheRelevant: false }),
    });
  }

  private canonicalChatId(chatId: string) {
    let current = chatId;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const next = this.chatIdAliases.get(current);
      if (!next) break;
      current = next;
    }
    return current;
  }

  private canonicalizeRawMessage(raw: TdObject) {
    raw = this.fileStates.resolve(raw);
    const chatId = tdId(raw.chat_id);
    const canonicalChatId = chatId ? this.canonicalChatId(chatId) : chatId;
    return chatId && canonicalChatId && chatId !== canonicalChatId
      ? { ...raw, chat_id: numericId(canonicalChatId) }
      : raw;
  }

  private preserveNewerMessageContent(raw: TdObject) {
    const existing = this.rawMessages.get(tdId(raw.chat_id))?.get(tdId(raw.id));
    return existing && (tdNumber(existing.edit_date) ?? 0) > (tdNumber(raw.edit_date) ?? 0)
      ? { ...raw, content: existing.content, edit_date: existing.edit_date, reply_markup: existing.reply_markup }
      : raw;
  }

  private rawChatIdForBasicGroup(groupId: string) {
    for (const raw of this.rawChats.values()) {
      const type = asTdObject(raw.type);
      if (type?.["@type"] === "chatTypeBasicGroup" && tdId(type.basic_group_id) === groupId) {
        return tdId(raw.id);
      }
    }
    return chatIdFromBasicGroupId(groupId);
  }

  private rawChatIdForSupergroup(groupId: string) {
    for (const raw of this.rawChats.values()) {
      const type = asTdObject(raw.type);
      if (type?.["@type"] === "chatTypeSupergroup" && tdId(type.supergroup_id) === groupId) {
        return tdId(raw.id);
      }
    }
    return chatIdFromSupergroupId(groupId);
  }

  private migrateRawMessages(fromChatId: string, toChatId: string) {
    for (const key of this.invalidatedMessageIds) {
      if (key.startsWith(`${fromChatId}:`)) {
        this.invalidatedMessageIds.add(`${toChatId}:${key.slice(fromChatId.length + 1)}`);
      }
    }
    const previous = this.rawMessages.get(fromChatId);
    if (previous && previous.size > 0) {
      const next = this.rawMessages.get(toChatId) ?? new Map<string, TdObject>();
      for (const [messageId, raw] of previous) {
        this.unindexMessageFiles(fromChatId, messageId);
        const migrated = { ...raw, chat_id: numericId(toChatId) };
        next.set(messageId, migrated);
        this.indexMessageFiles(toChatId, messageId, migrated);
      }
      this.rawMessages.delete(fromChatId);
      this.rawMessages.set(toChatId, next);
    }
    const pendingPrefix = `${fromChatId}:`;
    for (const [key, patch] of this.pendingMessagePatches) {
      if (!key.startsWith(pendingPrefix)) continue;
      this.pendingMessagePatches.delete(key);
      this.pendingMessagePatches.set(`${toChatId}:${key.slice(pendingPrefix.length)}`, patch);
    }
  }

  private reconcileBasicGroupUpgrade(basicGroupId: string, supergroupId: string) {
    const fromChatId = this.rawChatIdForBasicGroup(basicGroupId);
    const toChatId = this.rawChatIdForSupergroup(supergroupId);
    if (!fromChatId || !toChatId || fromChatId === toChatId) return;
    const canonicalTarget = this.canonicalChatId(toChatId);
    this.chatIdAliases.set(fromChatId, canonicalTarget);
    this.migrateRawMessages(fromChatId, canonicalTarget);
    const key = `${fromChatId}->${canonicalTarget}`;
    if (this.emittedChatMigrations.has(key)) return;
    this.emittedChatMigrations.add(key);
    this.listener?.({
      type: "chat.migrated",
      fromChatId,
      toChatId: canonicalTarget,
    });
  }

  private upsertBasicGroup(raw?: TdObject) {
    if (!raw) return;
    const id = tdId(raw.id);
    if (!id) return;
    this.rawBasicGroups.set(id, raw);
    const upgradedTo = tdId(raw.upgraded_to_supergroup_id);
    if (upgradedTo && upgradedTo !== "0") {
      this.basicGroupUpgrades.set(id, upgradedTo);
      this.reconcileBasicGroupUpgrade(id, upgradedTo);
    }
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
    const upgradedFrom = tdId(raw.upgraded_from_basic_group_id);
    if (upgradedFrom && upgradedFrom !== "0") {
      this.basicGroupUpgrades.set(upgradedFrom, id);
      this.reconcileBasicGroupUpgrade(upgradedFrom, id);
    }
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

  private cacheChat(raw: TdObject): TdObject {
    const id = tdId(raw.id);
    const current = this.rawChats.get(id);
    if (this.consumedChatSnapshots.has(raw)) return current ?? raw;
    this.consumedChatSnapshots.add(raw);
    if (id) this.rawChats.set(id, raw);
    return raw;
  }

  private upsertChat(raw?: TdObject, cacheRelevant = true) {
    if (!raw) return;
    const id = tdId(raw.id);
    if (!id) return;
    raw = this.cacheChat(raw);
    const type = asTdObject(raw.type);
    if (type?.["@type"] === "chatTypeBasicGroup") void this.ensureBasicGroupMetadata(raw);
    if (type?.["@type"] === "chatTypeSupergroup") {
      const supergroupId = tdId(type.supergroup_id);
      for (const [basicGroupId, upgradedTo] of this.basicGroupUpgrades) {
        if (upgradedTo === supergroupId) this.reconcileBasicGroupUpgrade(basicGroupId, supergroupId);
      }
    }
    this.emitChat(raw, cacheRelevant);
  }

  private folderName(title: string): TdObject {
    let normalized: string;
    try {
      normalized = identityTextField(title, 12, translate("文件夹名称"), true);
    } catch {
      throw new Error(translate("文件夹名称需要包含 1 至 12 个字符，且只能使用受支持字符"));
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
    if (id === undefined) throw new Error(translate("TDLib 未返回文件夹标识"));
    const existingIndex = this.rawFolderInfos.findIndex((item) => tdNumber(item.id) === id);
    if (existingIndex >= 0) {
      this.rawFolderInfos = this.rawFolderInfos.map((item, index) =>
        index === existingIndex ? info : item
      );
    } else {
      this.rawFolderInfos = [...this.rawFolderInfos, info];
    }
    this.emitFolders();
    const folder = mapTdChatFolders([info]).find((item) => item.id === `folder:${id}`);
    if (!folder) throw new Error(translate("TDLib 未返回文件夹资料"));
    return folder;
  }

  private async refreshChat(chatId: string) {
    const generation = this.sessionGeneration;
    chatId = this.canonicalChatId(chatId);
    const raw = await this.request({
      "@type": "getChat",
      chat_id: numericId(chatId),
    });
    if (generation === this.sessionGeneration) this.upsertChat(raw);
    return raw;
  }

  private notificationScope(raw: TdObject) {
    const type = asTdObject(raw.type);
    if (type?.["@type"] === "chatTypePrivate" || type?.["@type"] === "chatTypeSecret") return "notificationSettingsScopePrivateChats";
    return type?.is_channel === true ? "notificationSettingsScopeChannelChats" : "notificationSettingsScopeGroupChats";
  }

  private mapChat(raw: TdObject) {
    raw = this.fileStates.resolve(raw);
    if (this.consumedChatSnapshots.has(raw)) raw = this.rawChats.get(tdId(raw.id)) ?? raw;
    const rawId = tdId(raw.id);
    const canonicalId = rawId ? this.canonicalChatId(rawId) : rawId;
    const mappedRaw = rawId && canonicalId && rawId !== canonicalId
      ? { ...raw, id: numericId(canonicalId) }
      : raw;
    const type = asTdObject(mappedRaw.type);
    const basicGroupId = type?.["@type"] === "chatTypeBasicGroup"
      ? tdId(type.basic_group_id)
      : undefined;
    const supergroupId = type?.["@type"] === "chatTypeSupergroup"
      ? tdId(type.supergroup_id)
      : undefined;
    return mapTdChat(
      mappedRaw,
      this.currentUserId,
      supergroupId ? this.rawSupergroups.get(supergroupId) : undefined,
      basicGroupId ? this.rawBasicGroups.get(basicGroupId) : undefined,
      this.scopeNotificationSettings.get(this.notificationScope(mappedRaw)),
    );
  }

  private emitChat(raw: TdObject, cacheRelevant = true) {
    const rawId = tdId(raw.id);
    if (rawId && this.canonicalChatId(rawId) !== rawId) return;
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
    this.initialUserSyncPending = false;
    if (this.initialUsers.size > 0) {
      this.listener?.({ type: "users.upserted", users: [...this.initialUsers.values()] });
      this.initialUsers.clear();
    }
    const chats: Chat[] = [];
    for (const raw of this.rawChats.values()) {
      const rawId = tdId(raw.id);
      if (rawId && this.canonicalChatId(rawId) !== rawId) continue;
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
    this.upsertChat({
      ...current,
      ...patch,
      // TDLib sends a complete snapshot here, including an empty snapshot when
      // the chat has no visible positions. Only updateChatPosition is a delta.
      positions: asTdObjects(positionsValue),
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
    this.fileStates.observe(file);
    file = this.fileStates.resolve(file);
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
        const nextRaw = asTdObject(replaced.value);
        if (!nextRaw) continue;
        if (this.handlingUpdateBatch) {
          const chatMessages = this.rawMessages.get(chatId);
          chatMessages?.set(messageId, nextRaw);
          const pending = this.pendingFileMessageUpdates.get(reference) ?? {
            fileUpdates: new Map<number, TdObject>(),
            cacheRelevant: false,
          };
          pending.fileUpdates.set(fileId, file);
          pending.cacheRelevant ||= cacheRelevant;
          this.pendingFileMessageUpdates.set(reference, pending);
        } else {
          this.emitMessage(nextRaw, false, cacheRelevant);
        }
      }
    }

    this.listener?.({ type: "file.updated", file: { ...fileDetails(file), fileId } });

    const pending = this.pendingDownloads.get(fileId);
    if (pending && local?.is_downloading_completed === true) {
      this.pendingDownloads.delete(fileId);
      if (typeof local.path !== "string" || !local.path) {
        pending.reject(new Error(translate("TDLib 下载完成但未提供本地文件路径")));
        return;
      }
      void invoke<string>("telegram_save_downloaded_file", {
        sourcePath: local.path,
        fileName: pending.fileName,
      }).then((path) => pending.resolve(path)).catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error(
          typeof error === "string" && error.trim() ? error : translate("无法保存下载文件"),
        ));
      });
    }
  }

  private emitMessage(raw?: TdObject, animateEntrance = false, cacheRelevant = true) {
    if (!raw) return;
    raw = this.preserveNewerMessageContent(this.canonicalizeRawMessage(raw));
    const messagePatchKey = `${tdId(raw.chat_id)}:${tdId(raw.id)}`;
    const pendingPatch = this.pendingMessagePatches.get(messagePatchKey);
    if (pendingPatch) {
      raw = { ...raw, ...pendingPatch };
      this.pendingMessagePatches.delete(messagePatchKey);
    }
    const reference = `${tdId(raw.chat_id)}:${tdId(raw.id)}`;
    const pending = this.pendingFileMessageUpdates.get(reference);
    if (pending) {
      let merged = raw;
      for (const [fileId, file] of pending.fileUpdates) {
        const replaced = replaceFileReference(merged, fileId, file);
        if (replaced.changed) merged = asTdObject(replaced.value) ?? merged;
      }
      raw = merged;
      cacheRelevant &&= pending.cacheRelevant;
      this.pendingFileMessageUpdates.delete(reference);
    }
    if (raw.is_outgoing !== true && raw.is_pending !== true) this.clearPendingBotDrafts(tdId(raw.chat_id));
    const message = this.mapMessage(raw);
    if (!message) return;
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.indexMessageFiles(message.chatId, message.id, raw);
    this.boundMessageCache();
    this.listener?.({
      type: "message.upsert",
      message,
      animateEntrance,
      ...(cacheRelevant ? {} : { cacheRelevant: false }),
    });
    this.ensureMessageSenderChat(raw);
    if (raw.is_pending !== true) {
      this.enqueueHydration(() => this.ensureReplyContent(raw));
      this.enqueueHydration(() => this.ensureFullRichMessage(raw));
    }
  }

  private emitForumTopicsChanged(chatIdValue: unknown) {
    const chatId = tdId(chatIdValue);
    if (chatId) this.listener?.({ type: "forumTopics.changed", chatId });
  }

  /**
   * `messageProperties.can_be_pinned` describes the message, but TDLib can
   * still reject `pinChatMessage` when a group member lacks the chat-level
   * pin right. Keep the menu and command guard aligned with that right.
   */
  private async chatPinPermission(chatId: string): Promise<boolean | undefined> {
    const rawChat = this.rawChats.get(chatId);
    if (!rawChat) return undefined;
    const type = asTdObject(rawChat.type);
    if (!type) return undefined;
    if (type["@type"] === "chatTypePrivate" || type["@type"] === "chatTypeSecret") return true;
    const groupId = type["@type"] === "chatTypeBasicGroup"
      ? tdId(type.basic_group_id)
      : type["@type"] === "chatTypeSupergroup"
        ? tdId(type.supergroup_id)
        : undefined;
    if (!groupId) return undefined;
    let group = type["@type"] === "chatTypeBasicGroup"
      ? this.rawBasicGroups.get(groupId)
      : this.rawSupergroups.get(groupId);
    if (!group) {
      try {
        group = type["@type"] === "chatTypeBasicGroup"
          ? await this.request({ "@type": "getBasicGroup", basic_group_id: numericId(groupId) })
          : await this.request({ "@type": "getSupergroup", supergroup_id: numericId(groupId) });
        if (type["@type"] === "chatTypeBasicGroup") this.upsertBasicGroup(group);
        else this.upsertSupergroup(group);
      } catch {
        return undefined;
      }
    }
    const status = asTdObject(group?.status);
    if (status?.["@type"] === "chatMemberStatusCreator") return true;
    if (status?.["@type"] === "chatMemberStatusAdministrator") {
      return asTdObject(status.rights)?.can_pin_messages === true;
    }
    if (status?.["@type"] === "chatMemberStatusBanned" || status?.["@type"] === "chatMemberStatusLeft") {
      return false;
    }
    if (status?.["@type"] === "chatMemberStatusRestricted") {
      const restrictedPermissions = asTdObject(status.permissions);
      if (typeof restrictedPermissions?.can_pin_messages === "boolean") {
        return restrictedPermissions.can_pin_messages === true;
      }
    }
    const chatPermissions = asTdObject(rawChat.permissions);
    return typeof chatPermissions?.can_pin_messages === "boolean"
      ? chatPermissions.can_pin_messages === true
      : status?.["@type"] === "chatMemberStatusMember" ? false : undefined;
  }

  private updateForumTopic(update: TdObject) {
    const changed = this.forumTopicService.applyForumTopicUpdate(update);
    if (changed) this.listener?.({ type: "forumTopics.changed", ...changed });
  }

  private boundMessageCache() {
    let total = [...this.rawMessages.values()].reduce((sum, messages) => sum + messages.size, 0);
    for (const [chatId, messages] of this.rawMessages) {
      const limit = chatId === this.hydrationFocusChatId ? 5000 : 500;
      for (const [id, raw] of messages) {
        if (messages.size <= limit && total <= 20_000) break;
        if (raw.sending_state || raw.is_pending === true) continue;
        messages.delete(id);
        this.unindexMessageFiles(chatId, id);
        this.clearRichMessageHydration(`${chatId}:${id}`);
        this.pendingMessagePatches.delete(`${chatId}:${id}`);
        total -= 1;
      }
      if (messages.size === 0) this.rawMessages.delete(chatId);
    }
  }

  private emitMessages(rawMessages: TdObject[], cacheRelevant = true, notify = true): Message[] {
    const messages = new Map<string, Message>();
    const uniqueRawMessages = new Map<string, TdObject>();
    for (const inputRaw of rawMessages) {
      let raw = this.preserveNewerMessageContent(this.canonicalizeRawMessage(inputRaw));
      const messagePatchKey = `${tdId(raw.chat_id)}:${tdId(raw.id)}`;
      const pendingPatch = this.pendingMessagePatches.get(messagePatchKey);
      if (pendingPatch) {
        raw = { ...raw, ...pendingPatch };
        this.pendingMessagePatches.delete(messagePatchKey);
      }
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
    if (messages.size > 0 && notify) {
      this.listener?.({
        type: "messages.upserted",
        messages: [...messages.values()],
        ...(cacheRelevant ? {} : { cacheRelevant: false }),
      });
    }
    this.boundMessageCache();
    for (const raw of uniqueRawMessages.values()) {
      this.enqueueHydration(() => this.ensureReplyContent(raw));
      this.enqueueHydration(() => this.ensureFullRichMessage(raw));
    }
    return [...messages.values()];
  }

  private enqueueHydration(task: () => Promise<unknown> | unknown) {
    this.hydrationQueue.push({ generation: this.hydrationGeneration, task });
    if (this.hydrationDrainScheduled) return;
    this.hydrationDrainScheduled = true;
    globalThis.queueMicrotask(() => {
      this.hydrationDrainScheduled = false;
      this.drainHydrationQueue();
    });
  }

  setConversationFocus(chatId?: string) {
    if (!this.settingsOnly) void invoke("telegram_set_media_focus", { chatId: chatId ? Number(chatId) : undefined }).catch(() => undefined);
    if (this.hydrationFocusChatId === chatId) return;
    this.hydrationFocusChatId = chatId;
    this.hydrationGeneration += 1;
    this.hydrationQueue = [];
    this.hydrationDrainScheduled = false;
  }

  private drainHydrationQueue() {
    while (this.activeHydrations < this.maxHydrationConcurrency && this.hydrationQueue.length > 0) {
      const entry = this.hydrationQueue.shift();
      if (!entry || entry.generation !== this.hydrationGeneration) continue;
      this.activeHydrations += 1;
      let taskResult: Promise<unknown> | unknown;
      try {
        taskResult = entry.generation === this.hydrationGeneration ? entry.task() : undefined;
      } catch {
        taskResult = undefined;
      }
      Promise.resolve(taskResult)
        .catch(() => undefined)
        .finally(() => {
          this.activeHydrations -= 1;
          this.drainHydrationQueue();
        });
    }
  }

  private flushPendingFileMessageUpdates() {
    if (this.pendingFileMessageUpdates.size === 0) return;
    const pending = this.pendingFileMessageUpdates;
    this.pendingFileMessageUpdates = new Map();
    const transientRawMessages: TdObject[] = [];
    const durableRawMessages: TdObject[] = [];
    for (const [reference, update] of pending) {
      const separator = reference.indexOf(":");
      const chatId = reference.slice(0, separator);
      const messageId = reference.slice(separator + 1);
      const raw = this.rawMessages.get(chatId)?.get(messageId);
      if (!raw) continue;
      (update.cacheRelevant ? durableRawMessages : transientRawMessages).push(raw);
    }
    if (transientRawMessages.length > 0) this.emitMessages(transientRawMessages, false);
    if (durableRawMessages.length > 0) this.emitMessages(durableRawMessages);
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

  private ensureFullRichMessage(raw: TdObject): Promise<unknown> | undefined {
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
    const generation = this.hydrationGeneration;
    let retry = false;
    return this.request({
      "@type": "getFullRichMessage",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    }).then((fullMessage) => {
      if (generation !== this.hydrationGeneration) return;
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
      if (generation !== this.hydrationGeneration) return;
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
          if (latest) this.enqueueHydration(() => this.ensureFullRichMessage(latest));
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
    if (isInDeletedHistory(tdId(raw.id), this.deletedHistory.get(tdId(raw.chat_id)))) return undefined;
    raw = this.preserveNewerMessageContent(this.canonicalizeRawMessage(raw));
    if (this.invalidatedMessageIds.has(`${tdId(raw.chat_id)}:${tdId(raw.id)}`)) return undefined;
    const rawChat = this.rawChats.get(tdId(raw.chat_id) ?? "");
    const chatType = asTdObject(rawChat?.type);
    const message = mapTdMessage(raw, {
      isChannel: chatType?.["@type"] === "chatTypeSupergroup" && chatType.is_channel === true,
    });
    if (!message || message.delivery !== "sent") return message;
    if (chatType?.["@type"] === "chatTypePrivate" && tdId(chatType.user_id) === this.currentUserId) {
      return { ...message, delivery: "read" as const };
    }
    if (!message.outgoing) return message;
    const lastReadId = tdId(
      this.rawChats.get(message.chatId)?.last_read_outbox_message_id,
    );
    if (!lastReadId || !messageIdAtMost(message.id, lastReadId)) return message;
    return { ...message, delivery: "read" as const };
  }

  private ensureReplyContent(raw: TdObject): Promise<unknown> | undefined {
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
    const generation = this.hydrationGeneration;
    return Promise.resolve()
      .then(async () => {
        if (generation !== this.hydrationGeneration) return;
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
        if (generation !== this.hydrationGeneration) return;
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
    const rawValue = asTdObject(update.message);
    if (!rawValue) return;
    let raw = this.preserveNewerMessageContent(this.canonicalizeRawMessage(rawValue));
    const pendingPatchKey = `${tdId(raw.chat_id)}:${tdId(raw.id)}`;
    const pendingPatch = this.pendingMessagePatches.get(pendingPatchKey);
    if (pendingPatch) {
      raw = { ...raw, ...pendingPatch };
      this.pendingMessagePatches.delete(pendingPatchKey);
    }
    const message = this.mapMessage(raw);
    const chatId = tdId(raw.chat_id);
    const oldId = tdId(update.old_message_id);
    if (!message) {
      if (chatId && oldId && this.invalidatedMessageIds.has(`${chatId}:${tdId(raw.id)}`)) {
        this.invalidatedMessageIds.add(`${chatId}:${oldId}`);
        this.rawMessages.get(chatId)?.delete(oldId);
        this.pendingMessagePatches.delete(`${chatId}:${oldId}`);
        this.unindexMessageFiles(chatId, oldId);
        this.listener?.({ type: "message.remove", chatId, messageId: oldId, immediate: true });
      }
      return;
    }
    if (chatId && oldId) {
      if (oldId !== message.id) this.invalidatedMessageIds.add(`${chatId}:${oldId}`);
      this.rawMessages.get(chatId)?.delete(oldId);
      this.pendingMessagePatches.delete(`${chatId}:${oldId}`);
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
    this.enqueueHydration(() => this.ensureReplyContent(raw));
    this.enqueueHydration(() => this.ensureFullRichMessage(raw));
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
    const chatId = this.canonicalChatId(tdId(update.chat_id));
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
    const chatId = this.canonicalChatId(tdId(chatIdValue));
    const messageId = tdId(messageIdValue);
    if (this.invalidatedMessageIds.has(`${chatId}:${messageId}`)) return;
    const raw = this.rawMessages.get(chatId)?.get(messageId);
    if (raw) {
      this.emitMessage({ ...raw, ...patch });
      return;
    }
    if (!chatId || !messageId) return;
    const key = `${chatId}:${messageId}`;
    this.pendingMessagePatches.set(key, {
      ...(this.pendingMessagePatches.get(key) ?? {}),
      ...patch,
    });
    if (this.pendingMessagePatches.size > 2_048) {
      this.pendingMessagePatches.delete(this.pendingMessagePatches.keys().next().value!);
    }
  }

  private updateReadOutbox(update: TdObject) {
    const chatId = this.canonicalChatId(tdId(update.chat_id));
    const lastReadId = tdId(update.last_read_outbox_message_id);
    const chat = this.rawChats.get(chatId);
    if (chat && lastReadId) {
      this.cacheChat({
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
    const chatId = this.canonicalChatId(tdId(update.chat_id));
    const ids = Array.isArray(update.message_ids) ? update.message_ids.map(tdId) : [];
    if (update.from_cache === true && update.is_permanent !== true) return;
    for (const messageId of ids) {
      const key = `${chatId}:${messageId}`;
      const source = this.localDeleteIntents.has(key) || this.localHistoryDeleteIntents.has(chatId) ? "local" : "remote";
      this.localDeleteIntents.delete(key);
      const preservedMessage = source === "remote"
        ? this.mapMessage(this.rawMessages.get(chatId)?.get(messageId) ?? {})
        : undefined;
      if (update.is_permanent === true) this.invalidatedMessageIds.add(key);
      this.clearRichMessageHydration(`${chatId}:${messageId}`);
      this.rawMessages.get(chatId)?.delete(messageId);
      this.pendingMessagePatches.delete(`${chatId}:${messageId}`);
      this.unindexMessageFiles(chatId, messageId);
      this.listener?.({
        type: "message.remove",
        chatId,
        messageId,
        permanent: update.is_permanent === true,
        fromCache: update.from_cache === true,
        source,
        ...(preservedMessage ? { preservedMessage } : {}),
      });
    }
  }

  private resetSessionState() {
    this.updateStream?.dispose();
    this.updateStream = undefined;
    this.sessionGeneration += 1;
    this.resetSyncState();
    if (this.bootstrapRetryTimer) globalThis.clearTimeout(this.bootstrapRetryTimer);
    this.bootstrapRetryTimer = undefined;
    this.bootstrapRetryAttempt = 0;
    this.bootstrapComplete = false;
    this.bootstrapFailed = false;
    this.authorizationReady = false;
    this.tdConnectionStatus = undefined;
    this.localDeleteIntents.clear();
    this.localHistoryDeleteIntents.clear();
    this.deletedHistory.clear();
    this.scopeNotificationSettings.clear();
    this.invalidatedMessageIds.clear();
    this.recoverySignal = undefined;
    this.nativeRecoveryPhase = "idle";
    this.disposeConnectionMonitor?.();
    this.disposeConnectionMonitor = undefined;
    if (this.connectionStatusTimer) globalThis.clearTimeout(this.connectionStatusTimer);
    this.connectionStatusTimer = undefined;
    this.pendingConnectionStatus = undefined;
    this.connectionStatus = undefined;
    if (this.connectionSyncTimer) globalThis.clearTimeout(this.connectionSyncTimer);
    this.connectionSyncTimer = undefined;
    this.connectionSyncPending = false;
    this.hasEstablishedConnection = false;
    this.rawChats.clear();
    this.consumedChatSnapshots = new WeakSet();
    this.rawBasicGroups.clear();
    this.rawSupergroups.clear();
    this.basicGroupUpgrades.clear();
    this.chatIdAliases.clear();
    this.emittedChatMigrations.clear();
    this.basicGroupLoads.clear();
    this.rawUsers.clear();
    this.initialUsers.clear();
    this.rawMessages.clear();
    this.pendingMessagePatches.clear();
    this.rawMessageFileIds.clear();
    this.fileMessageReferences.clear();
    this.handlingUpdateBatch = false;
    this.pendingFileMessageUpdates.clear();
    this.exhaustedHistories.clear();
    this.historyCursors.clear();
    this.historyLoads.clear();
    this.forumTopicService.reset();
    this.pendingReplyHydrations.clear();
    this.unavailableReplyHydrations.clear();
    this.pendingRichMessageHydrations.clear();
    this.pendingBotDrafts.clear();
    this.unavailableRichMessageHydrations.clear();
    this.hydrationGeneration += 1;
    this.hydrationFocusChatId = undefined;
    this.hydrationQueue = [];
    this.hydrationDrainScheduled = false;
    for (const timer of this.richMessageHydrationTimers.values()) globalThis.clearTimeout(timer);
    this.richMessageHydrationTimers.clear();
    this.richMessageHydrationFailures.clear();
    this.pendingSenderChatLoads.clear();
    this.pendingSenderUserLoads.clear();
    this.chatListLoads.clear();
    this.chatListCounts.clear();
    this.chatListsNeedingRefresh.clear();
    this.chatListIds.clear();
    this.exhaustedChatLists.clear();
    this.fileDownloads.reset();
    this.fileStates.clear();
    for (const pending of this.pendingDownloads.values()) {
      pending.reject(new Error(translate("TDLib 会话已重置，下载未完成")));
    }
    this.pendingDownloads.clear();
    this.rawFolderInfos = [];
    this.mainChatListPosition = 0;
    this.currentUserId = undefined;
    this.bootstrapPromise = undefined;
    this.initialChatSyncPending = true;
    this.initialUserSyncPending = false;
  }

}
