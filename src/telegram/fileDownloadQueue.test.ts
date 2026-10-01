import { describe, expect, it, vi } from "vitest";
import { FileDownloadQueue } from "./fileDownloadQueue";
import type { TdObject } from "./tdlibMapper";

describe("FileDownloadQueue cancellation", () => {
  it("starts small previews while all three full-file prefetch slots are occupied", async () => {
    const request = vi.fn(async (_request: TdObject) => ({ "@type": "file", local: { is_downloading_active: true } }));
    const queue = new FileDownloadQueue(request, () => undefined);
    const downloads = [1, 2, 3, 4].map(fileId => queue.cache(fileId, 18).catch(() => undefined));
    downloads.push(queue.cache(20, 19).catch(() => undefined));
    try {
      expect(request.mock.calls.map(([value]) => value.file_id)).toEqual([1, 2, 3, 20]);
    } finally {
      queue.reset();
      await Promise.all(downloads);
    }
  });

  it("bounds preview concurrency and schedules explicit downloads first when a slot opens", async () => {
    const request = vi.fn(async (_request: TdObject) => ({ "@type": "file", local: { is_downloading_active: true } }));
    const queue = new FileDownloadQueue(request, () => undefined);
    const downloads = [1, 2, 3, 4].map(fileId => queue.cache(fileId, 18).catch(() => undefined));
    for (let fileId = 20; fileId <= 30; fileId += 1) downloads.push(queue.cache(fileId, 19).catch(() => undefined));
    downloads.push(queue.cache(40, 24).catch(() => undefined));
    try {
      expect(request).toHaveBeenCalledTimes(12);
      expect(request.mock.calls.map(([value]) => value.file_id)).toEqual([1, 2, 3, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
      queue.handleFile(20, true, false, 1024);
      expect(request.mock.calls.at(-1)?.[0].file_id).toBe(40);
      expect(request).toHaveBeenCalledTimes(13);
    } finally {
      queue.reset();
      await Promise.all(downloads);
    }
  });

  it("releases automatic previews on unmount while keeping an explicit download", async () => {
    const request = vi.fn(async (_request: TdObject) => ({ "@type": "file", local: { is_downloading_active: true } }));
    const queue = new FileDownloadQueue(request, () => undefined);
    const downloads = [queue.cache(20, 19), queue.cache(40, 24)].map(download => download.catch(() => undefined));
    try {
      expect(queue.release(20)).toBe(true);
      expect(queue.get(20)).toBeUndefined();
      expect(queue.release(40)).toBe(false);
      expect(queue.get(40)).toBeDefined();
    } finally {
      queue.reset();
      await Promise.all(downloads);
    }
  });

  it("promotes previews without duplicating ownership and refills freed background capacity", async () => {
    const request = vi.fn(async (_request: TdObject) => ({ "@type": "file", local: { is_downloading_active: true } }));
    const queue = new FileDownloadQueue(request, () => undefined);
    const downloads = [1, 2, 3, 4, 5].map(fileId => queue.cache(fileId, 18).catch(() => undefined));
    const queued = queue.get(4);
    try {
      expect(queue.cache(4, 19)).toBe(queued);
      expect(request.mock.calls.at(-1)?.[0].file_id).toBe(4);
      const active = queue.get(1);
      expect(queue.cache(1, 19)).toBe(active);
      expect(request.mock.calls.map(([value]) => value.file_id)).toEqual([1, 2, 3, 4, 1, 5]);
    } finally {
      queue.reset();
      await Promise.all(downloads);
    }
  });

  it("clears native full-download intent when TDLib rejects the request", async () => {
    const stop = vi.fn();
    const queue = new FileDownloadQueue(async () => { throw new Error("network unavailable"); }, () => undefined, stop);
    await expect(queue.cache(8)).rejects.toThrow("network unavailable");
    expect(stop).toHaveBeenCalledExactlyOnceWith(8);
    expect(queue.get(8)).toBeUndefined();
  });
  it("keeps a full download pending while a stream temporarily owns the TDLib cursor", async () => {
    const queue = new FileDownloadQueue(async () => ({ "@type": "file", id: 8,
      notgram_download_requested: true, local: { is_downloading_active: false, is_downloading_completed: false } }), () => undefined);
    const download = queue.cache(8);
    const result = download.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.get(8)).toBe(download);
    queue.handleFile(8, true, false, 1024);
    await expect(result).resolves.toBeUndefined();
  });
  it("does not publish a late download response after a completion update", async () => {
    let respond!: (file: TdObject) => void;
    const onFile = vi.fn();
    const queue = new FileDownloadQueue(
      () => new Promise<TdObject>((resolve) => { respond = resolve; }),
      onFile,
    );
    const download = queue.cache(8);
    queue.handleFile(8, true, false, 1_024);
    await download;

    respond({ "@type": "file", id: 8, local: { is_downloading_active: true, is_downloading_completed: false } });
    await Promise.resolve();

    expect(onFile).not.toHaveBeenCalled();
    expect(queue.get(8)).toBeUndefined();
  });

  it("does not let a cancelled request's late failure reject its retry", async () => {
    let fail!: (error: Error) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<TdObject>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ "@type": "file", id: 8, local: { is_downloading_active: true } });
    const queue = new FileDownloadQueue(request, () => undefined);
    const cancelled = queue.cache(8).catch(() => undefined);
    queue.cancel(8);
    await cancelled;
    const retry = queue.cache(8);
    const result = retry.catch((error: unknown) => error);
    await Promise.resolve();

    fail(new Error("old request failed"));
    await Promise.resolve();
    expect(queue.get(8)).toBe(retry);
    queue.handleFile(8, true, false, 1_024);
    await expect(result).resolves.toBeUndefined();
  });

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

  it("settles a queued entry when TDLib reports completion first", async () => {
    const request = vi.fn((_request: TdObject) => new Promise<TdObject>(() => undefined));
    const queue = new FileDownloadQueue(request, () => undefined);
    for (let fileId = 1; fileId <= 3; fileId += 1) void queue.cache(fileId, 12);
    const queued = queue.cache(4, 12);

    queue.handleFile(4, true, false, 1_024);

    await expect(queued).resolves.toBeUndefined();
    expect(queue.get(4)).toBeUndefined();
    expect(request.mock.calls.some(([value]) => value.file_id === 4)).toBe(false);
  });

  it("suppresses automatic retries after an explicit cancel until allowed", async () => {
    const request = vi.fn((_request: TdObject) => new Promise<TdObject>(() => undefined));
    const queue = new FileDownloadQueue(request, () => undefined);
    queue.suppress(9);
    await expect(queue.cache(9, 18)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    queue.allow(9);
    void queue.cache(9, 18);
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ file_id: 9 }));
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
