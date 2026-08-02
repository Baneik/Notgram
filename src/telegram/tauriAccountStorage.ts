import { invoke } from "@tauri-apps/api/core";
import type {
  CachedTelegramSnapshot,
  StorageSettings,
  TelegramAccount,
  TelegramAccountState,
} from "./types";

export class TauriAccountStorage {
  getAccountState() {
    return invoke<TelegramAccountState>("telegram_account_state");
  }

  registerCurrentAccount(account: Omit<TelegramAccount, "id">) {
    return invoke<TelegramAccountState>("telegram_register_account", { account });
  }

  selectAccount(accountId: string) {
    return invoke<TelegramAccountState>("telegram_select_account", { accountId });
  }

  removeAccount(accountId: string) {
    return invoke<TelegramAccountState>("telegram_remove_account", { accountId });
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

  getStorageSettings() {
    return invoke<StorageSettings>("telegram_storage_settings");
  }

  saveStorageSettings(settings: StorageSettings) {
    return invoke<StorageSettings>("telegram_save_storage_settings", {
      preferences: {
        cachePath: settings.cachePath,
        downloadPath: settings.downloadPath,
      },
    });
  }
}
