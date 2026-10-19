export type MemoryCacheKind = "localAssets" | "photoPreviews" | "mediaPreviews" | "tgsAnimations" |
  "viewerImages" | "stickerPreviews" | "sharedMedia";

export interface MemoryCacheUsage {
  entries: number;
  bytes: number;
  activeBytes?: number;
  pending?: number;
}

export interface ManagedMemoryCache {
  read: () => MemoryCacheUsage;
  trim: (idleBefore: number) => void;
  onBackgroundChanged?: (background: boolean) => void;
}

const MiB = 1024 * 1024;
// These are retained-resource budgets, not process limits. Mounted owners may
// exceed them until release; reclaiming their URLs would break live media.
const budgets: Record<MemoryCacheKind, readonly [number, number]> = {
  localAssets: [20 * MiB, 4 * MiB],
  photoPreviews: [24 * MiB, 4 * MiB],
  mediaPreviews: [8 * MiB, 2 * MiB],
  tgsAnimations: [8 * MiB, 2 * MiB],
  viewerImages: [64 * MiB, 0],
  stickerPreviews: [8 * MiB, 2 * MiB],
  sharedMedia: [8 * MiB, 2 * MiB],
};
const caches = new Map<MemoryCacheKind, ManagedMemoryCache>();
let background = false;

export const isMemoryBackground = () => background;
export const memoryCacheBudget = (kind: MemoryCacheKind) => budgets[kind][background ? 1 : 0];
export const setMemoryBackground = (value: boolean) => {
  if (value === background) return;
  background = value;
  for (const cache of caches.values()) cache.onBackgroundChanged?.(value);
};

export const registerMemoryCache = (kind: MemoryCacheKind, cache: ManagedMemoryCache) => {
  caches.set(kind, cache);
  if (background) cache.onBackgroundChanged?.(true);
  return () => { if (caches.get(kind) === cache) caches.delete(kind); };
};

export const readMemoryCacheUsage = () => [...caches].map(([kind, cache]) => ({ kind, ...cache.read(), budgetBytes: memoryCacheBudget(kind) }));

export const sweepMemoryCaches = (now = Date.now()) => {
  const idleBefore = now - (background ? 15_000 : 120_000);
  for (const cache of caches.values()) cache.trim(idleBefore);
};
