import { invoke, isTauri } from "@tauri-apps/api/core";

export const ACCOUNT_METADATA_KEYS = [
  "notgram:managed-downloads:v1", "notgram:local-user-blocks:v1", "notgram:conversation-activity:v1",
] as const;
type MetadataKey = typeof ACCOUNT_METADATA_KEYS[number];
const values = new Map<string, string>();
const subscribers = new Map<string, Set<() => void>>();
let writes: Promise<unknown> = Promise.resolve();
let initialization: Promise<void> | undefined;

export const readAccountMetadata = (key: MetadataKey) => isTauri()
  ? values.get(key) ?? null : globalThis.localStorage?.getItem(key) ?? null;

export const writeAccountMetadata = (key: MetadataKey, value: string) => {
  if (!isTauri()) { globalThis.localStorage?.setItem(key, value); return; }
  if (!values.has(key)) return; // Ignore mount-time projections until durable metadata has loaded.
  values.set(key, value);
  writes = writes.catch(() => undefined).then(() => invoke("telegram_write_account_metadata", { key, records: JSON.parse(value) }));
  void writes.catch(() => globalThis.dispatchEvent(new Event("notgram:local-save-failed")));
};

export const flushAccountMetadata = async () => { await writes; };

export const subscribeAccountMetadata = (key: MetadataKey, callback: () => void) => {
  const listeners = subscribers.get(key) ?? new Set();
  listeners.add(callback);
  subscribers.set(key, listeners);
  return () => { listeners.delete(callback); };
};

export const initializeAccountMetadata = () => {
  if (!isTauri()) return Promise.resolve();
  initialization ??= (async () => {
    for (const key of ACCOUNT_METADATA_KEYS) {
      const stored = await invoke<unknown[] | null>("telegram_read_account_metadata", { key });
      const legacy = globalThis.localStorage?.getItem(key);
      const serialized = JSON.stringify(stored ?? (legacy ? JSON.parse(legacy) : []));
      if (stored === null && legacy) {
        await invoke("telegram_write_account_metadata", { key, records: JSON.parse(serialized) });
      }
      values.set(key, serialized);
      if (legacy) globalThis.localStorage.removeItem(key);
      for (const callback of subscribers.get(key) ?? []) callback();
    }
  })();
  return initialization;
};
