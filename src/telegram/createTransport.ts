import { MockTelegramTransport } from "./mockTransport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TelegramTransport } from "./transport";
import type { ConnectionStatus } from "./types";

const mockConnectionStatus = () => {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("connection");
  return ([
    "connecting",
    "syncing",
    "online",
    "waitingForNetwork",
    "proxyError",
    "offline",
  ] satisfies ConnectionStatus[]).find((status) => status === value);
};

const mockInitialTyping = () => {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("typing");
  if (value === "group") return { chatId: "chat-product", senderId: "u-jules" };
  if (value === "direct") return { chatId: "chat-mia", senderId: "u-mia" };
  return undefined;
};

export const createTelegramTransport = (): TelegramTransport => {
  if (import.meta.env.VITE_TELEGRAM_TRANSPORT === "tauri") {
    return new TauriTelegramTransport();
  }
  return new MockTelegramTransport({
    authFlow:
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("auth")
        ? true
        : undefined,
    connectionStatus: mockConnectionStatus(),
    initialTyping: mockInitialTyping(),
  });
};
