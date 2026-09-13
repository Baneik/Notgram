import { asTdObject, type TdObject } from "./tdlibMapper";

type QueuedDownload = {
  fileId: number;
  priority: number;
  resolve: () => void;
  reject: (reason: Error) => void;
  stallTimer?: ReturnType<typeof globalThis.setTimeout>;
  lastDownloadedSize: number;
};

type RequestFile = (request: TdObject) => Promise<TdObject>;

// Keep enough slots for a fast conversation switch while retaining a small
// reservation for low-priority prefetch work.
const MAX_ACTIVE_DOWNLOADS = 12;
const MAX_BACKGROUND_DOWNLOADS = 3;
const INTERACTIVE_PRIORITY = 20;
const DOWNLOAD_STALL_MS = 45_000;

const clampPriority = (priority: number) => Math.max(1, Math.min(priority, 32));

export class FileDownloadQueue {
  private queue: QueuedDownload[] = [];
  private active = new Map<number, QueuedDownload>();
  private promises = new Map<number, Promise<void>>();
  private suppressed = new Set<number>();

  constructor(
    private readonly request: RequestFile,
    private readonly onFile: (file: TdObject) => void,
    private readonly onStall?: (fileId: number) => void,
  ) {}

  cache(fileId: number, priority = 16) {
    if (this.suppressed.has(fileId)) return Promise.resolve();
    const existing = this.promises.get(fileId);
    if (existing) {
      this.promote(fileId, priority);
      return existing;
    }

    let resolveDownload!: () => void;
    let rejectDownload!: (reason: Error) => void;
    const result = new Promise<void>((resolve, reject) => {
      resolveDownload = resolve;
      rejectDownload = reject;
    });
    this.promises.set(fileId, result);
    this.queue.push({
      fileId,
      priority: clampPriority(priority),
      resolve: resolveDownload,
      reject: rejectDownload,
      lastDownloadedSize: 0,
    });
    this.sortQueue();
    this.pump();
    return result;
  }

  get(fileId: number) {
    return this.promises.get(fileId);
  }

  promote(fileId: number, priority = 24) {
    const nextPriority = clampPriority(priority);
    const active = this.active.get(fileId);
    if (active) {
      if (nextPriority <= active.priority) return;
      active.priority = nextPriority;
      void this.requestFile(active);
      return;
    }

    const queuedIndex = this.queue.findIndex((download) => download.fileId === fileId);
    if (queuedIndex < 0) return;
    const download = this.queue[queuedIndex];
    if (nextPriority <= download.priority) return;
    download.priority = nextPriority;
    this.sortQueue();
    this.pump();
  }

  cancel(fileId: number) {
    const queuedIndex = this.queue.findIndex((download) => download.fileId === fileId);
    if (queuedIndex >= 0) {
      const [download] = this.queue.splice(queuedIndex, 1);
      this.promises.delete(fileId);
      download.reject(new Error("TDLib download cancelled"));
      return true;
    }

    const download = this.active.get(fileId);
    if (!download) return false;
    if (download.stallTimer !== undefined) globalThis.clearTimeout(download.stallTimer);
    this.active.delete(fileId);
    this.promises.delete(fileId);
    download.reject(new Error("TDLib download cancelled"));
    this.pump();
    return true;
  }

  handleFile(fileId: number, completed: boolean, active: boolean, downloadedSize?: number) {
    if (completed) {
      // TDLib may report completion before the queued request reaches the
      // native bridge. Settle both active and waiting entries so callers do
      // not wait for a slot that is no longer needed.
      if (!this.finish(fileId)) {
        const queuedIndex = this.queue.findIndex((download) => download.fileId === fileId);
        if (queuedIndex >= 0) {
          const [download] = this.queue.splice(queuedIndex, 1);
          this.promises.delete(fileId);
          download.resolve();
        }
      }
      this.pump();
    }
    else {
      const download = this.active.get(fileId);
      if (!download) return;
      if (!active) {
        this.finish(fileId, new Error("TDLib preview download stopped"));
        return;
      }
      if (downloadedSize !== undefined && downloadedSize > download.lastDownloadedSize) {
        download.lastDownloadedSize = downloadedSize;
        this.armStallTimer(download);
      }
    }
  }

  reset(error = new Error("TDLib session was reset")) {
    for (const download of this.queue) download.reject(error);
    for (const download of this.active.values()) {
      if (download.stallTimer !== undefined) globalThis.clearTimeout(download.stallTimer);
      download.reject(error);
    }
    this.queue = [];
    this.active.clear();
    this.promises.clear();
    this.suppressed.clear();
  }

  private pump() {
    let backgroundActive = [...this.active.values()].filter(
      (download) => download.priority < INTERACTIVE_PRIORITY,
    ).length;
    while (this.active.size < MAX_ACTIVE_DOWNLOADS && this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((download) =>
        download.priority >= INTERACTIVE_PRIORITY ||
        backgroundActive < MAX_BACKGROUND_DOWNLOADS
      );
      if (nextIndex < 0) return;
      const [download] = this.queue.splice(nextIndex, 1);
      this.active.set(download.fileId, download);
      if (download.priority < INTERACTIVE_PRIORITY) backgroundActive += 1;
      this.armStallTimer(download);
      void this.requestFile(download);
    }
  }

  private sortQueue() {
    this.queue.sort((left, right) => right.priority - left.priority);
  }

  private async requestFile(download: QueuedDownload) {
    try {
      const file = await this.request({
        "@type": "downloadFile",
        file_id: download.fileId,
        priority: download.priority,
        offset: 0,
        limit: 0,
        synchronous: false,
      });
      // A completion update or cancellation may have retired this request while
      // TDLib was processing it. Do not let its late response resurrect stale
      // media state or affect a newer retry for the same file.
      if (this.active.get(download.fileId) !== download) return;
      this.onFile(file);
      if (this.active.get(download.fileId) !== download) return;
      const local = asTdObject(file.local);
      if (local?.is_downloading_completed === true) {
        this.finish(download.fileId);
      } else if (local?.is_downloading_active !== true) {
        this.finish(
          download.fileId,
          new Error("TDLib did not start the preview download"),
        );
      }
    } catch (error) {
      if (this.active.get(download.fileId) !== download) return;
      this.finish(
        download.fileId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private finish(fileId: number, error?: Error) {
    const download = this.active.get(fileId);
    if (!download) return false;
    if (download.stallTimer !== undefined) globalThis.clearTimeout(download.stallTimer);
    this.active.delete(fileId);
    this.promises.delete(fileId);
    if (error) download.reject(error);
    else download.resolve();
    this.pump();
    return true;
  }

  suppress(fileId: number) {
    this.suppressed.add(fileId);
    this.cancel(fileId);
  }

  allow(fileId: number) {
    this.suppressed.delete(fileId);
  }

  /** Release an automatic prefetch when its view is no longer mounted. */
  release(fileId: number) {
    const queued = this.queue.find((download) => download.fileId === fileId);
    if (queued && queued.priority < INTERACTIVE_PRIORITY) return this.cancel(fileId);
    const active = this.active.get(fileId);
    if (active && active.priority < INTERACTIVE_PRIORITY) return this.cancel(fileId);
    return false;
  }

  private armStallTimer(download: QueuedDownload) {
    if (download.stallTimer !== undefined) globalThis.clearTimeout(download.stallTimer);
    download.stallTimer = globalThis.setTimeout(() => {
      if (this.active.get(download.fileId) !== download) return;
      this.onStall?.(download.fileId);
      this.finish(download.fileId, new Error("TDLib preview download stalled without progress"));
    }, DOWNLOAD_STALL_MS);
  }
}
