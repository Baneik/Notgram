import { invoke, isTauri } from "@tauri-apps/api/core";

export interface TelegramProtocolSettings { supported: boolean; registered: boolean; isDefault: boolean; }
export const telegramProtocol = {
  settings: (): Promise<TelegramProtocolSettings> => isTauri()
    ? invoke("notgram_telegram_protocol_settings")
    : Promise.resolve({ supported: false, registered: false, isDefault: false }),
  register: (): Promise<TelegramProtocolSettings> => invoke("notgram_register_telegram_protocol"),
  openDefaultApps: (): Promise<void> => invoke("notgram_open_default_apps"),
};
