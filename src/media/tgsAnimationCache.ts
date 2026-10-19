import { forgetMediaPreview } from "./mediaPreviewCache";
import { memoryCacheBudget, registerMemoryCache } from "./memoryCacheBudget";

type AnimationData = Record<string, unknown>;

const MAX_ENTRIES = 128;
const animations = new Map<string, { serialized: string; bytes: number; touchedAt: number }>();
const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>();
let cachedBytes = 0;

/** Lottie mutates its input. Retain compact JSON and parse a private player copy
 * instead of keeping both a parsed master graph and every player's clone. */
export const loadTgsAnimationData = async (src: string): Promise<AnimationData> => {
  const cached = animations.get(src);
  if (cached) {
    animations.delete(src);
    animations.set(src, cached);
    cached.touchedAt = Date.now();
    return JSON.parse(cached.serialized) as AnimationData;
  }
  let request = pending.get(src);
  if (!request) {
    const controller = new AbortController();
    const promise = Promise.all([
      fetch(src, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load TGS sticker (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      }),
      import("pako"),
    ]).then(([compressed, { ungzip }]) => {
      if (controller.signal.aborted) throw new DOMException("TGS cache was cleared", "AbortError");
      const serialized = ungzip(compressed, { toText: true });
      JSON.parse(serialized); // Invalid data must not poison the shared cache.
      const bytes = serialized.length * 2;
      if (!controller.signal.aborted && bytes <= memoryCacheBudget("tgsAnimations")) {
        animations.set(src, { serialized, bytes, touchedAt: Date.now() });
        cachedBytes += bytes;
        while (animations.size > MAX_ENTRIES || cachedBytes > memoryCacheBudget("tgsAnimations")) {
          const oldest = animations.keys().next().value!;
          cachedBytes -= animations.get(oldest)!.bytes;
          animations.delete(oldest);
        }
      }
      return serialized;
    }).finally(() => {
      if (pending.get(src)?.promise === promise) pending.delete(src);
    });
    request = { promise, controller };
    pending.set(src, request);
  }
  return JSON.parse(await request.promise) as AnimationData;
};

export const invalidateTgsAnimation = (src: string) => {
  forgetMediaPreview(src);
  pending.get(src)?.controller.abort();
  pending.delete(src);
  const cached = animations.get(src);
  if (cached) { cachedBytes -= cached.bytes; animations.delete(src); }
};

export const clearTgsAnimationCache = () => {
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
  animations.clear();
  cachedBytes = 0;
};

registerMemoryCache("tgsAnimations", {
  read: () => ({ entries: animations.size, bytes: cachedBytes, pending: pending.size }),
  trim: idleBefore => {
    for (const [src, cached] of animations) {
      if (cached.touchedAt <= idleBefore || cachedBytes > memoryCacheBudget("tgsAnimations")) {
        cachedBytes -= cached.bytes;
        animations.delete(src);
      }
    }
  },
});
