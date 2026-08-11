import { describe, expect, it, vi } from "vitest";
import { FileDownloadQueue } from "./fileDownloadQueue";
import type { TdObject } from "./tdlibMapper";

describe("FileDownloadQueue cancellation", () => {
  it("removes a queued download before TDLib receives it", async () => {
    const request = vi.fn((_request: TdObject) => new Promise<TdObject>(() => undefined));
    const queue = new FileDownloadQueue(request, () => undefined);
    const downloads = [1, 2, 3, 4, 5].map((fileId) => queue.cache(fileId));
    const cancelled = downloads[4].catch((error: unknown) => error);

    expect(request).toHaveBeenCalledTimes(3);
    expect(queue.cancel(5)).toBe(true);
    await expect(cancelled).resolves.toMatchObject({ message: "TDLib download cancelled" });
    expect(request.mock.calls.some(([value]) => value.file_id === 5)).toBe(false);
  });

  it("rejects and forgets an active download so it can be retried", async () => {
    const request = vi.fn(async () => ({
      "@type": "file",
      local: { is_downloading_active: true, is_downloading_completed: false },
    }));
    const queue = new FileDownloadQueue(request, () => undefined);
    const first = queue.cache(8);
    const cancelled = first.catch((error: unknown) => error);
    await Promise.resolve();

    expect(queue.cancel(8)).toBe(true);
    await expect(cancelled).resolves.toMatchObject({ message: "TDLib download cancelled" });
    expect(queue.get(8)).toBeUndefined();
    expect(queue.cache(8)).not.toBe(first);
  });

  it("ignores cancellation for an unknown file", () => {
    const queue = new FileDownloadQueue(
      async () => ({ "@type": "file" }),
      () => undefined,
    );
    expect(queue.cancel(99)).toBe(false);
  });

  it("reserves capacity for visible media when background downloads are queued", async () => {
    const request = vi.fn((_request: TdObject) => new Promise<TdObject>(() => undefined));
    const queue = new FileDownloadQueue(request, () => undefined);

    for (let fileId = 1; fileId <= 6; fileId += 1) void queue.cache(fileId, 12);
    await Promise.resolve();
    expect(request.mock.calls.map(([value]) => value.file_id)).toEqual([1, 2, 3]);

    void queue.cache(20, 28);
    await Promise.resolve();
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      file_id: 20,
      priority: 28,
    });
  });

  it("promotes an existing queued download instead of waiting behind background work", async () => {
    const request = vi.fn((_request: TdObject) => new Promise<TdObject>(() => undefined));
    const queue = new FileDownloadQueue(request, () => undefined);

    for (let fileId = 1; fileId <= 4; fileId += 1) void queue.cache(fileId, 12);
    const queued = queue.get(4);
    const promoted = queue.cache(4, 28);
    await Promise.resolve();

    expect(promoted).toBe(queued);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      file_id: 4,
      priority: 28,
    });
  });

  it("treats the stall limit as an idle timeout and refreshes it on byte progress", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({
        "@type": "file",
        local: { is_downloading_active: true, is_downloading_completed: false },
      }));
      const onStall = vi.fn();
      const queue = new FileDownloadQueue(request, () => undefined, onStall);
      const download = queue.cache(30).catch((error: unknown) => error);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(44_000);
      queue.handleFile(30, false, true, 1_024);
      await vi.advanceTimersByTimeAsync(44_000);
      expect(onStall).not.toHaveBeenCalled();
      expect(queue.get(30)).toBeDefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(download).resolves.toMatchObject({
        message: "TDLib preview download stalled without progress",
      });
      expect(onStall).toHaveBeenCalledWith(30);
      expect(queue.get(30)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
