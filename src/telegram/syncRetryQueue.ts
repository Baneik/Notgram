export const isRetryableSyncError = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code !== "number" || code < 400 || code >= 500 || code === 429;
};

/** Coalesces read-only synchronization retries with a capped backoff. */
export class SyncRetryQueue {
  private entries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly canRun: () => boolean) {}

  schedule(key: string, retry: () => Promise<unknown>, error?: unknown) {
    if (!isRetryableSyncError(error)) {
      this.complete(key);
      return;
    }
    const entry = this.entries.get(key) ?? { attempts: 0 };
    if (entry.timer) return;
    const delay = Math.min(++entry.attempts * 5_000, 15_000);
    entry.timer = globalThis.setTimeout(() => {
      entry.timer = undefined;
      if (this.canRun()) void retry();
    }, delay);
    this.entries.set(key, entry);
  }

  complete(key: string) {
    const entry = this.entries.get(key);
    if (entry?.timer) globalThis.clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  clear() {
    for (const key of this.entries.keys()) this.complete(key);
  }
}
