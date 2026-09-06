const MAX_ENTRIES = 512;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

type CacheEntry = {
  promise: Promise<string>;
  controller: AbortController;
  objectUrl?: string;
  bytes: number;
  users: number;
};

const entries = new Map<string, CacheEntry>();
let cachedBytes = 0;

const trimCache = () => {
  for (const [source, entry] of entries) {
    if (entries.size <= MAX_ENTRIES && cachedBytes <= MAX_BYTES) break;
    // Live video players may still seek through their URL. Evict only idle data.
    if (entry.users > 0 || !entry.objectUrl) continue;
    entries.delete(source);
    cachedBytes -= entry.bytes;
    URL.revokeObjectURL(entry.objectUrl);
  }
};

export const isNativeAssetSource = (source: string) =>
  /^(?:https?:\/\/notgram-asset\.localhost\/|notgram-asset:\/\/)/i.test(source);

/** Synchronous reads avoid restarting the placeholder on a composer remount. */
export const getCachedLocalAsset = (source: string) => entries.get(source)?.objectUrl;

/** Native assets use no-store; retain sticker bytes only for the current account. */
export const retainLocalAsset = (source: string) => {
  let entry = entries.get(source);
  if (!entry) {
    const controller = new AbortController();
    const created: CacheEntry = {
      controller,
      users: 0,
      bytes: 0,
      promise: fetch(source, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`Unable to read local asset (${response.status})`);
        if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
          void response.body?.cancel();
          throw new Error("Asset requires ranged playback");
        }
        const blob = await response.blob();
        if (blob.size > MAX_FILE_BYTES) throw new Error("Asset is too large to retain");
        // A read can finish after account switch even if fetch ignores cancellation.
        if (controller.signal.aborted || entries.get(source) !== created) {
          throw new Error("Local asset cache was cleared");
        }
        const objectUrl = URL.createObjectURL(blob);
        created.objectUrl = objectUrl;
        created.bytes = blob.size;
        cachedBytes += blob.size;
        trimCache();
        return objectUrl;
      }).catch((error: unknown) => {
        if (entries.get(source) === created) entries.delete(source);
        throw error;
      }),
    };
    entries.set(source, created);
    entry = created;
  } else {
    entries.delete(source);
    entries.set(source, entry);
  }
  entry.users += 1;
  const retained = entry;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      retained.users -= 1;
      trimCache();
    },
  };
};

export const clearLocalAssetCache = () => {
  for (const entry of entries.values()) {
    entry.controller.abort();
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
  entries.clear();
  cachedBytes = 0;
};
