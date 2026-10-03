import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
const photoSelector = '[data-message-id="contained-photo"]';

async function prepare(page: Page, spoiler = false) {
  await page.goto("/");
  await page.locator('.chat-list[data-active="true"] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async spoiler => {
    const canvas = document.createElement("canvas");
    canvas.width = 1009; canvas.height = 642;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#001b28"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#00c9ca";
    for (let y = 50; y < 330; y += 55) context.fillRect(78, y, 800 - y, 32);
    context.fillStyle = "#ff0050";
    for (let y = 350; y < 610; y += 55) context.fillRect(78, y, 680 - (y % 150), 32);
    const source = canvas.toDataURL("image/png");
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    const state = telegramStore.getState();
    const seed = state.messages.get("chat-product")!.at(-1)!;
    const photo: Message = {
      ...seed, id: "contained-photo", renderKey: undefined, mediaAlbumId: undefined, replyTo: undefined,
      outgoing: true, sentAt: "2027-01-01T16:11:47Z",
      content: { kind: "media", mediaType: "photo", fileName: "chart.png", sizeLabel: "12 KB", localPath: source,
        width: 1009, height: 642, isDownloaded: true, canDownload: false, hasSpoiler: spoiler,
        caption: "图片说明" },
    };
    const next: Message = { ...photo, id: "contained-next", sentAt: "2027-01-01T16:12:00Z",
      content: { kind: "text", text: "下一条正常消息" } };
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", [photo, next]) });
  }, spoiler);
  await expect(page.locator(`${photoSelector} img[data-photo-preview="true"]`)).toHaveAttribute("data-image-state", "ready");
  if (spoiler) await page.locator(`${photoSelector} .media-spoiler-reveal`).click();
  await expect(page.locator(`${photoSelector} img`)).toHaveCSS("opacity", "1");
}

async function expectContainedPixels(page: Page, snapshot = false) {
  const geometry = await page.evaluate(async ({ photoSelector, snapshot }) => {
    for (let index = 0; index < 3; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const container = snapshot
      ? document.querySelector(".conversation-jump-snapshot .message-list")!
      : document.querySelector('.message-list[role="log"]')!;
    const photo = snapshot ? container.querySelector(".message-row")! : document.querySelector(photoSelector)!;
    const list = container.getBoundingClientRect();
    const frame = photo.querySelector(".photo-preview")!.getBoundingClientRect();
    const caption = photo.querySelector(".photo-caption-flow")!.getBoundingClientRect();
    const bubble = photo.querySelector(".message-bubble")!.getBoundingClientRect();
    const next = (snapshot ? [...container.querySelectorAll(".message-row")].at(-1)! : document.querySelector('[data-message-id="contained-next"]')!).getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, list: { x: list.left, y: list.top, right: list.right, bottom: list.bottom }, frame: {
      x: frame.left, y: frame.top, width: frame.width, height: frame.height,
    }, captionGap: caption.top - frame.bottom, nextGap: next.top - bubble.bottom };
  }, { photoSelector, snapshot });
  expect(geometry.captionGap).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.nextGap).toBeGreaterThanOrEqual(0);
  expect(geometry.frame.height).toBeCloseTo(geometry.frame.width * 642 / 1009, 0);
  const screenshot = await page.screenshot({ animations: "disabled" });
  const pixels = await page.evaluate(async ({ encoded, geometry }) => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const scaleX = canvas.width / geometry.viewport.width, scaleY = canvas.height / geometry.viewport.height;
    let inside = 0, outside = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      if (x / scaleX < geometry.list.x || x / scaleX > geometry.list.right ||
        y / scaleY < geometry.list.y || y / scaleY > geometry.list.bottom) continue;
      // These distinctive chart colors expose stray source pixels without depending on theme backgrounds.
      const red = data[offset] > 220 && data[offset + 1] < 35 && data[offset + 2] > 50 && data[offset + 2] < 110;
      const cyan = data[offset] < 30 && data[offset + 1] > 175 && data[offset + 2] > 175;
      if (!red && !cyan) continue;
      const inFrame = x / scaleX >= geometry.frame.x - 2 && x / scaleX <= geometry.frame.x + geometry.frame.width + 2 &&
        y / scaleY >= geometry.frame.y - 2 && y / scaleY <= geometry.frame.y + geometry.frame.height + 2;
      if (inFrame) inside++; else outside++;
    }
    return { inside, outside };
  }, { encoded: screenshot.toString("base64"), geometry });
  expect(pixels.inside, JSON.stringify({ geometry, pixels })).toBeGreaterThan(1000);
  expect(pixels.outside, JSON.stringify({ geometry, pixels })).toBe(0);
}

