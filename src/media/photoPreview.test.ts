import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPhotoPreviewCache, getPhotoPreview, invalidatePhotoPreview, photoPreviewSize, retainPhotoPreview } from "./photoPreview";

vi.mock("../utils/performanceMonitor", () => ({ logPerformance: vi.fn() }));
const source = (id: string) => `http://notgram-asset.localhost/${id}.png`;
const size = photoPreviewSize(390, 260, false);
const response = () => new Response(new Blob(["preview"]), { headers: {
  "X-Preview-Width": "390", "X-Preview-Height": "260", "X-Source-Width": "6000", "X-Source-Height": "4000",
} });
beforeEach(() => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});
afterEach(async () => {
  clearPhotoPreviewCache();
  await vi.waitFor(() => undefined);
  vi.unstubAllGlobals();
});

describe("conversation photo previews", () => {
  it("bounds display pixels without changing the crop policy", () => {
    expect(photoPreviewSize(390, 260, false)).toEqual({ width: 390, height: 260, cover: false });
    expect(photoPreviewSize(6000, 4000, true)).toEqual({ width: 1600, height: 1067, cover: true });
  });

  it("shares the native prepared response and retains it across remounts", async () => {
    const fetch = vi.fn(async (_url: string) => response());
    vi.stubGlobal("fetch", fetch);
    const first = retainPhotoPreview(source("photo"), size);
    const second = retainPhotoPreview(source("photo"), size);
    const [a, b] = await Promise.all([first.promise, second.promise]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ sourceWidth: 6000, sourceHeight: 4000, width: 390, height: 260 });
    first.release(); second.release();
    const remount = retainPhotoPreview(source("photo"), size);
    expect(await remount.promise).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${source("photo")}?width=390&height=260&fit=contain`);
    remount.release();
  });

  it("limits simultaneous loads and cancels queued virtual rows", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn((_url: string) => new Promise<Response>(resolve => pending.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    const first = retainPhotoPreview(source("first"), size);
    const second = retainPhotoPreview(source("second"), size);
    const removed = retainPhotoPreview(source("removed"), size);
    const kept = retainPhotoPreview(source("kept"), size);
    const cancelled = expect(removed.promise).rejects.toThrow("released");
    removed.release();
    expect(fetch).toHaveBeenCalledTimes(2);
    pending[0](response()); pending[1](response());
    await Promise.all([first.promise, second.promise, cancelled]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][0]).toContain("kept.png");
    pending[2](response()); await kept.promise;
    first.release(); second.release(); kept.release();
  });

  it("rejects late account results without creating a blob URL", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
    const pending = retainPhotoPreview(source("old"), size);
    const rejected = expect(pending.promise).rejects.toThrow("released");
    clearPhotoPreviewCache();
    complete(response());
    await rejected;
    await vi.waitFor(() => expect(getPhotoPreview(source("old"), size)).toBeUndefined());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    pending.release();
  });

  it("evicts idle display pixels while preserving a live preview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const live = retainPhotoPreview(source("live"), size);
    await live.promise;
    for (let index = 0; index < 140; index++) {
      const idle = retainPhotoPreview(source(String(index)), size);
      await idle.promise; idle.release();
    }
    expect(getPhotoPreview(source("live"), size)).toBeDefined();
    expect(getPhotoPreview(source("0"), size)).toBeUndefined();
    expect(getPhotoPreview(source("139"), size)).toBeDefined();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    live.release();
  });

  it("rejects malformed native metadata and retries an invalidated preview", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("missing dimensions")).mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const failed = retainPhotoPreview(source("invalid"), size);
    await expect(failed.promise).rejects.toThrow("dimensions");
    failed.release();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    const recovered = retainPhotoPreview(source("invalid"), size);
    await recovered.promise;
    invalidatePhotoPreview(source("invalid"), size);
    expect(getPhotoPreview(source("invalid"), size)).toBeUndefined();
    recovered.release();
    const retry = retainPhotoPreview(source("invalid"), size);
    await retry.promise;
    expect(fetch).toHaveBeenCalledTimes(3);
    retry.release();
  });
});
