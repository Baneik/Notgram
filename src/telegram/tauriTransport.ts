import { invoke } from "@tauri-apps/api/core";
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
  tdChatListId,
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  AuthorizationState,
  CachedTelegramSnapshot,
  Chat,
  ChatHistoryPage,
  ChatListPage,
  DeleteMessageInput,
  EditMessageInput,
  ForwardMessagesInput,
  ForwardMessagesResult,
  Message,
  MessagePermissions,
  ProxyEndpoint,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
  SetChatDraftInput,
  SetMessageReactionInput,
  StorageSettings,
  TelegramSnapshot,
  TelegramAccount,
  TelegramAccountState,
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

type PendingRequest = {
  resolve: (value: TdObject) => void;
  reject: (reason: Error) => void;
  timer: number;
};

const numericId = (id: string) => {
  const value = Number(id);
  if (!Number.isSafeInteger(value)) throw new Error(`无效的 Telegram 标识符：${id}`);
  return value;
};

const inputMessageText = (text: string, clearDraft: boolean): TdObject => ({
  "@type": "inputMessageText",
  text: { "@type": "formattedText", text, entities: [] },
  link_preview_options: null,
  clear_draft: clearDraft,
});

const listObject = (type: "chatListMain" | "chatListArchive") => ({ "@type": type });

const folderListObject = (folderId: unknown) => ({
  "@type": "chatListFolder",
  chat_folder_id: Number(folderId),
});

const chatListObject = (chatListId: string): TdObject => {
  if (chatListId === "main") return listObject("chatListMain");
  if (chatListId === "archive") return listObject("chatListArchive");
  const folderId = /^folder:(\d+)$/.exec(chatListId)?.[1];
  if (!folderId) throw new Error(`无效的聊天列表：${chatListId}`);
  return folderListObject(folderId);
};

const chatListKey = (value: unknown) => tdChatListId(value);

const MAX_CONSECUTIVE_HISTORY_STALLS = 3;

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

const proxyTypeValue = (endpoint: ProxyEndpoint): TdObject => {
  if (endpoint.type === "socks5") {
    return {
      "@type": "proxyTypeSocks5",
      username: endpoint.username,
      password: endpoint.password,
    };
  }
  if (endpoint.type === "mtproto") {
    return { "@type": "proxyTypeMtproto", secret: endpoint.secret };
  }
  return {
    "@type": "proxyTypeHttp",
    username: endpoint.username,
    password: endpoint.password,
    http_only: endpoint.httpOnly,
  };
};

const proxyValue = (endpoint: ProxyEndpoint): TdObject => ({
  "@type": "proxy",
  server: endpoint.server.trim(),
  port: endpoint.port,
  type: proxyTypeValue(endpoint),
});

const sameProxy = (raw: TdObject, endpoint: ProxyEndpoint) => {
  if (raw.server !== endpoint.server.trim() || tdNumber(raw.port) !== endpoint.port) return false;
  const rawType = asTdObject(raw.type);
  if (endpoint.type === "mtproto") {
    return rawType?.["@type"] === "proxyTypeMtproto" && rawType.secret === endpoint.secret;
  }
  if (endpoint.type === "socks5") {
    return rawType?.["@type"] === "proxyTypeSocks5" &&
      rawType.username === endpoint.username && rawType.password === endpoint.password;
  }
  return rawType?.["@type"] === "proxyTypeHttp" &&
    rawType.username === endpoint.username && rawType.password === endpoint.password &&
    rawType.http_only === endpoint.httpOnly;
};

export class TauriTelegramTransport implements TelegramTransport {
  readonly kind = "tauri" as const;
  readonly label = "TDLib";

  private listener?: TelegramEventListener;
  private unlistenUpdate?: UnlistenFn;
  private unlistenError?: UnlistenFn;
  private pending = new Map<string, PendingRequest>();
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
  private avatarDownloads = new Set<number>();
  private mediaDownloads = new Set<number>();
  private pendingDownloads = new Map<number, string>();
  private rawFolderInfos: TdObject[] = [];
  private mainChatListPosition = 0;
  private currentUserId?: string;
  private bootstrapPromise?: Promise<void>;
  private initialChatSyncPending = true;

