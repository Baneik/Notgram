import { expect, test, type Page } from "@playwright/test";
import type { PhotoMessage } from "../../src/utils/mediaViewerModel";
import type { MediaViewerWindowDescriptor, MediaViewerWindowMessage } from "../../src/media/mediaViewerWindowBridge";

type FixtureWindow = Window & { viewerFixture: {
  descriptor: MediaViewerWindowDescriptor;
  events: MediaViewerWindowMessage[];
  channel: BroadcastChannel;
  failActions: boolean;
} };

async function openFixture(page: Page, previewOnly = false) {
  await page.route("**/viewer-fixture.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer fixture</title>" }));
  await page.goto("/viewer-fixture.html");
  const images = await page.evaluate(() => {
    const render = (width: number, height: number) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#3f7969"; context.fillRect(0, 0, width, height);
      context.fillStyle = "#e2d5a4"; context.fillRect(width / 4, height / 4, width / 2, height / 2);
      return canvas.toDataURL("image/jpeg").split(",")[1]!;
    };
    return { original: render(3200, 2000), thumbnail: render(160, 100) };
  });
  const requests: string[] = [];
  await page.route("**/viewer-image/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname.includes("delayed")) await new Promise(resolve => setTimeout(resolve, 600));
    if (pathname.includes("failed")) { await route.abort(); return; }
    await route.fulfill({ contentType: "image/jpeg", body: Buffer.from(pathname.includes("thumb") ? images.thumbnail : images.original, "base64") });
  });
  const messages: PhotoMessage[] = Array.from({ length: 15 }, (_, index) => ({
    id: `photo-${index}`, chatId: "viewer-fixture", senderId: "fixture", outgoing: false, sentAt: "2026-09-14T00:00:00Z", delivery: "read",
    content: { kind: "media", mediaType: "photo", fileName: `image-${index}.jpg`, sizeLabel: "2 MB", width: 3200, height: 2000,
      localPath: previewOnly && index === 6 ? undefined : `/viewer-image/original-${index}.jpg`,
      thumbnailPath: `/viewer-image/thumb-${index}.jpg`,
      isDownloaded: !(previewOnly && index === 6), dataCenterId: 5, remoteId: "AwADBAADewAPKgQ",
      caption: index === 6 ? "Viewer caption" : `Caption ${index}` },
  }));
  const descriptor: MediaViewerWindowDescriptor = { id: "fixture", messages, activeMessageId: "photo-6", colorTheme: "dark" };
  await page.addInitScript(descriptor => {
    const channel = new BroadcastChannel("notgram-media-viewer-window-v1");
    const fixture = { descriptor, channel, events: [] as MediaViewerWindowMessage[], failActions: false };
    (window as unknown as FixtureWindow).viewerFixture = fixture;
    channel.onmessage = (event: MessageEvent<MediaViewerWindowMessage>) => {
      fixture.events.push(event.data);
      if (event.data.type === "ready") channel.postMessage({ type: "init", id: "fixture", descriptor: fixture.descriptor });
      if ((event.data.type === "save" || event.data.type === "download") && event.data.requestId !== undefined) {
        channel.postMessage({ type: "action-result", id: "fixture", requestId: event.data.requestId, failed: fixture.failActions });
      }
    };
  }, descriptor);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/windows/media-viewer-window.html?id=fixture");
  await expect(page.locator('.media-viewer-image[data-image-state="ready"]')).toHaveCount(1);
  await expect(page.locator(".media-viewer-thumbnails button")).toHaveCount(9);
  return { requests };
}

async function replaceOriginal(page: Page, source: string) {
  await page.evaluate(source => {
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    fixture.descriptor.messages = fixture.descriptor.messages.map(message => message.id === "photo-6"
      ? { ...message, content: { ...message.content, localPath: source, isDownloaded: true } } : message);
    fixture.channel.postMessage({ type: "sync", id: "fixture", messages: fixture.descriptor.messages, colorTheme: "dark" });
  }, source);
}

