import { afterEach, describe, expect, it, vi } from "vitest";
import { gzip } from "pako";
import { clearTgsAnimationCache, loadTgsAnimationData } from "./tgsAnimationCache";

const data = { v: "5.7", layers: [{ nm: "original" }] };
const response = () => new Response(new Uint8Array(gzip(JSON.stringify(data))));

afterEach(() => {
  clearTgsAnimationCache();
  vi.unstubAllGlobals();
});

describe("TGS animation cache", () => {
  it("fetches and decodes once for concurrent players and remounts, with isolated mutable data", async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const [first, second] = await Promise.all([loadTgsAnimationData("sticker.tgs"), loadTgsAnimationData("sticker.tgs")]);
    (first.layers as typeof data.layers)[0].nm = "changed by Lottie";
    expect(second).toEqual(data);
    expect(await loadTgsAnimationData("sticker.tgs")).toEqual(data);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries failures and reloads after cache cleanup", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    await expect(loadTgsAnimationData("sticker.tgs")).rejects.toThrow("404");
    await expect(loadTgsAnimationData("sticker.tgs")).resolves.toEqual(data);
    clearTgsAnimationCache();
    await loadTgsAnimationData("sticker.tgs");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("evicts least recently used animations", async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    for (let index = 0; index < 128; index += 1) await loadTgsAnimationData(`${index}.tgs`);
    await loadTgsAnimationData("0.tgs");
    await loadTgsAnimationData("128.tgs");
    await loadTgsAnimationData("0.tgs");
    expect(fetch).toHaveBeenCalledTimes(129);
    await loadTgsAnimationData("1.tgs");
    expect(fetch).toHaveBeenCalledTimes(130);
  });

  it("discards a late account response even when fetch ignores cancellation", async () => {
    let complete!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
      .mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const oldRead = loadTgsAnimationData("sticker.tgs");
    const rejected = expect(oldRead).rejects.toMatchObject({ name: "AbortError" });
    clearTgsAnimationCache();
    await expect(loadTgsAnimationData("sticker.tgs")).resolves.toEqual(data);
    complete(response());
    await rejected;
    await expect(loadTgsAnimationData("sticker.tgs")).resolves.toEqual(data);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
