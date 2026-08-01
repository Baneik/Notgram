import { mockSnapshot } from "./mockData";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  CachedTelegramSnapshot,
  Chat,
  DeleteMessageInput,
  EditMessageInput,
  Message,
  MessagePermissions,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
  StorageSettings,
  TelegramSnapshot,
  ChatHistoryPage,
} from "./types";

const clone = <T,>(value: T): T => structuredClone(value);
const CACHE_KEY = "notgram:ui-cache:v1";

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

export class MockTelegramTransport implements TelegramTransport {
  readonly kind = "mock" as const;
  readonly label = "演示数据";

  private listener?: TelegramEventListener;
  private snapshot = clone(mockSnapshot);
  private cachedSnapshot?: CachedTelegramSnapshot;
  private historyOffsets = new Map<string, number>();
  private authFlow: boolean;
  private storageSettings: StorageSettings = {
    cachePath: "Windows 应用缓存\\Notgram\\tdlib",
    downloadPath: "Notgram\\downloads",
    defaultCachePath: "Windows 应用缓存\\Notgram\\tdlib",
    defaultDownloadPath: "Notgram\\downloads",
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

  constructor(options: { authFlow?: boolean; cachedSnapshot?: CachedTelegramSnapshot } = {}) {
    this.authFlow = Boolean(options.authFlow);
    this.cachedSnapshot = options.cachedSnapshot
      ? clone(options.cachedSnapshot)
      : undefined;
    if (this.authFlow) {
      this.snapshot.authorization = { kind: "waitPhoneNumber" };
    }
  }

  async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.listener = listener;
    return clone({ ...this.snapshot, messages: [] });
  }

  async disconnect() {
    this.listener = undefined;
  }

  async loadCachedSnapshot() {
    if (this.cachedSnapshot) return clone(this.cachedSnapshot);
    const serialized = browserStorage()?.getItem(CACHE_KEY);
    if (!serialized) return undefined;
    try {
      const snapshot = JSON.parse(serialized) as CachedTelegramSnapshot;
      return snapshot.version === 1 ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    this.cachedSnapshot = clone(snapshot);
    browserStorage()?.setItem(CACHE_KEY, JSON.stringify(snapshot));
  }

  async clearCachedSnapshot() {
    this.cachedSnapshot = undefined;
    browserStorage()?.removeItem(CACHE_KEY);
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
  }

  async loadChatHistory(chatId: string, limit = 30): Promise<ChatHistoryPage> {
    const history = this.snapshot.messages
      .filter((message) => message.chatId === chatId)
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
    const offset = this.historyOffsets.get(chatId) ?? 0;
    const page = history.slice(offset, offset + limit);
    this.historyOffsets.set(chatId, offset + page.length);
    for (const message of page) {
      this.listener?.({ type: "message.upsert", message: clone(message) });
    }
    return {
      loadedCount: page.length,
      hasMore: offset + page.length < history.length,
      messageIds: page.map((message) => message.id),
    };
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

  async sendMessage({ chatId, text, replyToMessageId }: SendMessageInput) {
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

  async downloadFile(_fileId: number, _fileName: string) {
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
    this.appendMessage({
      id: crypto.randomUUID(),
      chatId,
      senderId: this.snapshot.currentUserId,
      outgoing: true,
      sentAt: new Date().toISOString(),
      delivery: "sent",
      content: {
        kind: "file",
        fileName: file.name,
        sizeLabel: readableFileSize(file.size),
      },
    });
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
      preview:
        message.content.kind === "text"
          ? message.content.text
          : message.content.fileName,
      updatedAt: message.sentAt,
      unreadCount: 0,
    };
    Object.assign(chat, updatedChat);
    this.listener?.({ type: "chat.upsert", chat: clone(updatedChat) });
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
      preview: latest.content.kind === "text"
        ? latest.content.text
        : latest.content.caption || latest.content.fileName,
      updatedAt: latest.sentAt,
    };
    Object.assign(chat, updatedChat);
    this.listener?.({ type: "chat.upsert", chat: clone(updatedChat) });
  }
}
