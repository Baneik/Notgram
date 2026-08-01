import type {
  SendFileInput,
  SendMessageInput,
  TelegramEvent,
  TelegramSnapshot,
  ProxySettings,
} from "./types";
import type { AuthorizationAction } from "./types";

export type TelegramEventListener = (event: TelegramEvent) => void;

export interface TelegramTransport {
  readonly kind: "mock" | "tauri";
  readonly label: string;
  connect(listener: TelegramEventListener): Promise<TelegramSnapshot>;
  disconnect(): Promise<void>;
  authenticate(action: AuthorizationAction): Promise<void>;
  getProxySettings(): Promise<ProxySettings>;
  saveProxySettings(settings: ProxySettings): Promise<void>;
  testProxy(settings: ProxySettings): Promise<number>;
  loadChatHistory(chatId: string): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<void>;
  sendFile(input: SendFileInput): Promise<void>;
  markChatRead(chatId: string): Promise<void>;
}
