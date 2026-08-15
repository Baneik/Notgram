import { invoke } from "@tauri-apps/api/core";
import type {
  CachedTelegramSnapshot,
  CacheCleanupInput,
  CacheCleanupResult,
  CacheUsage,
  StorageSettings,
  TelegramAccount,
  TelegramAccountState,
} from "./types";

const SNAPSHOT_CACHE_CHUNK_SIZE = 64;

const yieldToMainThread = () => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, 0);
});

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
    const transactionId = globalThis.crypto.randomUUID();
    const header: Record<string, unknown> = {};
    const sections: Array<{ name: string; values: unknown[] }> = [];
    for (const [name, value] of Object.entries(snapshot)) {
      if (Array.isArray(value)) {
        header[name] = [];
        sections.push({ name, values: value });
      } else {
        header[name] = value;
      }
    }

    try {
      await invoke("telegram_begin_snapshot_cache_write", { transactionId, header });
      for (const section of sections) {
        for (let index = 0; index < section.values.length; index += SNAPSHOT_CACHE_CHUNK_SIZE) {
          await invoke("telegram_append_snapshot_cache_chunk", {
            transactionId,
            section: section.name,
            values: section.values.slice(index, index + SNAPSHOT_CACHE_CHUNK_SIZE),
          });
          await yieldToMainThread();
        }
      }
      await invoke("telegram_commit_snapshot_cache_write", { transactionId });
    } catch (error) {
      await invoke("telegram_abort_snapshot_cache_write", { transactionId }).catch(() => undefined);
      throw error;
    }
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

  getCacheUsage() {
    return invoke<CacheUsage>("telegram_cache_usage");
  }

  clearMediaCache(input: CacheCleanupInput) {
    return invoke<CacheCleanupResult>("telegram_clear_media_cache", { request: input });
  }
}
