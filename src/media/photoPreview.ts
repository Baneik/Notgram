import { isNativeAssetSource } from "./localAssetCache";
import { logPerformance } from "../utils/performanceMonitor";

export interface PhotoPreviewSize { width: number; height: number; cover: boolean }
export interface PhotoPreview {
  url: string;
  blob: Blob;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}
type Entry = {
  source: string;
  size: PhotoPreviewSize;
  users: number;
  controller: AbortController;
  promise: Promise<PhotoPreview>;
  resolve: (preview: PhotoPreview) => void;
  reject: (error: Error) => void;
  value?: PhotoPreview;
  bytes: number;
  queuedAt: number;
  token: number;
};
const entries = new Map<string, Entry>();
const queue: Entry[] = [];
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_ENTRIES = 128;
let bytes = 0;
let running = 0;
let nextToken = 0;
const resetListeners = new Set<() => void>();

export const onPhotoPreviewCacheCleared = (listener: () => void) => {
  resetListeners.add(listener);
  return () => { resetListeners.delete(listener); };
};

export const photoPreviewSize = (width: number, height: number, cover: boolean): PhotoPreviewSize => {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), cover };
};
const keyFor = (source: string, size: PhotoPreviewSize) => JSON.stringify([source, size.width, size.height, size.cover]);
export const getPhotoPreview = (source: string, size: PhotoPreviewSize) => entries.get(keyFor(source, size))?.value;
export const latestPhotoPreview = (source: string, cover: boolean) => {
  const entry = [...entries.values()].reverse().find(entry => entry.source === source && entry.size.cover === cover && entry.value);
  return entry ? { size: entry.size, value: entry.value! } : undefined;
};

const discard = (key: string, entry: Entry) => {
  entries.delete(key);
  entry.controller.abort();
  entry.reject(new Error("Photo preview released"));
  if (entry.value) URL.revokeObjectURL(entry.value.url);
  bytes -= entry.bytes;
  const queued = queue.indexOf(entry);
  if (queued >= 0) queue.splice(queued, 1);
};
const trim = () => {
  for (const [key, entry] of entries) {
    if (bytes <= MAX_BYTES && entries.size <= MAX_ENTRIES) break;
    if (entry.users === 0 && entry.value) discard(key, entry);
  }
};
export const clearPhotoPreviewCache = () => {
  for (const listener of resetListeners) listener();
  for (const [key, entry] of entries) discard(key, entry);
  queue.length = 0;
};
export const invalidatePhotoPreview = (source: string, size: PhotoPreviewSize) => {
  const key = keyFor(source, size);
  const entry = entries.get(key);
  if (entry) discard(key, entry);
};

const resizeInWorker = (blob: Blob, size: PhotoPreviewSize, signal: AbortSignal) => new Promise<{
  blob: Blob; width: number; height: number; sourceWidth: number; sourceHeight: number;
}>((resolve, reject) => {
  const worker = new Worker(new URL("./photoPreview.worker.ts", import.meta.url), { type: "module" });
  const finish = () => { signal.removeEventListener("abort", abort); worker.terminate(); };
  const abort = () => { finish(); reject(new Error("Photo preview cancelled")); };
  signal.addEventListener("abort", abort, { once: true });
  worker.onerror = () => { finish(); reject(new Error("Photo preview worker failed")); };
  worker.onmessage = ({ data }) => {
    finish();
    if (data.failed) reject(new Error("Photo preview decode failed"));
    else resolve(data);
  };
  worker.postMessage({ blob, ...size });
});

const load = async (entry: Entry) => {
  const native = isNativeAssetSource(entry.source);
  const source = native
    ? `${entry.source}?width=${entry.size.width}&height=${entry.size.height}&fit=${entry.size.cover ? "cover" : "contain"}`
    : entry.source;
  const response = await fetch(source, { signal: entry.controller.signal });
  if (!response.ok) throw new Error(`Photo preview unavailable (${response.status})`);
  if (Number(response.headers.get("content-length")) > 64 * 1024 * 1024) {
    void response.body?.cancel();
    throw new Error("Photo preview source is too large");
  }
  const blob = await response.blob();
  if (blob.size > 64 * 1024 * 1024) throw new Error("Photo preview source is too large");
  if (entry.controller.signal.aborted) throw new Error("Photo preview cancelled");
  // GIF image documents retain their browser animation instead of being
  // replaced by a still first frame on the non-native path.
  if (!native && blob.type === "image/gif") throw new Error("Animated photo uses its original source");
  const result = native ? {
    blob,
    width: Number(response.headers.get("X-Preview-Width")),
    height: Number(response.headers.get("X-Preview-Height")),
    sourceWidth: Number(response.headers.get("X-Source-Width")),
    sourceHeight: Number(response.headers.get("X-Source-Height")),
  } : await resizeInWorker(blob, entry.size, entry.controller.signal);
  if (![result.width, result.height, result.sourceWidth, result.sourceHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid photo preview dimensions");
  }
  return { result, cached: response.headers.get("X-Preview-Cached") === "1" };
};

const pump = () => {
  while (running < 2 && queue.length) {
    const entry = queue.shift()!;
    if (entry.controller.signal.aborted) continue;
    running++;
    const started = performance.now();
    void load(entry).then(({ result, cached }) => {
      if (entry.controller.signal.aborted) return;
      const { blob, ...dimensions } = result;
      const value = { ...dimensions, blob, url: URL.createObjectURL(blob) };
      entry.value = value;
      entry.bytes = result.blob.size + result.width * result.height * 4;
      bytes += entry.bytes;
      logPerformance("ui_photo_preview", {
        durationMs: performance.now() - started, queueDurationMs: started - entry.queuedAt,
        sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight,
        imageWidth: result.width, imageHeight: result.height, byteCount: result.blob.size, cached,
        imageToken: entry.token, phase: 1,
      });
      entry.resolve(value);
      trim();
    }).catch((error: unknown) => {
      const key = keyFor(entry.source, entry.size);
      if (entries.get(key) === entry) entries.delete(key);
      entry.reject(error instanceof Error ? error : new Error("Photo preview failed"));
    }).finally(() => { running--; pump(); });
  }
};

/** Share prepared display pixels across virtual rows; never retain an original bitmap. */
export const retainPhotoPreview = (source: string, size: PhotoPreviewSize) => {
  const key = keyFor(source, size);
  let entry = entries.get(key);
  if (!entry) {
    let resolve!: Entry["resolve"];
    let reject!: Entry["reject"];
    const promise = new Promise<PhotoPreview>((ok, fail) => { resolve = ok; reject = fail; });
    entry = { source, size, users: 0, controller: new AbortController(), promise, resolve, reject, bytes: 0, queuedAt: performance.now(), token: ++nextToken };
    entries.set(key, entry);
    queue.push(entry);
  } else {
    entries.delete(key);
    entries.set(key, entry);
  }
  entry.users++;
  if (entry.value) logPerformance("ui_photo_preview", {
    durationMs: 0, cached: true, imageToken: entry.token, phase: 2,
    imageWidth: entry.value.width, imageHeight: entry.value.height,
  });
  pump();
  const retained = entry;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      retained.users--;
      if (retained.users === 0 && !retained.value && entries.get(key) === retained) discard(key, retained);
      trim();
    },
  };
};
