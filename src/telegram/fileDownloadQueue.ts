import { asTdObject, type TdObject } from "./tdlibMapper";

type QueuedDownload = {
  fileId: number;
  priority: number;
  resolve: () => void;
  reject: (reason: Error) => void;
  stallTimer?: ReturnType<typeof globalThis.setTimeout>;
};

type RequestFile = (request: TdObject) => Promise<TdObject>;

const MAX_ACTIVE_DOWNLOADS = 6;
const MAX_BACKGROUND_DOWNLOADS = 3;
const INTERACTIVE_PRIORITY = 20;
const DOWNLOAD_STALL_MS = 45_000;

const clampPriority = (priority: number) => Math.max(1, Math.min(priority, 32));

export class FileDownloadQueue {
  private queue: QueuedDownload[] = [];
  private active = new Map<number, QueuedDownload>();
  private promises = new Map<number, Promise<void>>();

  constructor(
    private readonly request: RequestFile,
    private readonly onFile: (file: TdObject) => void,
  ) {}

  cache(fileId: number, priority = 16) {
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

  handleFile(fileId: number, completed: boolean, active: boolean) {
    if (completed) this.finish(fileId);
    else if (this.active.has(fileId) && !active) {
      this.finish(fileId, new Error("TDLib preview download stopped"));
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
      download.stallTimer = globalThis.setTimeout(() => {
        this.finish(download.fileId, new Error("TDLib preview download stalled"));
      }, DOWNLOAD_STALL_MS);
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
      this.onFile(file);
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
      this.finish(
        download.fileId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private finish(fileId: number, error?: Error) {
    const download = this.active.get(fileId);
    if (!download) return;
    if (download.stallTimer !== undefined) globalThis.clearTimeout(download.stallTimer);
    this.active.delete(fileId);
    this.promises.delete(fileId);
    if (error) download.reject(error);
    else download.resolve();
    this.pump();
  }
}
