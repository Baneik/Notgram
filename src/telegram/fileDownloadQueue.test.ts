import { describe, expect, it, vi } from "vitest";
import { FileDownloadQueue } from "./fileDownloadQueue";
import type { TdObject } from "./tdlibMapper";

describe("FileDownloadQueue cancellation", () => {
  it("removes a queued download before TDLib receives it", async () => {
    const request = vi.fn((_request: TdObject) => new Promise<TdObject>(() => undefined));
    const queue = new FileDownloadQueue(request, () => undefined);
    const downloads = [1, 2, 3, 4, 5].map((fileId) => queue.cache(fileId));
    const cancelled = downloads[4].catch((error: unknown) => error);

    expect(request).toHaveBeenCalledTimes(4);
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
});
