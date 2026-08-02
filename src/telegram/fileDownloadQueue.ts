import { asTdObject, type TdObject } from "./tdlibMapper";

type QueuedDownload = {
  fileId: number;
  priority: number;
  resolve: () => void;
  reject: (reason: Error) => void;
  stallTimer?: ReturnType<typeof globalThis.setTimeout>;
};

type RequestFile = (request: TdObject) => Promise<TdObject>;

const MAX_ACTIVE_DOWNLOADS = 4;
const DOWNLOAD_STALL_MS = 45_000;

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
    if (existing) return existing;

    let resolveDownload!: () => void;
    let rejectDownload!: (reason: Error) => void;
    const result = new Promise<void>((resolve, reject) => {
      resolveDownload = resolve;
      rejectDownload = reject;
    });
    this.promises.set(fileId, result);
    this.queue.push({
      fileId,
      priority: Math.max(1, Math.min(priority, 32)),
      resolve: resolveDownload,
      reject: rejectDownload,
    });
    this.pump();
    return result;
  }

  get(fileId: number) {
    return this.promises.get(fileId);
  }

  promote(fileId: number, priority = 24) {
    const queuedIndex = this.queue.findIndex((download) => download.fileId === fileId);
    if (queuedIndex < 0) return;
    const [download] = this.queue.splice(queuedIndex, 1);
    download.priority = priority;
    this.queue.unshift(download);
    this.pump();
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
    while (this.active.size < MAX_ACTIVE_DOWNLOADS && this.queue.length > 0) {
      const download = this.queue.shift();
      if (!download) return;
      this.active.set(download.fileId, download);
      download.stallTimer = globalThis.setTimeout(() => {
        this.finish(download.fileId, new Error("TDLib preview download stalled"));
      }, DOWNLOAD_STALL_MS);
      void this.request({
        "@type": "downloadFile",
        file_id: download.fileId,
        priority: download.priority,
        offset: 0,
        limit: 0,
        synchronous: false,
      })
        .then((file) => {
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
        })
        .catch((error) => {
          this.finish(
            download.fileId,
            error instanceof Error ? error : new Error(String(error)),
          );
        });
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
