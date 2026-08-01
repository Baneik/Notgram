import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asTdObject,
  asTdObjects,
  mapTdChat,
  mapTdMessage,
  mapTdUser,
  tdId,
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  AuthorizationState,
  Message,
  ProxyEndpoint,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
  TelegramSnapshot,
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

const listObject = (type: "chatListMain" | "chatListArchive") => ({ "@type": type });

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
  private loadedHistories = new Set<string>();
  private currentUserId?: string;
  private bootstrapPromise?: Promise<void>;

  async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.listener = listener;
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
      this.bootstrapPromise = undefined;
      this.loadedHistories.clear();
      this.rejectAll(new Error("TDLib runtime 已关闭。"));
    }
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

  async loadChatHistory(chatId: string) {
    if (this.loadedHistories.has(chatId)) return;
    this.loadedHistories.add(chatId);
    try {
      const response = await this.request({
        "@type": "getChatHistory",
        chat_id: numericId(chatId),
        from_message_id: 0,
        offset: 0,
        limit: 50,
        only_local: false,
      });
      for (const message of asTdObjects(response.messages)) this.emitMessage(message);
    } catch (error) {
      this.loadedHistories.delete(chatId);
      throw error;
    }
  }

  async sendMessage(input: SendMessageInput) {
    const response = await this.request({
      "@type": "sendMessage",
      chat_id: numericId(input.chatId),
      topic_id: null,
      reply_to: null,
      options: null,
      reply_markup: null,
      input_message_content: {
        "@type": "inputMessageText",
        text: { "@type": "formattedText", text: input.text, entities: [] },
        link_preview_options: null,
        clear_draft: true,
      },
    });
    if (response["@type"] === "message") this.emitMessage(response);
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
      case "updateChatReadOutbox":
        this.updateReadOutbox(update);
        return;
      case "updateDeleteMessages":
        this.deleteMessages(update);
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
    this.bootstrapPromise = this.bootstrap().catch((error) => {
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
      for (const chat of this.rawChats.values()) this.emitChat(chat);
    }

    await Promise.all([
      this.loadChatList("chatListMain", 100),
      this.loadChatList("chatListArchive", 50),
    ]);
  }

  private async loadChatList(type: "chatListMain" | "chatListArchive", limit: number) {
    const chatList = listObject(type);
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
    if (chat) this.listener?.({ type: "chat.upsert", chat });
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
    const incomingType = asTdObject(position.list)?.["@type"];
    const positions = asTdObjects(current.positions).filter(
      (item) => asTdObject(item.list)?.["@type"] !== incomingType,
    );
    if ((tdNumber(position.order) ?? 0) !== 0) positions.push(position);
    this.upsertChat({ ...current, positions });
  }

  private updateChatList(update: TdObject, added: boolean) {
    const id = tdId(update.chat_id);
    const current = this.rawChats.get(id);
    const list = asTdObject(update.chat_list);
    if (!current || !list) return;
    const listType = list["@type"];
    const lists = asTdObjects(current.chat_lists).filter((item) => item["@type"] !== listType);
    if (added) lists.push(list);
    this.upsertChat({ ...current, chat_lists: lists });
  }

  private emitMessage(raw?: TdObject) {
    if (!raw) return;
    const message = mapTdMessage(raw);
    if (!message) return;
    const chatMessages = this.rawMessages.get(message.chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.rawMessages.set(message.chatId, chatMessages);
    this.listener?.({ type: "message.upsert", message });
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
    const chatId = tdId(update.chat_id);
    const messageId = tdId(update.message_id);
    const raw = this.rawMessages.get(chatId)?.get(messageId);
    if (raw) this.emitMessage({ ...raw, content: update.new_content });
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
