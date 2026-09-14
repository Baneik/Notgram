import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TdObject } from "./tdlibMapper";

export interface NativeUpdateBatch {
  streamId: number;
  sequence: number;
  updates: TdObject[];
  pendingCount: number;
  oldestAgeMs: number;
}

interface UpdateBridge {
  open: () => Promise<number>;
  take: (streamId: number, acknowledged: number) => Promise<NativeUpdateBatch>;
  close: (streamId: number) => Promise<unknown>;
  listen: (wake: () => void) => Promise<UnlistenFn>;
  yield: () => Promise<void>;
}

const bridge: UpdateBridge = {
  open: () => invoke("telegram_open_update_stream"),
  take: (streamId, acknowledged) => invoke("telegram_take_updates", { streamId, acknowledged }),
  close: streamId => invoke("telegram_close_update_stream", { streamId }),
  listen: wake => listen("telegram://updates-available", wake),
  yield: () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
};

/** One leased packet at a time; acknowledge only after all ordered updates apply. */
export class TdUpdateStream {
  private streamId?: number;
  private acknowledged = 0;
  private running = false;
  private disposed = false;
  private halted = false;
  private wakePending = false;
  private unlisten?: UnlistenFn;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly apply: (updates: TdObject[], offset: number, budgetMs: number) => number,
    private readonly onError: (error: unknown, fatal: boolean) => void,
    private readonly diagnostic: (batch: NativeUpdateBatch, durationMs: number) => void,
    private readonly native: UpdateBridge = bridge,
  ) {}

  async start() {
    this.unlisten = await this.native.listen(this.wake);
    if (this.disposed) { this.unlisten(); return; }
    const id = await this.native.open();
    if (this.disposed) { await this.native.close(id); return; }
    this.streamId = id;
    // This also covers a wakeup lost during registration or native emit failure.
    this.timer = globalThis.setInterval(this.wake, 10_000);
    globalThis.addEventListener?.("focus", this.wake);
    globalThis.document?.addEventListener("visibilitychange", this.wake);
    this.wake();
  }

  wake = () => {
    if (this.disposed || this.halted || this.streamId === undefined) return;
    this.wakePending = true;
    if (!this.running) void this.pump();
  };

  private async pump() {
    this.running = true;
    this.wakePending = false;
    try {
      while (!this.disposed && this.streamId !== undefined) {
        const batch = await this.native.take(this.streamId, this.acknowledged);
        if (this.disposed) return;
        if (batch.streamId !== this.streamId || (batch.updates.length > 0 && batch.sequence !== this.acknowledged + 1)) {
          this.halted = true;
          throw new Error("Update stream sequence mismatch");
        }
        if (batch.updates.length === 0) break;
        const started = performance.now();
        let offset = 0;
        while (offset < batch.updates.length && !this.disposed) {
          let consumed: number;
          try { consumed = this.apply(batch.updates, offset, 4); }
          catch (error) {
            // A partially applied packet cannot be replayed safely. Surface the
            // fault and retain its native lease until the session is restarted.
            this.halted = true;
            throw error;
          }
          if (!Number.isInteger(consumed) || consumed <= 0 || consumed > batch.updates.length - offset) {
            this.halted = true;
            throw new Error("Invalid update stream progress");
          }
          offset += consumed;
          // Yield a task, including between packets, so input and rendering run
          // before the next native response can extend a backlog processing turn.
          await this.native.yield();
        }
        if (this.disposed) return;
        this.acknowledged = batch.sequence;
        this.diagnostic(batch, performance.now() - started);
      }
    } catch (error) {
      if (!this.disposed) this.onError(error, this.halted);
    } finally {
      this.running = false;
      if (this.wakePending && !this.disposed) this.wake();
    }
  }

  dispose() {
    this.disposed = true;
    this.unlisten?.();
    globalThis.clearInterval(this.timer);
    globalThis.removeEventListener?.("focus", this.wake);
    globalThis.document?.removeEventListener("visibilitychange", this.wake);
    if (this.streamId !== undefined) void this.native.close(this.streamId).catch(() => undefined);
  }
}