test("original upgrades retain painted pixels and the exact viewport during loading and errors", async ({ page }) => {
  await openFixture(page, true);
  await page.keyboard.press("+");
  const surface = page.locator(".media-viewer-surface");
  const viewport = page.locator(".media-viewer-viewport");
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40, { steps: 12 }); await page.mouse.up();
  const before = await surface.evaluate(element => (element as HTMLElement).style.transform);
  expect(before).toContain("scale(1.5)");
  await page.evaluate(() => {
    const state = { blankFrames: 0, retainedFrames: 0, running: true };
    (window as unknown as { upgradeSampling: typeof state }).upgradeSampling = state;
    const sample = () => {
      const images = [...document.querySelectorAll<HTMLImageElement>(".media-viewer-image")];
      if (!images.some(image => image.complete && image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) > 0)) state.blankFrames++;
      if (images.some(image => image.dataset.imageRetained === "true")) state.retainedFrames++;
      if (state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await replaceOriginal(page, "/viewer-image/delayed-original.jpg");
  await expect(page.locator('.media-viewer-image[data-image-retained="true"]')).toHaveCount(1);
  await expect(page.locator('.media-viewer-image[src="/viewer-image/delayed-original.jpg"][data-image-state="ready"]')).toHaveCount(1);
  const sampling = await page.evaluate(() => {
    const state = (window as unknown as { upgradeSampling: { blankFrames: number; retainedFrames: number; running: boolean } }).upgradeSampling;
    state.running = false; return state;
  });
  expect(sampling.blankFrames).toBe(0);
  expect(sampling.retainedFrames).toBeGreaterThan(10);
  expect(await surface.evaluate(element => (element as HTMLElement).style.transform)).toBe(before);
  await replaceOriginal(page, "/viewer-image/failed-original.jpg");
  await expect(page.locator('.media-viewer-image[src="/viewer-image/thumb-6.jpg"][data-image-state="ready"]')).toHaveCount(1);
  expect(await surface.evaluate(element => (element as HTMLElement).style.transform)).toBe(before);
});

test("thumbnails stay small and selected images remain visible at every viewport", async ({ page }) => {
  const { requests } = await openFixture(page);
  await expect.poll(() => requests.filter(url => url.includes("original")).length).toBe(3);
  expect(requests.filter(url => url.includes("original")).sort()).toEqual([
    "/viewer-image/original-5.jpg", "/viewer-image/original-6.jpg", "/viewer-image/original-7.jpg",
  ]);
  await expect.poll(() => page.locator(".media-viewer-thumbnails img").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 160))).toBe(true);
  for (const width of [1280, 900, 700, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => {
      const strip = document.querySelector(".media-viewer-thumbnails")!.getBoundingClientRect();
      const selected = document.querySelector(".media-viewer-thumbnails .is-active")!.getBoundingClientRect();
      const info = document.querySelector(".media-viewer-details")!.getBoundingClientRect();
      return strip.left >= 0 && strip.right <= innerWidth && selected.left >= strip.left && selected.right <= strip.right &&
        !(info.left < strip.right && info.right > strip.left && info.top < strip.bottom && info.bottom > strip.top);
    })).toBe(true);
  }
  await expect(page.locator(".media-viewer-thumbnails button")).toHaveCount(3);
});

test("wheel intent and duplicate initialization preserve the user's current image", async ({ page }) => {
  await openFixture(page);
  await page.locator(".media-viewer-viewport").hover();
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); }
  await expect(page.locator(".media-viewer")).toHaveAttribute("aria-label", "图片查看器：image-6.jpg");
  await page.mouse.wheel(0, 120);
  await expect(page.locator(".media-viewer")).toHaveAttribute("aria-label", "图片查看器：image-7.jpg");
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    fixture.channel.postMessage({ type: "init", id: "fixture", descriptor: fixture.descriptor });
  });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".media-viewer")).toHaveAttribute("aria-label", "图片查看器：image-8.jpg");
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).viewerFixture.events.filter(event => event.type === "active").map(event => event.messageId))).toContain("photo-8");
});

