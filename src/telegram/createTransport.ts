import { MockTelegramTransport } from "./mockTransport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TelegramTransport } from "./transport";

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
  });
};