  async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.resetSessionState();
    this.listener = listener;
    this.initialChatSyncPending = true;
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
        this.rejectAll(error);
        this.listener?.({ type: "sync.error", message: error.message });
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
      this.unlistenUpdate?.();
      this.unlistenError?.();
      this.unlistenUpdate = undefined;
      this.unlistenError = undefined;
      this.rejectAll(new Error("TDLib runtime 已关闭。"));
      this.listener = undefined;
      this.resetSessionState();
    }
  }

  async getAccountState() {
    return invoke<TelegramAccountState>("telegram_account_state");
  }

  async registerCurrentAccount(account: Omit<TelegramAccount, "id">) {
    return invoke<TelegramAccountState>("telegram_register_account", { account });
  }

  async selectAccount(accountId: string) {
    return invoke<TelegramAccountState>("telegram_select_account", { accountId });
  }

  async removeAccount(accountId: string) {
    return invoke<TelegramAccountState>("telegram_remove_account", { accountId });
  }

  async logOut() {
    await this.request({ "@type": "logOut" });
  }

  async loadCachedSnapshot() {
    return (await invoke<CachedTelegramSnapshot | null>(
      "telegram_read_snapshot_cache",
    )) ?? undefined;
  }

  async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    await invoke("telegram_write_snapshot_cache", { snapshot });
  }

  async clearCachedSnapshot() {
    await invoke("telegram_clear_snapshot_cache");
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
    await this.applyProxy(settings);
    await invoke("telegram_save_proxy_settings", {
      preferences: { mode: settings.mode, custom: settings.custom },
    });
  }

  async testProxy(settings: ProxySettings) {
    const endpoint = this.effectiveProxy(settings);
    const response = await this.request({
      "@type": "pingProxy",
      proxy: endpoint ? proxyValue(endpoint) : null,
    });
    const seconds = tdNumber(response.seconds);
    if (seconds === undefined) throw new Error("TDLib 未返回代理延迟");
    return Math.max(0, Math.round(seconds * 1000));
  }

  async getStorageSettings() {
    return invoke<StorageSettings>("telegram_storage_settings");
  }

  async saveStorageSettings(settings: StorageSettings) {
    return invoke<StorageSettings>("telegram_save_storage_settings", {
      preferences: {
        cachePath: settings.cachePath,
        downloadPath: settings.downloadPath,
      },
    });
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

  async searchChatMessages(chatId: string, query: string, limit = 100) {
    const normalized = query.trim();
    if (!normalized) return 0;
    const result = await this.request({
      "@type": "searchChatMessages",
      chat_id: numericId(chatId),
      topic_id: null,
      query: normalized,
      sender_id: null,
      from_message_id: 0,
      offset: 0,
      limit: Math.max(1, Math.min(limit, 100)),
      filter: null,
    });
    const messages = asTdObjects(result.messages);
    for (const message of messages) this.emitMessage(message);
    return messages.length;
  }

  async loadMoreChats(chatListId: string, limit = 100) {
    return this.loadChatList(
      chatListObject(chatListId),
      Math.max(1, Math.min(limit, 100)),
    );
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

  async sendMessage(input: SendMessageInput) {
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
      input_message_content: inputMessageText(input.text, true),
    });
    if (response["@type"] === "message") this.emitMessage(response);
  }

  async editMessage(input: EditMessageInput) {
    const response = await this.request({
      "@type": "editMessageText",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      reply_markup: null,
      input_message_content: inputMessageText(input.text, false),
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
      this.pendingDownloads.delete(fileId);
      throw error;
    }
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
    const response = await this.requestPreparedFile(input.chatId);
    if (!response) return false;
    if (response["@type"] === "message") this.emitMessage(response);
    return true;
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
    let loadedCount = 0;
    const messageIds: string[] = [];
    const returnedIds = new Set<string>();
    let cursor = this.historyCursors.get(chatId) ?? 0;
    let requestCount = 0;
    let consecutiveStalls = 0;
    const maxRequestCount = targetCount + MAX_CONSECUTIVE_HISTORY_STALLS + 2;

    while (loadedCount < targetCount && requestCount < maxRequestCount) {
      requestCount += 1;
      const response = await this.request({
        "@type": "getChatHistory",
        chat_id: numericId(chatId),
        from_message_id: cursor,
        offset: 0,
        limit: Math.min(100, targetCount - loadedCount + (cursor ? 1 : 0)),
        only_local: false,
      });
      const rawPage = asTdObjects(response.messages);
      if (rawPage.length === 0) {
        this.exhaustedHistories.add(chatId);
        break;
      }

      const known = this.rawMessages.get(chatId) ?? new Map<string, TdObject>();
      let addedThisRequest = 0;
      for (const raw of rawPage) {
        const id = tdId(raw.id);
        if (id && !returnedIds.has(id)) {
          returnedIds.add(id);
          messageIds.push(id);
        }
        if (id && !known.has(id)) addedThisRequest += 1;
        this.emitMessage(raw);
      }
      loadedCount += addedThisRequest;

      const nextCursor = tdNumber(rawPage.at(-1)?.id);
      if (!nextCursor) {
        this.exhaustedHistories.add(chatId);
        break;
      }
      if (nextCursor === cursor) {
        consecutiveStalls += 1;
        if (consecutiveStalls >= MAX_CONSECUTIVE_HISTORY_STALLS) break;
        continue;
      }
      this.historyCursors.set(chatId, nextCursor);
      cursor = nextCursor;
      consecutiveStalls = 0;
    }

    return {
      loadedCount,
      hasMore: !this.exhaustedHistories.has(chatId),
      messageIds,
    };
  }

  private async request(request: TdObject) {
    const extra = crypto.randomUUID();
    const payload = { ...request, "@extra": extra };
    const response = new Promise<TdObject>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(extra);
        reject(new Error("TDLib 请求超时。"));
      }, 30_000);
      this.pending.set(extra, { resolve, reject, timer });
    });
    try {
      await invoke("telegram_send", { request: payload });
    } catch (error) {
      const pending = this.pending.get(extra);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(extra);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  private async requestPreparedFile(chatId: string) {
    const extra = crypto.randomUUID();
    const response = new Promise<TdObject>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(extra);
        reject(new Error("TDLib 文件发送请求超时。"));
      }, 30_000);
      this.pending.set(extra, { resolve, reject, timer });
    });
    try {
      const selected = await invoke<boolean>("telegram_pick_and_send_file", {
        chatId: numericId(chatId),
        extra,
      });
      if (!selected) {
        const pending = this.pending.get(extra);
        if (pending) window.clearTimeout(pending.timer);
        this.pending.delete(extra);
        return undefined;
      }
    } catch (error) {
      const pending = this.pending.get(extra);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(extra);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  private effectiveProxy(settings: ProxySettings) {
    if (settings.mode === "direct") return undefined;
    return settings.mode === "system" ? settings.system : settings.custom;
  }

  private async applyProxy(settings: ProxySettings) {
    const endpoint = this.effectiveProxy(settings);
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
    const extra = typeof update["@extra"] === "string" ? update["@extra"] : undefined;
    if (extra) {
      const pending = this.pending.get(extra);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(extra);
        if (update["@type"] === "error") {
          const code = tdNumber(update.code);
          const suffix = code === undefined ? "" : ` (${code})`;
          pending.reject(new Error(`${String(update.message ?? "TDLib 请求失败")}${suffix}`));
        } else {
          pending.resolve(update);
        }
        return;
      }
    }

    switch (update["@type"]) {
      case "updateAuthorizationState":
        this.handleAuthorizationUpdate(update);
        return;
      case "updateUser":
        this.upsertUser(asTdObject(update.user));
        return;
      case "updateUserStatus":
        this.updateUserStatus(update);
        return;
      case "updateChatFolders":
        this.updateChatFolders(update);
        return;
      case "updateNewChat":
        this.upsertChat(asTdObject(update.chat));
        this.emitDraft(update.chat_id ?? asTdObject(update.chat)?.id, asTdObject(update.chat)?.draft_message);
        return;
      case "updateChatTitle":
        this.patchChat(update.chat_id, { title: update.title });
        return;
      case "updateChatPhoto":
        this.patchChat(update.chat_id, { photo: update.photo });
        return;
      case "updateChatLastMessage":
        this.patchChat(update.chat_id, {
          last_message: update.last_message,
          positions: update.positions,
        });
        return;
      case "updateChatDraftMessage":
        this.patchChat(update.chat_id, {
          draft_message: update.draft_message,
          positions: update.positions,
        });
        this.emitDraft(update.chat_id, update.draft_message);
        return;
      case "updateChatPosition":
        this.updateChatPosition(update);
        return;
      case "updateChatAddedToList":
        this.updateChatList(update, true);
        return;
      case "updateChatRemovedFromList":
        this.updateChatList(update, false);
        return;
      case "updateChatReadInbox":
        this.patchChat(update.chat_id, { unread_count: update.unread_count });
        return;
      case "updateChatNotificationSettings":
        this.patchChat(update.chat_id, {
          notification_settings: update.notification_settings,
        });
        return;
      case "updateNewMessage":
        this.emitMessage(asTdObject(update.message));
        return;
      case "updateMessageSendSucceeded":
      case "updateMessageSendFailed":
        this.replaceSentMessage(update);
        return;
      case "updateMessageContent":
        this.updateMessageContent(update);
        return;
      case "updateMessageEdited":
        this.patchMessage(update.chat_id, update.message_id, {
          edit_date: update.edit_date,
          reply_markup: update.reply_markup,
        });
        return;
      case "updateMessageInteractionInfo":
        this.patchMessage(update.chat_id, update.message_id, {
          interaction_info: update.interaction_info,
        });
        return;
      case "updateChatReadOutbox":
        this.updateReadOutbox(update);
        return;
      case "updateDeleteMessages":
        this.deleteMessages(update);
        return;
      case "updateFile":
        this.updateFile(asTdObject(update.file));
    }
  }

  private handleAuthorizationUpdate(update: TdObject) {
    const state = asTdObject(update.authorization_state);
    if (!state) return;
    const mapped = mapAuthorizationState(state);
    this.listener?.({ type: "authorization.changed", state: mapped });
    if (mapped.kind === "ready") this.startBootstrap();
  }

  private startBootstrap() {
    if (this.bootstrapPromise) return;
    this.bootstrapPromise = this.bootstrap()
      .then(() => this.finishInitialChatSync())
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
    await Promise.all([
      this.loadChatList(listObject("chatListMain"), 100),
      ...this.rawFolderInfos.map((folder) =>
        this.loadChatList(folderListObject(folder.id), 100),
      ),
    ]);
    while (this.chatListLoads.size > 0) {
      await Promise.all([...this.chatListLoads.values()]);
    }
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
      ids
        .filter((id) => !this.rawChats.has(id))
        .map(async (id) => this.upsertChat(await this.request({ "@type": "getChat", chat_id: numericId(id) }))),
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
    if (this.bootstrapPromise) {
      void Promise.all(
        this.rawFolderInfos
          .filter((folder) => !this.chatListCounts.has(chatListKey(folderListObject(folder.id))))
          .map((folder) => this.loadChatList(folderListObject(folder.id), 100)),
      ).catch((error) => {
        this.listener?.({
          type: "sync.error",
          message: error instanceof Error ? error.message : "无法同步聊天文件夹",
        });
      });
    }
  }

  private emitFolders() {
    this.listener?.({
      type: "folders.replaced",
      folders: mapTdChatFolders(this.rawFolderInfos, this.mainChatListPosition),
    });
  }

  private upsertUser(raw?: TdObject) {
    if (!raw) return;
    const id = tdId(raw.id);
    const user = mapTdUser(raw);
    if (!id || !user) return;
    this.rawUsers.set(id, raw);
    this.listener?.({ type: "user.upsert", user });
    this.ensureUserPhoto(raw);
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
    this.ensureChatPhoto(raw);
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

  private ensureChatPhoto(raw: TdObject) {
    const small = asTdObject(asTdObject(raw.photo)?.small);
    const local = asTdObject(small?.local);
    const fileId = tdNumber(small?.id);
    if (
      fileId === undefined ||
      local?.is_downloading_completed === true ||
      local?.can_be_downloaded !== true ||
      local.is_downloading_active === true ||
      this.avatarDownloads.has(fileId)
    ) {
      return;
    }

    this.avatarDownloads.add(fileId);
    void this.request({
      "@type": "downloadFile",
      file_id: fileId,
      priority: 16,
      offset: 0,
      limit: 0,
      synchronous: false,
    })
      .then((file) => this.updateFile(file))
      .catch(() => this.avatarDownloads.delete(fileId));
  }

  private ensureUserPhoto(raw: TdObject) {
    const small = asTdObject(asTdObject(raw.profile_photo)?.small);
    const local = asTdObject(small?.local);
    const fileId = tdNumber(small?.id);
    if (
      fileId === undefined ||
      local?.is_downloading_completed === true ||
      local?.can_be_downloaded !== true ||
      local.is_downloading_active === true ||
      this.avatarDownloads.has(fileId)
    ) {
      return;
    }

    this.avatarDownloads.add(fileId);
    void this.request({
      "@type": "downloadFile",
      file_id: fileId,
      priority: 16,
      offset: 0,
      limit: 0,
      synchronous: false,
    })
      .then((file) => this.updateFile(file))
      .catch(() => this.avatarDownloads.delete(fileId));
  }

  private updateFile(file?: TdObject) {
    const fileId = tdNumber(file?.id);
    if (!file || fileId === undefined) return;
    const local = asTdObject(file.local);
    if (local?.is_downloading_active !== true) this.avatarDownloads.delete(fileId);
    if (local?.is_downloading_completed === true) this.mediaDownloads.delete(fileId);

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
    const message = mapTdMessage(raw);
    if (!message) return;
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.listener?.({ type: "message.upsert", message });
    this.ensureDisplayMedia(message);
    this.ensureReplyContent(raw);
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

  private ensureDisplayMedia(message: Message) {
    const content = message.content;
    if (
      content.kind !== "media" ||
      !["photo", "sticker"].includes(content.mediaType) ||
      content.fileId === undefined ||
      content.isDownloaded ||
      content.isDownloading ||
      content.canDownload !== true ||
      this.mediaDownloads.has(content.fileId)
    ) {
      return;
    }

    const fileId = content.fileId;
    this.mediaDownloads.add(fileId);
    void this.request({
      "@type": "downloadFile",
      file_id: fileId,
      priority: 18,
      offset: 0,
      limit: 0,
      synchronous: false,
    })
      .then((file) => this.updateFile(file))
      .catch(() => this.mediaDownloads.delete(fileId));
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
    const lastReadId = tdNumber(update.last_read_outbox_message_id) ?? 0;
    for (const raw of this.rawMessages.get(chatId)?.values() ?? []) {
      const message = mapTdMessage(raw);
      if (message?.outgoing && (tdNumber(raw.id) ?? 0) <= lastReadId) {
        const readMessage: Message = { ...message, delivery: "read" };
        this.listener?.({ type: "message.upsert", message: readMessage });
      }
    }
  }

  private deleteMessages(update: TdObject) {
    const chatId = tdId(update.chat_id);
    const ids = Array.isArray(update.message_ids) ? update.message_ids.map(tdId) : [];
    for (const messageId of ids) {
      this.rawMessages.get(chatId)?.delete(messageId);
      this.listener?.({ type: "message.remove", chatId, messageId });
    }
  }

  private resetSessionState() {
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
    this.avatarDownloads.clear();
    this.mediaDownloads.clear();
    this.pendingDownloads.clear();
    this.rawFolderInfos = [];
    this.mainChatListPosition = 0;
    this.currentUserId = undefined;
    this.bootstrapPromise = undefined;
    this.initialChatSyncPending = true;
  }

  private rejectAll(error: Error) {
    for (const [extra, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(extra);
    }
  }
}

const mapAuthorizationState = (state: TdObject): AuthorizationState => {
  switch (state["@type"]) {
    case "authorizationStateWaitTdlibParameters":
      return { kind: "preparing" };
    case "authorizationStateWaitPhoneNumber":
      return { kind: "waitPhoneNumber" };
    case "authorizationStateWaitCode": {
      const codeInfo = asTdObject(state.code_info);
      const codeType = asTdObject(codeInfo?.type);
      return {
        kind: "waitCode",
        phoneNumber:
          typeof codeInfo?.phone_number === "string" ? codeInfo.phone_number : undefined,
        codeLength: tdNumber(codeType?.length),
      };
    }
    case "authorizationStateWaitPassword":
      return {
        kind: "waitPassword",
        hint: typeof state.password_hint === "string" ? state.password_hint : undefined,
      };
    case "authorizationStateWaitEmailAddress":
      return { kind: "waitEmailAddress" };
    case "authorizationStateWaitEmailCode": {
      const codeInfo = asTdObject(state.code_info);
      return {
        kind: "waitEmailCode",
        emailPattern:
          typeof codeInfo?.email_address_pattern === "string"
            ? codeInfo.email_address_pattern
            : undefined,
        codeLength: tdNumber(codeInfo?.length),
      };
    }
    case "authorizationStateWaitRegistration":
      return { kind: "waitRegistration" };
    case "authorizationStateWaitOtherDeviceConfirmation":
      return { kind: "waitOtherDeviceConfirmation", link: String(state.link ?? "") };
    case "authorizationStateReady":
      return { kind: "ready" };
    case "authorizationStateLoggingOut":
      return { kind: "loggingOut" };
    case "authorizationStateClosing":
      return { kind: "closing" };
    case "authorizationStateClosed":
      return { kind: "closed" };
    default:
      return { kind: "preparing" };
  }
};
