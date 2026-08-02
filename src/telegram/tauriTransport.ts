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
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import { FileDownloadQueue } from "./fileDownloadQueue";
import { loadHistoryWindow } from "./historyPager";
import { TdRequestBroker } from "./tdRequestBroker";
import { TauriAccountStorage } from "./tauriAccountStorage";
import {
  chatListKey,
  chatListObject,
  effectiveProxy,
  inputMessageText,
  listObject,
  mapAuthorizationState,
  numericId,
  proxyValue,
  sameProxy,
} from "./tdlibRequests";
import { routeTdUpdate, type TdUpdateHandlers } from "./tdUpdateRouter";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
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
        this.requestBroker.rejectAll(error);
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
    await this.applyProxy(settings);
    await invoke("telegram_save_proxy_settings", {
      preferences: { mode: settings.mode, custom: settings.custom },
    });
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
      this.pendingDownloads.delete(fileId);
      throw error;
    }
  }

  cacheFile(fileId: number, priority = 16) {
    return this.fileDownloads.cache(fileId, priority);
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
    const result = await loadHistoryWindow({
      chatId,
      targetCount,
      cursor: this.historyCursors.get(chatId) ?? 0,
      knownMessages: this.rawMessages.get(chatId) ?? new Map<string, TdObject>(),
      request: (request) => this.request(request),
      emitMessage: (message) => this.emitMessage(message),
      onCursor: (cursor) => this.historyCursors.set(chatId, cursor),
    });
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
    return this.requestBroker.requestPreparedFile(chatId);
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
    await this.loadChatList(listObject("chatListMain"), 40);
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
    this.upsertChat({
      ...current,
      ...patch,
      // TDLib can transiently send an empty positions array while a chat update
      // is followed by updateChatPosition. Keep the last stable list state until
      // that authoritative per-list update arrives.
      positions: positions.length > 0 ? positions : current.positions,
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
    const message = mapTdMessage(raw);
    if (!message) return;
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.listener?.({ type: "message.upsert", message });
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
    this.fileDownloads.reset();
    this.pendingDownloads.clear();
    this.rawFolderInfos = [];
    this.mainChatListPosition = 0;
    this.currentUserId = undefined;
    this.bootstrapPromise = undefined;
    this.initialChatSyncPending = true;
  }

}
