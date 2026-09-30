import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
const prepare = async (page: Page, album = false) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  return page.evaluate(async ({ album }) => {
    const canvas = document.createElement("canvas"); canvas.width = 2400; canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let random = 17;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      random = (Math.imul(random, 1664525) + 1013904223) | 0;
      // The center has fine lines; the rest keeps the actual PNG over 10 MiB.
      const fine = x > 950 && x < 1450 && y > 600 && y < 1000;
      pixels.data[offset] = fine ? (x % 2 ? 255 : 0) : random & 255;
      pixels.data[offset + 1] = fine ? pixels.data[offset] : (random >>> 8) & 255;
      pixels.data[offset + 2] = fine ? pixels.data[offset] : (random >>> 16) & 255;
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
    const source = URL.createObjectURL(blob);
    const sources = album ? Array.from({ length: 4 }, () => URL.createObjectURL(blob)) : [source];
    const reads: string[] = [];
    const fetch = window.fetch;
    window.fetch = (...args) => {
      if (sources.includes(String(args[0]))) reads.push(String(args[0]));
      return fetch(...args);
    };
    Object.assign(window, { photoPreviewFixture: { source, reads } });
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    const state = telegramStore.getState();
    const seed = state.messages.get("chat-product")!.at(-1)!;
    const rows: Message[] = Array.from({ length: 80 }, (_, index) => ({
      ...seed, id: `preview-history-${index}`, renderKey: undefined, mediaAlbumId: undefined, replyTo: undefined,
      sentAt: new Date(Date.UTC(2027, 0, 1) + index * 1000).toISOString(),
      content: { kind: "text", text: `Preview history ${index}` },
    }));
    for (let index = 0; index < (album ? 4 : 1); index++) rows.push({
      ...seed, id: `preview-photo-${index}`, renderKey: undefined, replyTo: undefined,
      mediaAlbumId: album ? "preview-album" : undefined,
      sentAt: new Date(Date.UTC(2027, 0, 1) + (81 + index) * 1000).toISOString(),
      content: { kind: "media", mediaType: "photo", fileName: "fine-detail.png", localPath: sources[index],
        size: blob.size, sizeLabel: "12 MB", width: 2400, height: 1600, isDownloaded: true, canDownload: false },
    });
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", rows) });
    return { bytes: blob.size, source };
  }, { album });
};

for (const deviceScaleFactor of [1, 1.25, 2]) {
  test.describe(`conversation preview at ${deviceScaleFactor} DPI`, () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor });
    test("filters fine patterns at display resolution and keeps the viewer original", async ({ page }, testInfo) => {
      const fixture = await prepare(page);
      // A valid, genuinely large image exercises decoding, rather than padded bytes.
      expect(fixture.bytes).toBeGreaterThan(10 * 1024 * 1024);
      const photo = page.locator('[data-message-id="preview-photo-0"]');
      const image = photo.locator('img[data-photo-preview="true"]');
      await expect(image).toHaveAttribute("data-image-state", "ready");
      const quality = await image.evaluate(async element => {
        const img = element as HTMLImageElement;
        const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const context = canvas.getContext("2d")!; context.drawImage(img, 0, 0);
        const center = context.getImageData(Math.floor(canvas.width / 2) - 20, Math.floor(canvas.height / 2) - 20, 40, 40).data;
        const values = Array.from(center).filter((_, index) => index % 4 === 0);
        const bounds = img.getBoundingClientRect();
        return { width: img.naturalWidth, height: img.naturalHeight, expectedWidth: bounds.width * devicePixelRatio,
          min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
      });
      expect(Math.abs(quality.width - quality.expectedWidth)).toBeLessThanOrEqual(2);
      expect(quality.width).toBeLessThan(1000);
      expect(quality.max - quality.min).toBeLessThan(20);
      expect(quality.mean).toBeGreaterThan(115); expect(quality.mean).toBeLessThan(140);
      await photo.locator(".conversation-photo").screenshot({ path: testInfo.outputPath("preview.png") });
      if (deviceScaleFactor === 1) {
        await photo.locator(".conversation-photo").evaluate(async (element, source) => {
          const original = document.createElement("img"); original.id = "unfiltered-preview";
          original.src = source; original.style.cssText = "position:absolute;inset:0;opacity:1;z-index:10";
          element.append(original); await original.decode();
        }, fixture.source);
        await photo.locator(".conversation-photo").screenshot({ path: testInfo.outputPath("original-css-downscale.png") });
        await page.locator("#unfiltered-preview").evaluate(element => element.remove());
      }
      const opened = page.waitForEvent("popup");
      await photo.locator(".photo-open").click();
      const popup = await opened;
      const viewer = popup.locator('.media-viewer-image[data-image-state="ready"]');
      await expect(viewer).toHaveJSProperty("naturalWidth", 2400);
      await expect(viewer).toHaveAttribute("src", fixture.source);
      await popup.close();
    });
  });
}

