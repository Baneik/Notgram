import { logPerformance } from "../utils/performanceMonitor";

type Entry = {
  image: HTMLImageElement;
  promise: Promise<HTMLImageElement>;
  controller: AbortController;
  users: number;
  ready: boolean;
  bytes: number;
};

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 3;
const MAX_BYTES = 192 * 1024 * 1024;
let bytes = 0;

const discard = (source: string, entry: Entry) => {
  if (entries.get(source) !== entry) return;
  entries.delete(source);
  bytes -= entry.bytes;
  entry.controller.abort();
  entry.image.remove();
  entry.image.removeAttribute("src");
};

const trim = () => {
  for (const [source, entry] of entries) {
    if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    // A displayed original can exceed the idle budget; never discard live pixels.
    if (entry.users === 0) discard(source, entry);
  }
};

export const clearViewerImages = () => {
  for (const [source, entry] of entries) discard(source, entry);
};

export const hasViewerImage = (source: string) => entries.get(source)?.ready === true;

export const canWarmViewerImage = (width?: number, height?: number) => {
  if (!width || !height) return false;
  const liveBytes = [...entries.values()].reduce((total, entry) => total + (entry.users > 0 ? entry.bytes : 0), 0);
  return liveBytes + width * height * 4 <= MAX_BYTES;
};

/** Keep the decoded element itself: a remembered URL cannot guarantee warm pixels. */
export const retainViewerImage = (source: string, priority: "high" | "low" = "high") => {
  let entry = entries.get(source);
  if (!entry) {
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = priority;
    const controller = new AbortController();
    const created: Entry = { image, controller, users: 0, ready: false, bytes: 0, promise: undefined! };
    created.promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const abort = () => reject(new Error("Viewer image released"));
      controller.signal.addEventListener("abort", abort, { once: true });
      image.onerror = () => {
        reject(new Error("Viewer image unavailable"));
        discard(source, created);
      };
      image.onload = () => {
        const started = performance.now();
        const decode = typeof image.decode === "function" ? image.decode() : Promise.resolve();
        void decode.then(() => {
          if (controller.signal.aborted || entries.get(source) !== created) return;
          if (!image.complete || image.naturalWidth < 1) throw new Error("Viewer image unavailable");
          created.ready = true;
          created.bytes = image.naturalWidth * image.naturalHeight * 4;
          bytes += created.bytes;
          image.onload = null;
          image.onerror = null;
          controller.signal.removeEventListener("abort", abort);
          logPerformance("ui_media_viewer_image", {
            durationMs: performance.now() - started, phase: 2,
            sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight,
          });
          resolve(image);
          trim();
        }).catch(error => { reject(error); discard(source, created); });
      };
    });
    // Cancellation may happen before a mounted owner subscribes to the promise.
    void created.promise.catch(() => undefined);
    entries.set(source, created);
    entry = created;
    image.src = source;
  } else {
    entries.delete(source);
    entries.set(source, entry);
    if (priority === "high") entry.image.fetchPriority = priority;
  }
  entry.users++;
  const retained = entry;
  let released = false;
  return {
    image: entry.image,
    ready: entry.ready,
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      retained.users--;
      // StrictMode can immediately reacquire a pending source. Allow that before
      // cancelling ownerless work, while navigation still cancels stale decodes.
      queueMicrotask(() => {
        if (!retained.ready && retained.users === 0) discard(source, retained);
        trim();
      });
    },
  };
};
