import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLocalAssetCache, getCachedLocalAsset, retainLocalAsset } from "./localAssetCache";

afterEach(() => {
  clearLocalAssetCache();
  vi.unstubAllGlobals();
});

describe("local asset cache", () => {
  it("downloads a native asset once and reuses its blob URL", async () => {
    const fetch = vi.fn(async () => new Response("sticker"));
    const createObjectURL = vi.fn(() => "blob:sticker");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const firstRead = retainLocalAsset("asset://sticker.webp");
    const secondRead = retainLocalAsset("asset://sticker.webp");
    const [first, second] = await Promise.all([firstRead.promise, secondRead.promise]);
    expect(first).toBe("blob:sticker");
    expect(second).toBe(first);
    const thirdRead = retainLocalAsset("asset://sticker.webp");
    expect(await thirdRead.promise).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    firstRead.release();
    secondRead.release();
    thirdRead.release();
  });

  it("drops failed requests so a later render can retry", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("sticker"));
    const createObjectURL = vi.fn(() => "blob:sticker");
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });

    await expect(retainLocalAsset("asset://sticker.webp").promise).rejects.toThrow("404");
    await expect(retainLocalAsset("asset://sticker.webp").promise).resolves.toBe("blob:sticker");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels pending account reads without publishing or leaking a late blob", async () => {
    let complete!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const createObjectURL = vi.fn(() => "blob:old-account");
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const pending = retainLocalAsset("asset://sticker.webp");
    const result = expect(pending.promise).rejects.toThrow("cleared");
    clearLocalAssetCache();
    complete(new Response("late"));
    await result;
    expect(getCachedLocalAsset("asset://sticker.webp")).toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]).toEqual(["asset://sticker.webp", { signal: expect.objectContaining({ aborted: true }) }]);
    pending.release();
  });

  it("evicts idle entries while preserving URLs that a mounted video still uses", async () => {
    let nextUrl = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sticker")));
    vi.stubGlobal("URL", { createObjectURL: () => `blob:${nextUrl++}`, revokeObjectURL });
    const live = retainLocalAsset("live.webm");
    await live.promise;
    for (let index = 0; index < 513; index += 1) {
      const idle = retainLocalAsset(`${index}.webp`);
      await idle.promise;
      idle.release();
    }
    expect(getCachedLocalAsset("live.webm")).toBe("blob:0");
    expect(getCachedLocalAsset("0.webp")).toBeUndefined();
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:0");
    live.release();
    live.release();
    clearLocalAssetCache();
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === "blob:0")).toHaveLength(1);
  });

  it("limits retained bytes even before the entry limit and supports immediate cached reads", async () => {
    let nextUrl = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, headers: new Headers(), blob: async () => ({ size: 16 * 1024 * 1024 }),
    })));
    vi.stubGlobal("URL", { createObjectURL: () => `blob:${nextUrl++}`, revokeObjectURL: vi.fn() });
    for (let index = 0; index < 5; index += 1) {
      const retained = retainLocalAsset(String(index));
      await retained.promise;
      retained.release();
    }
    expect(getCachedLocalAsset("0")).toBeUndefined();
    expect(getCachedLocalAsset("4")).toBe("blob:4");
  });

  it("rejects large media before buffering so the caller can fall back to ranged playback", async () => {
    const blob = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, headers: new Headers({ "content-length": String(17 * 1024 * 1024) }),
      blob, body: { cancel },
    })));
    const retained = retainLocalAsset("large.webm");
    await expect(retained.promise).rejects.toThrow("ranged playback");
    expect(blob).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    retained.release();
  });
});
