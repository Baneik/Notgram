import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMediaPreviewCache, cloneMediaPreview, forgetMediaPreview, hasMediaPreview, mediaPreviewGeneration, rememberMediaPreview } from "./mediaPreviewCache";

class ImageSource {
  complete = true;
  naturalWidth = 64;
  naturalHeight = 64;
}
class Canvas {
  width = 0;
  height = 0;
  context = { drawImage: vi.fn() };
  getContext() { return this.context; }
  cloneNode() { return Object.assign(new Canvas(), { width: this.width, height: this.height }); }
}
const image = (width = 64, height = width) => Object.assign(new ImageSource(), {
  naturalWidth: width, naturalHeight: height,
}) as unknown as HTMLImageElement;
const remember = (source: string, element = image()) => rememberMediaPreview(source, element, mediaPreviewGeneration());

beforeEach(() => {
  vi.stubGlobal("HTMLImageElement", ImageSource);
  vi.stubGlobal("HTMLCanvasElement", Canvas);
  vi.stubGlobal("SVGSVGElement", class {});
  vi.stubGlobal("document", { createElement: () => new Canvas() });
});
afterEach(() => { clearMediaPreviewCache(); vi.unstubAllGlobals(); });

describe("media preview cache", () => {
  it("copies usable pixels into independent bounded display surfaces", () => {
    remember("sticker", image(2048, 1024));
    const first = cloneMediaPreview("sticker") as unknown as Canvas;
    const second = cloneMediaPreview("sticker") as unknown as Canvas;
    expect([first.width, first.height]).toEqual([384, 192]);
    expect(first).not.toBe(second);
    expect(first.context.drawImage).toHaveBeenCalledOnce();
    expect(first.context.drawImage.mock.calls[0][0]).toBe(second.context.drawImage.mock.calls[0][0]);
  });

  it("does not cache incomplete or empty images", () => {
    remember("empty", image(0));
    const pending = image();
    Object.assign(pending, { complete: false });
    remember("pending", pending);
    expect(hasMediaPreview("empty")).toBe(false);
    expect(hasMediaPreview("pending")).toBe(false);
  });

  it("retains only 256 least recently used previews", () => {
    for (let index = 0; index < 256; index++) remember(String(index));
    cloneMediaPreview("0");
    remember("256");
    expect(hasMediaPreview("0")).toBe(true);
    expect(hasMediaPreview("1")).toBe(false);
    expect(hasMediaPreview("256")).toBe(true);
  });

  it("enforces the pixel memory budget independently of the entry count", () => {
    for (let index = 0; index < 50; index++) remember(String(index), image(512));
    expect(hasMediaPreview("0")).toBe(false);
    expect(hasMediaPreview("49")).toBe(true);
    const survivors = Array.from({ length: 50 }, (_, index) => String(index)).filter(hasMediaPreview);
    expect(survivors.length * 384 * 384 * 4).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  it("rejects late ready callbacks after an account or cache reset", () => {
    const previousGeneration = mediaPreviewGeneration();
    remember("old");
    clearMediaPreviewCache();
    rememberMediaPreview("late", image(), previousGeneration);
    expect(hasMediaPreview("old")).toBe(false);
    expect(hasMediaPreview("late")).toBe(false);
    remember("current");
    expect(hasMediaPreview("current")).toBe(true);
  });

  it("invalidates only the failed source and allows a recovered frame", () => {
    remember("failed");
    remember("unrelated");
    forgetMediaPreview("failed");
    expect(cloneMediaPreview("failed")).toBeUndefined();
    expect(hasMediaPreview("unrelated")).toBe(true);
    remember("failed", image(128));
    expect((cloneMediaPreview("failed") as HTMLCanvasElement).width).toBe(128);
  });

  it("keeps the first usable frame without repeatedly copying a live resource", () => {
    remember("sticker", image(64));
    remember("sticker", image(128));
    expect((cloneMediaPreview("sticker") as HTMLCanvasElement).width).toBe(64);
  });

  it("can retain the final animation frame without accumulating the replaced bytes", () => {
    for (let index = 0; index < 100; index++) {
      rememberMediaPreview("sticker", image(384), mediaPreviewGeneration(), { replace: true });
    }
    expect((cloneMediaPreview("sticker") as HTMLCanvasElement).width).toBe(384);
    const owner = mediaPreviewGeneration();
    clearMediaPreviewCache();
    rememberMediaPreview("sticker", image(), owner, { replace: true });
    expect(hasMediaPreview("sticker")).toBe(false);
  });
});