test("source dimensions cannot expand the photo frame when metadata is missing or has a different ratio", async ({ page }) => {
  await prepare(page);
  for (const dimensions of [{}, { width: 1009, height: 1100 }]) {
    await page.evaluate(async dimensions => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const state = telegramStore.getState();
      telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!
        .map(message => message.id === "contained-photo" && message.content.kind === "media" ? {
          ...message, content: { ...message.content, width: undefined, height: undefined, ...dimensions },
        } : message)) });
    }, dimensions);
    await expect.poll(() => page.locator(`${photoSelector} img[data-image-state="ready"]`).evaluate(image => {
      const host = image.closest(".conversation-photo")!.getBoundingClientRect();
      const frame = image.closest(".photo-preview")!.getBoundingClientRect();
      const pixels = image.getBoundingClientRect();
      return Math.max(Math.abs(host.height - frame.height), Math.abs(pixels.height - frame.height),
        Math.abs(pixels.bottom - frame.bottom));
    })).toBeLessThanOrEqual(0.5);
    const gaps = await page.locator(photoSelector).evaluate(photo => {
      const frame = photo.querySelector(".photo-preview")!.getBoundingClientRect();
      const caption = photo.querySelector(".photo-caption-flow")!.getBoundingClientRect();
      const next = document.querySelector('[data-message-id="contained-next"]')!.getBoundingClientRect();
      return [caption.top - frame.bottom, next.top - photo.getBoundingClientRect().bottom];
    });
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(-0.5);
  }
});

for (const scenario of [
  { name: "desktop", width: 1366, height: 900, scale: 100, theme: "light", deviceScaleFactor: 1 },
  { name: "scaled desktop", width: 1366, height: 900, scale: 125, theme: "dark", deviceScaleFactor: 1.25 },
  { name: "narrow window", width: 390, height: 844, scale: 100, theme: "dark", deviceScaleFactor: 2 },
] as const) {
  test.describe(scenario.name, () => {
    test.use({ viewport: { width: scenario.width, height: scenario.height }, deviceScaleFactor: scenario.deviceScaleFactor });
    for (const spoiler of [false, true]) test(`photo pixels stay inside their frame through snapshots and scrolling (spoiler: ${spoiler})`, async ({ page }, testInfo) => {
      await prepare(page, spoiler);
      await page.evaluate(async scenario => {
        const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
        preferencesStore.setState({ interfaceScale: scenario.scale, themeId: `notgram-${scenario.theme}` });
      }, scenario);
      await expectContainedPixels(page);
      await page.locator(".message-list").screenshot({ path: testInfo.outputPath("photo-contained.png") });
      await page.evaluate(async () => {
        const { captureConversationJumpSnapshot } = await import("/src/utils/conversationJumpSnapshot.ts" as string) as typeof import("../../src/utils/conversationJumpSnapshot");
        const snapshot = captureConversationJumpSnapshot(document.querySelector<HTMLElement>(".message-list")!);
        Object.assign(window, { containedSnapshot: snapshot });
      });
      await expectContainedPixels(page, true);
      await page.evaluate(() => {
        (window as unknown as { containedSnapshot: { element: HTMLElement } }).containedSnapshot.element.remove();
      });
      await page.locator(".message-list").hover();
      await page.mouse.wheel(0, -100);
      await page.mouse.wheel(0, 200);
      await expectContainedPixels(page);
    });
  });
}

test("cached and retained photo layers stay bounded while resizing and decoding replacements", async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const { forgetDecodedImage } = await import("/src/media/decodedImages.ts" as string) as typeof import("../../src/media/decodedImages");
    document.querySelectorAll<HTMLImageElement>(".conversation-photo img").forEach(image => forgetDecodedImage(image.currentSrc));
    const decode = HTMLImageElement.prototype.decode;
    const pending: Array<() => void> = [];
    HTMLImageElement.prototype.decode = function () {
      if (this.closest(".conversation-photo")) return new Promise<void>(resolve => pending.push(() => { void decode.call(this).then(resolve); }));
      return decode.call(this);
    };
    Object.assign(window, { releaseContainedDecode: () => {
      pending.splice(0).forEach(release => release());
    }, restoreContainedDecode: () => { HTMLImageElement.prototype.decode = decode; } });
  });
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    const state = telegramStore.getState();
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!
      .map(message => message.id === "contained-photo" ? { ...message, renderKey: "contained-remount" } : message)) });
  });
  await expect(page.locator(`${photoSelector} .cached-media-preview canvas`)).toBeVisible();
  // Row replacement briefly overlays the previous reading position; inspect the live frame after it releases.
  await expect(page.locator(".conversation-jump-snapshot")).toHaveCount(0);
  await expectContainedPixels(page);
  await page.evaluate(() => (window as unknown as { releaseContainedDecode: () => void }).releaseContainedDecode());
  await expect(page.locator(`${photoSelector} .cached-media-preview`)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(`${photoSelector} img[data-image-retained="true"]`)).toBeVisible();
  await expectContainedPixels(page);
  await page.evaluate(() => (window as unknown as { releaseContainedDecode: () => void }).releaseContainedDecode());
  await expect(page.locator(`${photoSelector} img[data-image-retained="true"]`)).toHaveCount(0);
  await expectContainedPixels(page);
  await page.evaluate(() => (window as unknown as { restoreContainedDecode: () => void }).restoreContainedDecode());
});