test("album previews crop to the tile and reuse pixels after virtual unmount", async ({ page }, testInfo) => {
  const fixture = await prepare(page, true);
  const album = page.locator('[data-media-album-id="preview-album"]');
  await expect(album.locator('img[data-photo-preview="true"][data-image-state="ready"]')).toHaveCount(4);
  const sizes = await album.locator('img[data-photo-preview="true"]').evaluateAll(images => images.map(element => {
    const image = element as HTMLImageElement; const box = image.getBoundingClientRect();
    return { width: image.naturalWidth, height: image.naturalHeight, expectedWidth: box.width * devicePixelRatio, expectedHeight: box.height * devicePixelRatio };
  }));
  for (const size of sizes) {
    expect(Math.abs(size.width - size.expectedWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(size.height - size.expectedHeight)).toBeLessThanOrEqual(2);
  }
  await album.screenshot({ path: testInfo.outputPath("album.png") });
  const originalUrls = await album.locator('img[data-photo-preview="true"]').evaluateAll(images => images.map(image => (image as HTMLImageElement).src));
  // Mutating only render identity reliably exercises the same photo after a
  // true row unmount without depending on a particular virtual overscan range.
  const frames = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    const state = telegramStore.getState();
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map(message =>
      message.id.startsWith("preview-photo-") ? { ...message, renderKey: `remounted-${message.id}` } : message)) });
    const frames = [];
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const photos = [...document.querySelectorAll('[data-media-album-id="preview-album"] .conversation-photo')];
      frames.push(photos.length === 4 && photos.every(photo => Boolean(photo.querySelector(".cached-media-preview canvas")) ||
        [...photo.querySelectorAll<HTMLImageElement>("img")].some(image => image.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === "1")));
    }
    return frames;
  });
  expect(frames.every(Boolean), "Every remount frame must preserve all four pictures").toBe(true);
  await expect(album.locator('img[data-photo-preview="true"][data-image-state="ready"]')).toHaveCount(4);
  expect(await album.locator('img[data-photo-preview="true"]').evaluateAll(images => images.map(image => (image as HTMLImageElement).src))).toEqual(originalUrls);
  expect(originalUrls.every(url => url !== fixture.source)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { photoPreviewFixture: { reads: string[] } }).photoPreviewFixture.reads.length)).toBe(4);
  const listBounds = (await page.getByRole("log", { name: "消息列表" }).boundingBox())!;
  await page.mouse.move(listBounds.x + listBounds.width / 2, listBounds.y + listBounds.height / 2);
  await page.mouse.wheel(0, -10000);
  await expect(album).toHaveCount(0);
  await page.locator(".jump-to-latest").click();
  await expect(album.locator('img[data-photo-preview="true"][data-image-state="ready"]')).toHaveCount(4);
  expect(await album.locator('img[data-photo-preview="true"]').evaluateAll(images => images.map(image => (image as HTMLImageElement).src))).toEqual(originalUrls);
  expect(await page.evaluate(() => (window as unknown as { photoPreviewFixture: { reads: string[] } }).photoPreviewFixture.reads.length)).toBe(4);
});

test("photo previews follow app zoom and window resize at display resolution", async ({ page }) => {
  await prepare(page);
  const photo = page.locator('[data-message-id="preview-photo-0"]');
  const image = photo.locator('img[data-photo-preview="true"][data-image-state="ready"]');
  await expect(image).toBeVisible();
  for (const interfaceScale of [125, 100]) {
    await page.evaluate(async interfaceScale => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale });
    }, interfaceScale);
    await expect.poll(() => image.evaluate(element => {
      const image = element as HTMLImageElement; return Math.abs(image.naturalWidth - image.getBoundingClientRect().width * devicePixelRatio);
    })).toBeLessThanOrEqual(2);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => image.evaluate(element => {
    const image = element as HTMLImageElement; return Math.abs(image.naturalWidth - image.getBoundingClientRect().width * devicePixelRatio);
  })).toBeLessThanOrEqual(2);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
});
