import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canWarmViewerImage, clearViewerImages, hasViewerImage, retainViewerImage } from "./viewerImages";

vi.mock("../utils/performanceMonitor", () => ({ logPerformance: vi.fn() }));

class TestImage {
  static created: TestImage[] = [];
  src = "";
  complete = true;
  naturalWidth = 1000;
  naturalHeight = 1000;
  decoding = "";
  fetchPriority = "";
  onload?: () => void;
  onerror?: () => void;
  decode = vi.fn(async (): Promise<void> => undefined);
  remove = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
  constructor() { TestImage.created.push(this); }
}

beforeEach(() => { TestImage.created = []; vi.stubGlobal("Image", TestImage); });
afterEach(() => { clearViewerImages(); vi.unstubAllGlobals(); });
const loaded = async (source: string, width = 1000, height = width) => {
  const retained = retainViewerImage(source);
  const image = retained.image as unknown as TestImage;
  image.naturalWidth = width; image.naturalHeight = height;
  image.onload?.();
  await retained.promise;
  return retained;
};

describe("viewer decoded image ownership", () => {
  it("reuses the decoded node without a new request or decode", async () => {
    const first = await loaded("photo");
    first.release(); await Promise.resolve();
    const second = retainViewerImage("photo");
    expect(second.ready).toBe(true);
    expect(await second.promise).toBe(first.image);
    expect(TestImage.created).toHaveLength(1);
    expect(TestImage.created[0].decode).toHaveBeenCalledOnce();
    second.release();
  });

  it("evicts idle nodes at the entry limit and keeps the visible original", async () => {
    const active = await loaded("active");
    for (const source of ["one", "two", "three", "four"]) {
      const neighbor = await loaded(source); neighbor.release(); await Promise.resolve();
    }
    expect(hasViewerImage("active")).toBe(true);
    expect(hasViewerImage("one")).toBe(false);
    expect(hasViewerImage("four")).toBe(true);
    active.release();
  });

  it("counts decoded pixels and releases an oversized idle original", async () => {
    const huge = await loaded("huge", 9000);
    expect(hasViewerImage("huge")).toBe(true);
    huge.release(); await Promise.resolve();
    expect(hasViewerImage("huge")).toBe(false);
    expect(TestImage.created[0].src).toBe("");
  });

  it("does not warm neighbors that cannot fit alongside the live original", async () => {
    const active = await loaded("large", 8000, 5333);
    expect(canWarmViewerImage(3931, 2894)).toBe(false);
    expect(canWarmViewerImage(1000, 1000)).toBe(true);
    expect(canWarmViewerImage()).toBe(false);
    active.release();
  });

  it("cancels ownerless pending work but shares a StrictMode reacquisition", async () => {
    const first = retainViewerImage("pending");
    first.release();
    const second = retainViewerImage("pending");
    await Promise.resolve();
    expect(TestImage.created[0].src).toBe("pending");
    const rejected = expect(second.promise).rejects.toThrow("released");
    second.release(); await rejected;
    expect(TestImage.created[0].src).toBe("");
  });

  it("rejects late decode results after cleanup", async () => {
    let finish!: () => void;
    const pending = retainViewerImage("old-account");
    TestImage.created[0].decode.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    TestImage.created[0].onload?.();
    const rejected = expect(pending.promise).rejects.toThrow("released");
    clearViewerImages(); finish(); await rejected;
    expect(hasViewerImage("old-account")).toBe(false);
    pending.release();
  });

  it("allows a new request after a load failure", async () => {
    const failed = retainViewerImage("retry");
    const rejected = expect(failed.promise).rejects.toThrow("unavailable");
    TestImage.created[0].onerror?.(); await rejected; failed.release();
    const retry = await loaded("retry");
    expect(TestImage.created).toHaveLength(2);
    retry.release();
  });
});