test("storage DC comes from the image and failed saves are visible in the viewer", async ({ page }) => {
  await openFixture(page);
  await expect(page.locator(".media-viewer-details")).toContainText("数据中心：DC4");
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    fixture.failActions = true;
    fixture.descriptor.messages = fixture.descriptor.messages.map(message => ({ ...message, content: { ...message.content, remoteId: "unsupported", dataCenterId: 5 } }));
    fixture.channel.postMessage({ type: "sync", id: "fixture", messages: fixture.descriptor.messages, colorTheme: "dark" });
  });
  await expect(page.locator(".media-viewer-details")).toContainText("数据中心：未知");
  await page.getByRole("button", { name: "下载图片", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("文件下载失败");
  await expect(page.getByRole("button", { name: "下载图片", exact: true })).toBeEnabled();
});

test("drag bursts write once per frame and zooming keeps the pointed image detail stable", async ({ page }) => {
  await openFixture(page);
  const viewport = page.locator(".media-viewer-viewport");
  const surface = page.locator(".media-viewer-surface");
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(Math.round(bounds.x + bounds.width / 2 + 70), Math.round(bounds.y + bounds.height / 2 + 40));
  const before = await surface.boundingBox();
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -240); await page.keyboard.up("Control");
  await expect(surface).toHaveAttribute("style", /scale\(1\.5\)/);
  const after = (await surface.boundingBox())!;
  const point = { x: Math.round(bounds.x + bounds.width / 2 + 70), y: Math.round(bounds.y + bounds.height / 2 + 40) };
  expect((point.x - after.x) / after.width).toBeCloseTo((point.x - before!.x) / before!.width, 4);
  expect((point.y - after.y) / after.height).toBeCloseTo((point.y - before!.y) / before!.height, 4);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  const writes = await page.evaluate(async () => {
    const viewport = document.querySelector(".media-viewer-viewport")!;
    const surface = document.querySelector(".media-viewer-surface")!;
    const bounds = viewport.getBoundingClientRect();
    let writes = 0;
    const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(surface, { attributes: true, attributeFilter: ["style"] });
    for (let index = 0; index < 200; index++) viewport.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 1, clientX: bounds.x + bounds.width / 2 + index, clientY: bounds.y + bounds.height / 2 + index,
    }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect(); return writes;
  });
  await page.mouse.up();
  expect(writes).toBeGreaterThan(0);
  expect(writes).toBeLessThanOrEqual(2);
  await page.locator(".media-viewer-image").dblclick();
  await expect(surface).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/);
});

test("late decodes cannot replace a newly selected image and long captions expand without hiding controls", async ({ page }) => {
  await openFixture(page, true);
  await replaceOriginal(page, "/viewer-image/delayed-stale.jpg");
  await expect(page.locator('.media-viewer-image[data-image-retained="true"]')).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.media-viewer-image[src="/viewer-image/original-7.jpg"][data-image-state="ready"]')).toHaveCount(1);
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    fixture.descriptor.messages = fixture.descriptor.messages.map(message => message.id === "photo-7" ? {
      ...message, content: { ...message.content, caption: Array.from({ length: 12 }, (_, index) => `Caption paragraph ${index + 1}: long image descriptions remain readable.`).join("\n") },
    } : message);
    fixture.channel.postMessage({ type: "sync", id: "fixture", messages: fixture.descriptor.messages, colorTheme: "dark" });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const caption = page.locator(".media-viewer-caption");
  const collapsed = (await caption.boundingBox())!.height;
  await page.getByRole("button", { name: "展开说明" }).click();
  expect((await caption.boundingBox())!.height).toBeGreaterThan(collapsed);
  await page.getByRole("button", { name: "收起说明" }).click();
  await expect.poll(async () => (await caption.boundingBox())!.height).toBe(collapsed);
  await expect(page.getByRole("button", { name: "下载图片", exact: true })).toBeVisible();
  // The delayed request has now either decoded or been cancelled by navigation.
  await page.waitForTimeout(650);
  await expect(page.locator('.media-viewer-image[src="/viewer-image/original-7.jpg"][data-image-state="ready"]')).toHaveCount(1);
  await expect(page.locator('.media-viewer-image[src="/viewer-image/delayed-stale.jpg"]')).toHaveCount(0);
});
