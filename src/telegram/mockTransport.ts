import { mockSnapshot } from "./mockData";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type {
  AuthorizationAction,
  Chat,
  Message,
  ProxySettings,
  SendFileInput,
  SendMessageInput,
  TelegramSnapshot,
} from "./types";

const clone = <T,>(value: T): T => structuredClone(value);

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
  private authFlow: boolean;
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

  constructor(options: { authFlow?: boolean } = {}) {
    this.authFlow = Boolean(options.authFlow);
    if (this.authFlow) {
      this.snapshot.authorization = { kind: "waitPhoneNumber" };
    }
  }

  async connect(listener: TelegramEventListener): Promise<TelegramSnapshot> {
    this.listener = listener;
    return clone(this.snapshot);
  }

  async disconnect() {
    this.listener = undefined;
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

  async loadChatHistory(_chatId: string) {
    return Promise.resolve();
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

  async sendMessage({ chatId, text }: SendMessageInput) {
    this.appendMessage({
      id: crypto.randomUUID(),
      chatId,
      senderId: this.snapshot.currentUserId,
      outgoing: true,
      sentAt: new Date().toISOString(),
      delivery: "sent",
      content: { kind: "text", text },
    });
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
}
