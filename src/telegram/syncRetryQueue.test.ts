import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRetryQueue } from "./syncRetryQueue";

describe("synchronization retries", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces failures, caps backoff, and cancels completed or retired work", async () => {
    vi.useFakeTimers();
    const queue = new SyncRetryQueue(() => true);
    const retry = vi.fn(async () => { queue.schedule("history", retry); });
    queue.schedule("history", retry);
    queue.schedule("history", retry);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(retry).toHaveBeenCalledTimes(4);
    queue.complete("history");
    queue.schedule("list", retry);
    queue.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(4);
  });

  it("does not poll forbidden reads and does not issue requests while offline", async () => {
    vi.useFakeTimers();
    const retry = vi.fn(async () => undefined);
    let online = true;
    const queue = new SyncRetryQueue(() => online);
    queue.schedule("forbidden", retry, Object.assign(new Error("forbidden"), { code: 403 }));
    queue.schedule("offline", retry);
    online = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(retry).not.toHaveBeenCalled();
    queue.clear();
  });
});
