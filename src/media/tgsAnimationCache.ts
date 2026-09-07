type AnimationData = Record<string, unknown>;

const MAX_ENTRIES = 128;
const MAX_SERIALIZED_BYTES = 32 * 1024 * 1024;
const animations = new Map<string, { data: AnimationData; bytes: number }>();
const pending = new Map<string, { promise: Promise<AnimationData>; controller: AbortController }>();
let cachedBytes = 0;

/** Lottie mutates its input; each player receives a clone of the decoded master. */
export const loadTgsAnimationData = async (src: string): Promise<AnimationData> => {
  const cached = animations.get(src);
  if (cached) {
    animations.delete(src);
    animations.set(src, cached);
    return structuredClone(cached.data);
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
      const data = JSON.parse(serialized) as AnimationData;
      const bytes = serialized.length * 2;
      if (!controller.signal.aborted && bytes <= MAX_SERIALIZED_BYTES) {
        animations.set(src, { data, bytes });
        cachedBytes += bytes;
        while (animations.size > MAX_ENTRIES || cachedBytes > MAX_SERIALIZED_BYTES) {
          const oldest = animations.keys().next().value!;
          cachedBytes -= animations.get(oldest)!.bytes;
          animations.delete(oldest);
        }
      }
      return data;
    }).finally(() => {
      if (pending.get(src)?.promise === promise) pending.delete(src);
    });
    request = { promise, controller };
    pending.set(src, request);
  }
  return structuredClone(await request.promise);
};

export const invalidateTgsAnimation = (src: string) => {
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
