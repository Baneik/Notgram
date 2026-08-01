import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asTdObject,
  asTdObjects,
  mapTdChat,
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
  DeleteMessageInput,
  EditMessageInput,
  Message,
  MessagePermissions,
  ProxyEndpoint,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
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

const chatListKey = (value: unknown) => tdChatListId(value);

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
  private historyStalls = new Map<string, number>();
  private historyLoads = new Map<string, Promise<ChatHistoryPage>>();
  private chatListLoads = new Map<string, Promise<void>>();
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

  async sendFile(_input: SendFileInput) {
    throw new Error("真实文件上传将在 TDLib 文件映射完成后启用。");
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
    const maxRequestCount = targetCount + 2;

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
        this.historyStalls.delete(chatId);
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
        this.historyStalls.delete(chatId);
        break;
      }
      if (nextCursor === cursor) {
        const stalls = (this.historyStalls.get(chatId) ?? 0) + 1;
        this.historyStalls.set(chatId, stalls);
        if (stalls >= 2) this.exhaustedHistories.add(chatId);
        break;
      }
      this.historyCursors.set(chatId, nextCursor);
      this.historyStalls.delete(chatId);
      cursor = nextCursor;
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

  private async loadChatList(chatList: TdObject, limit: number) {
    const key = chatListKey(chatList);
    const existing = this.chatListLoads.get(key);
    if (existing) return existing;
    const load = this.fetchChatList(chatList, limit)
      .finally(() => this.chatListLoads.delete(key));
    this.chatListLoads.set(key, load);
    return load;
  }

  private async fetchChatList(chatList: TdObject, limit: number) {
    try {
      await this.request({ "@type": "loadChats", chat_list: chatList, limit });
    } catch (error) {
      if (!(error instanceof Error) || !/(all chats are loaded|404)/i.test(error.message)) {
        throw error;
      }
    }

    const result = await this.request({ "@type": "getChats", chat_list: chatList, limit });
    const ids = Array.isArray(result.chat_ids) ? result.chat_ids.map(tdId).filter(Boolean) : [];
    await Promise.all(
      ids
        .filter((id) => !this.rawChats.has(id))
        .map(async (id) => this.upsertChat(await this.request({ "@type": "getChat", chat_id: numericId(id) }))),
    );
  }

  private updateChatFolders(update: TdObject) {
    this.rawFolderInfos = asTdObjects(update.chat_folders);
    this.mainChatListPosition = tdNumber(update.main_chat_list_position) ?? 0;
    this.emitFolders();
    if (this.bootstrapPromise) {
      void Promise.all(
        this.rawFolderInfos.map((folder) =>
          this.loadChatList(folderListObject(folder.id), 100),
        ),
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
    this.ensurePhotoMedia(message);
  }

  private ensurePhotoMedia(message: Message) {
    const content = message.content;
    if (
      content.kind !== "media" ||
      content.mediaType !== "photo" ||
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
    this.historyStalls.clear();
    this.historyLoads.clear();
    this.chatListLoads.clear();
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
