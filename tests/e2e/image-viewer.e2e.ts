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

test("unthrottled wheel bursts and duplicate initialization preserve the current image", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const viewport = document.querySelector(".media-viewer-viewport")!;
    for (let i = 0; i < 3; i++) viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
  });
  await expect(page.locator(".media-viewer")).toHaveAttribute("aria-label", "图片查看器：image-9.jpg");
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    fixture.channel.postMessage({ type: "init", id: "fixture", descriptor: fixture.descriptor });
  });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".media-viewer")).toHaveAttribute("aria-label", "图片查看器：image-10.jpg");
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).viewerFixture.events.filter(event => event.type === "active").map(event => event.messageId))).toContain("photo-10");
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

test("late decodes cannot replace a newly selected image and captions clamp to five lines without scrollbars", async ({ page }) => {
  await openFixture(page, true);
  await replaceOriginal(page, "/viewer-image/delayed-stale.jpg");
  await expect(page.locator('.media-viewer-image[data-image-retained="true"]')).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.media-viewer-image[src="/viewer-image/original-7.jpg"][data-image-state="ready"]')).toHaveCount(1);
  const beforeCaption = await page.locator(".media-viewer-surface").boundingBox();
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    fixture.descriptor.messages = fixture.descriptor.messages.map(message => message.id === "photo-7" ? {
      ...message, content: { ...message.content, caption: Array.from({ length: 12 }, (_, index) => `Caption paragraph ${index + 1}: long image descriptions remain readable.`).join("\n") },
    } : message);
    fixture.channel.postMessage({ type: "sync", id: "fixture", messages: fixture.descriptor.messages, colorTheme: "dark" });
  });
  await expect(page.locator(".media-viewer-caption")).toContainText("Caption paragraph 12");
  expect(await page.locator(".media-viewer-surface").boundingBox()).toEqual(beforeCaption);
  const imageBounds = (await page.locator(".media-viewer-surface").boundingBox())!;
  const captionBounds = (await page.locator(".media-viewer-caption").boundingBox())!;
  expect(captionBounds.y).toBeLessThan(imageBounds.y + imageBounds.height);
  await page.setViewportSize({ width: 390, height: 844 });
  const caption = page.locator(".media-viewer-caption");
  await expect(caption).toHaveCSS("-webkit-line-clamp", "5");
  await expect(caption).toHaveCSS("overflow", "hidden");
  const metrics = await caption.evaluate(element => ({ height: element.clientHeight, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight), scrollHeight: element.scrollHeight }));
  expect(metrics.height).toBeLessThanOrEqual(Math.ceil(metrics.lineHeight * 5));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
  await expect(page.getByRole("button", { name: /展开说明|收起说明/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载图片", exact: true })).toBeVisible();
  // The delayed request has now either decoded or been cancelled by navigation.
  await page.waitForTimeout(650);
  await expect(page.locator('.media-viewer-image[src="/viewer-image/original-7.jpg"][data-image-state="ready"]')).toHaveCount(1);
  await expect(page.locator('.media-viewer-image[src="/viewer-image/delayed-stale.jpg"]')).toHaveCount(0);
});

test("image documents replace thumbnail dimensions with the decoded original size", async ({ page }) => {
  await openFixture(page, true);
  await page.evaluate(async () => {
    const mapperPath = "/src/telegram/tdlibMapper.ts";
    const { mapTdMessageContent } = await import(mapperPath);
    const fixture = (window as unknown as FixtureWindow).viewerFixture;
    const content = mapTdMessageContent({
      "@type": "messageDocument", caption: { text: "Image sent as a file" },
      document: {
        file_name: "document.jpg", mime_type: "image/jpeg",
        thumbnail: { width: 160, height: 100, file: { id: 2, local: { is_downloading_completed: true, path: "/viewer-image/thumb-document.jpg" } } },
        document: { id: 1, size: 2000000, local: { is_downloading_completed: true, path: "/viewer-image/delayed-document.jpg" }, remote: {} },
      },
    });
    fixture.descriptor.messages = fixture.descriptor.messages.map(message => message.id === "photo-6" ? { ...message, content } : message);
    fixture.channel.postMessage({ type: "sync", id: "fixture", messages: fixture.descriptor.messages, colorTheme: "dark" });
  });
  const original = page.locator('.media-viewer-image[src="/viewer-image/delayed-document.jpg"][data-image-state="ready"]');
  await expect(original).toHaveCount(1);
  await expect.poll(() => original.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(3200);
  await expect.poll(async () => (await original.boundingBox())!.width).toBeGreaterThan(800);
  await expect(page.locator(".media-viewer-details")).toContainText("3200 × 2000");
  await original.dblclick();
  await expect(page.locator(".media-viewer-zoom")).toHaveText("100%");
});

test("zoomed pixels reach every screen edge while the controls stay above them", async ({ page }) => {
  await openFixture(page);
  for (const size of [{ width: 1280, height: 800 }, { width: 1080, height: 1920 }]) {
    await page.setViewportSize(size);
    for (let step = 0; step < 4; step++) await page.keyboard.press("+");
    const viewport = page.locator(".media-viewer-viewport");
    expect(await viewport.boundingBox()).toEqual({ x: 0, y: 0, ...size });
    const coverage = await page.evaluate(() => [[1, 1], [innerWidth - 2, 1], [1, innerHeight - 2], [innerWidth - 2, innerHeight - 2]].map(([x, y]) =>
      document.elementsFromPoint(x!, y!).some(element => element.classList.contains("media-viewer-image"))));
    expect(coverage).toEqual([true, true, true, true]);
    await expect(page.getByRole("button", { name: "下载图片", exact: true })).toBeVisible();
    for (let step = 0; step < 4; step++) await page.keyboard.press("-");
  }
});

test("light and dark themes keep metadata legible over a bright complex background", async ({ page }) => {
  await openFixture(page);
  for (const colorTheme of ["light", "dark"]) {
    await page.evaluate(colorTheme => {
      const fixture = (window as unknown as FixtureWindow).viewerFixture;
      document.documentElement.style.setProperty("background", "repeating-conic-gradient(white 0% 25%, red 0% 50%) 0 / 32px 32px", "important");
      fixture.channel.postMessage({ type: "sync", id: "fixture", messages: fixture.descriptor.messages, colorTheme });
    }, colorTheme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", `notgram-${colorTheme}`);
    await expect(page.locator(".media-viewer-backdrop")).toHaveCSS("background-color", "rgba(11, 13, 15, 0.9)");
    await expect(page.locator(".media-viewer-details")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.locator(".media-viewer-details")).toHaveCSS("font-weight", "500");
  }
});
