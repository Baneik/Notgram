import { expect, test, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";
import type { EmojiPickerAsset, EmojiPickerCatalog, Message, StickerSet } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
type Audit = { loads: number[]; recovered: boolean; searches: string[]; finishSearch?: (assets: EmojiPickerAsset[] | undefined) => void };
const storePath = "/src/store/telegramStore.ts";
const outline = "M40 180C40 70 120 20 256 20C392 20 472 70 472 180L472 332C472 442 392 492 256 492C120 492 40 442 40 332Z";
const ready = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
};
const picker = (page: Page) => page.getByRole("dialog", { name: "表情、贴纸与 GIF" });

test("unloaded stickers show their outline without download controls", async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(async ({ storePath, outline }) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const preferencesPath = "/src/store/preferencesStore.ts";
    const { preferencesStore } = await import(preferencesPath) as typeof import("../../src/store/preferencesStore");
    preferencesStore.setState({ autoDownloadImages: false });
    const current = telegramStore.getState();
    const catalog = (await current.loadEmojiPicker())!;
    const chatId = current.activeChatId!;
    const messages = current.messages.get(chatId)!;
    const audit: Audit = { loads: [], recovered: false, searches: [] };
    Object.assign(globalThis, { stickerAudit: audit });
    const sticker: Message = { ...messages.at(-1)!, id: "outline-download", sentAt: new Date().toISOString(), content: {
      kind: "media", mediaType: "sticker", fileId: 99001, stickerSetId: catalog.stickerSets[0].id,
      fileName: "test.webp", mimeType: "image/webp", size: 1024, sizeLabel: "1 KB", width: 512, height: 512,
      canDownload: true, isDownloaded: false, isDownloading: false,
    } };
    telegramStore.setState({ messages: new Map(current.messages).set(chatId, [...messages, sticker]),
      getCachedStickerOutline: () => outline, loadStickerOutline: async () => outline,
    });
  }, { storePath, outline });
  const row = page.locator('[data-message-id="outline-download"]');
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator(".sticker-outline path")).toHaveAttribute("d", outline);
  await expect(row.locator(".sticker-outline")).toHaveAttribute("viewBox", "0 0 512 512");
  await expect(row.locator(".photo-placeholder")).toHaveCount(0);
  await row.screenshot({ path: testInfo.outputPath("sticker-outline.png") });
  await expect(row.getByRole("button", { name: "下载 test.webp" })).toHaveCount(0);
  await expect(row.locator(".media-progress")).toHaveCount(0);
  await expect(page.locator(".sticker-set-dialog")).toHaveCount(0);
  await row.getByRole("button", { name: "查看贴纸包" }).click({ position: { x: 8, y: 8 } });
  await expect(page.locator(".sticker-set-dialog")).toBeVisible();
});

test("a decoded sticker does not retain a stale download button", async ({ page }) => {
  await ready(page);
  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const current = telegramStore.getState();
    const chatId = current.activeChatId!;
    const messages = current.messages.get(chatId)!;
    const sticker: Message = { ...messages.at(-1)!, id: "decoded-stale-download", sentAt: new Date().toISOString(), content: {
      kind: "media", mediaType: "sticker", fileId: 99006,
      fileName: "decoded.webp", mimeType: "image/webp", size: 1024, sizeLabel: "1 KB", width: 512, height: 512,
      localPath: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      canDownload: true, isDownloaded: false, isDownloading: false,
    } };
    telegramStore.setState({ messages: new Map(current.messages).set(chatId, [...messages, sticker]) });
  }, storePath);
  const row = page.locator('[data-message-id="decoded-stale-download"]');
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('img[data-image-state="ready"]')).toBeVisible();
  await expect(row.getByRole("button", { name: "下载 decoded.webp" })).toHaveCount(0);
  await expect(row.locator(".media-progress")).toHaveCount(0);
});

test("a transient asset failure recovers in the same open picker", async ({ page }) => {
  await ready(page);
  await page.evaluate(async ({ storePath, outline }) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const audit: Audit = { loads: [], recovered: false, searches: [] };
    Object.assign(globalThis, { stickerAudit: audit });
    const asset: EmojiPickerAsset = { id: "retry-asset", kind: "sticker", fileId: 99002, fileName: "test.webp", mimeType: "image/webp", width: 512, height: 512 };
    const catalog: EmojiPickerCatalog = { recentStickers: [asset], stickerSets: [], savedAnimations: [] };
    telegramStore.setState({ getCachedEmojiPicker: () => catalog, loadEmojiPicker: async () => catalog,
      getCachedEmojiAsset: () => undefined, getCachedStickerOutline: () => outline,
      loadEmojiAsset: async (asset) => { audit.loads.push(asset.fileId); return audit.recovered ? "/mock-video-poster.jpg" : undefined; },
    });
  }, { storePath, outline });
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(picker(page).locator(".emoji-asset-error")).toBeVisible();
  await expect(picker(page).locator(".sticker-outline")).toBeVisible();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { stickerAudit: Audit }).stickerAudit.recovered = true;
    dispatchEvent(new Event("online"));
  });
  await expect(picker(page).locator('img[data-image-state="ready"]')).toBeVisible();
  await expect(picker(page).locator(".sticker-placeholder")).toHaveCount(0);
  await expect(picker(page).locator(".emoji-asset-error")).toHaveCount(0);
});

test("new searches hide old sendable results and distinguish failure from empty results", async ({ page }) => {
  await ready(page);
  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const catalog = (await telegramStore.getState().loadEmojiPicker())!;
    const asset = { ...catalog.recentStickers[0], emoji: "OLD" };
    const audit: Audit = { loads: [], recovered: false, searches: [] };
    Object.assign(globalThis, { stickerAudit: audit });
    telegramStore.setState({ searchStickers: async (query) => {
      audit.searches.push(query);
      if (query === "old") return [asset];
      return new Promise((resolve) => { audit.finishSearch = resolve; });
    } });
  }, storePath);
  await page.getByRole("button", { name: "表情", exact: true }).click();
  const search = picker(page).getByRole("searchbox", { name: "搜索贴纸" });
  await search.fill("old");
  await expect(picker(page).getByRole("button", { name: "发送贴纸 OLD" })).toBeVisible();
  await search.fill("new");
  await expect(picker(page).getByRole("button", { name: "发送贴纸 OLD" })).toHaveCount(0);
  await expect(picker(page).getByRole("status")).toContainText("正在搜索贴纸");
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { stickerAudit: Audit }).stickerAudit.searches.length)).toBe(2);
  await page.evaluate(() => (globalThis as typeof globalThis & { stickerAudit: Audit }).stickerAudit.finishSearch?.(undefined));
  await expect(picker(page).getByRole("alert")).toContainText("无法搜索贴纸");
  await picker(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { stickerAudit: Audit }).stickerAudit.searches.length)).toBe(3);
  await page.evaluate(() => (globalThis as typeof globalThis & { stickerAudit: Audit }).stickerAudit.finishSearch?.([]));
  await expect(picker(page).getByText("没有可用的贴纸", { exact: true })).toBeVisible();
  await expect(picker(page).getByRole("alert")).toHaveCount(0);
});

test("pack changes update an already open picker", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(picker(page).getByRole("button", { name: "工作日常", exact: true })).toBeVisible();
  await page.evaluate(async (storePath) => { const { telegramStore } = await import(storePath) as StoreModule; await telegramStore.getState().removeStickerSet("mock-pack-work"); }, storePath);
  await expect(picker(page).getByRole("button", { name: "工作日常", exact: true })).toHaveCount(0);
  await page.evaluate(async (storePath) => { const { telegramStore } = await import(storePath) as StoreModule; await telegramStore.getState().addStickerSet("mock-pack-work"); }, storePath);
  await expect(picker(page).getByRole("button", { name: "工作日常", exact: true })).toBeVisible();
});

test("sticker sharing links reuse the preview with persistent install and remove state", async ({ page }) => {
  await ready(page);
  const openLink = () => page.evaluate(async () => {
    const linkPath = "/src/utils/externalLinks.ts";
    const { openTelegramLinkInApp } = await import(linkPath) as typeof import("../../src/utils/externalLinks");
    await openTelegramLinkInApp("https://t.me/addstickers/notgram_work");
  });
  await openLink();
  const preview = page.getByRole("dialog", { name: "工作日常" });
  await preview.getByRole("button", { name: "移除贴纸", exact: true }).click();
  await expect(preview).toBeHidden();
  await openLink();
  await preview.getByRole("button", { name: "添加贴纸", exact: true }).click();
  await expect(preview).toBeHidden();
  await openLink();
  await expect(preview.getByRole("button", { name: "移除贴纸", exact: true })).toBeVisible();
});

test("static pack tiles use thumbnails, and the selected TGS preview replaces its outline when ready", async ({ page }) => {
  const tgs = gzipSync(JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 60, w: 512, h: 512, nm: "Sticker test", ddd: 0, assets: [], layers: [
    { ddd: 0, ind: 1, ty: 4, nm: "Shape", sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, ao: 0,
      shapes: [{ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [400, 400] }, nm: "Ellipse" }, { ty: "fl", c: { a: 0, k: [0.2, 0.6, 0.9, 1] }, o: { a: 0, k: 100 }, r: 1 }], ip: 0, op: 60, st: 0, bm: 0 },
  ] }));
  let releaseTgs!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseTgs = resolve; });
  await page.route("**/audit-sticker.tgs", async (route) => { await barrier; await route.fulfill({ contentType: "application/x-tgsticker", body: tgs }); });
  await ready(page);
  await page.evaluate(async ({ storePath, outline }) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const preferencesPath = "/src/store/preferencesStore.ts";
    const { preferencesStore } = await import(preferencesPath) as typeof import("../../src/store/preferencesStore");
    preferencesStore.setState({ autoplayAnimations: false });
    const asset: EmojiPickerAsset = { id: "tgs-test", kind: "sticker", fileId: 99003, previewFileId: 99004, fileName: "test.tgs", mimeType: "application/x-tgsticker", previewMimeType: "image/jpeg", width: 512, height: 512 };
    const pack: StickerSet = { id: "tgs-pack", name: "tgs_pack", title: "TGS preview", size: 1, covers: [asset], stickers: [asset], isInstalled: false };
    const catalog: EmojiPickerCatalog = { recentStickers: [asset], stickerSets: [pack], savedAnimations: [] };
    const audit: Audit = { loads: [], recovered: false, searches: [] };
    Object.assign(globalThis, { stickerAudit: audit });
    telegramStore.setState({ getCachedEmojiPicker: () => catalog, loadEmojiPicker: async () => catalog,
      getCachedStickerSet: () => pack, loadStickerSet: async () => pack, getCachedEmojiAsset: () => undefined,
      getCachedStickerOutline: () => outline,
      loadEmojiAsset: async (asset) => { audit.loads.push(asset.fileId); return asset.fileId === 99003 ? "/audit-sticker.tgs" : "/mock-video-poster.jpg"; },
    });
  }, { storePath, outline });
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(picker(page).locator('img[data-image-state="ready"]').first()).toBeVisible();
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { stickerAudit: Audit }).stickerAudit.loads)).not.toContain(99003);
  await expect(picker(page).locator(".tgs-sticker, video")).toHaveCount(0);
  await picker(page).getByRole("button", { name: "关闭表情面板" }).click();
  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    dispatchEvent(new CustomEvent("notgram:telegram-link-opened", { detail: { kind: "stickerSet", stickerSet: await telegramStore.getState().loadStickerSet("tgs-pack") } }));
  }, storePath);
  const stage = page.getByRole("dialog", { name: "TGS preview" }).getByLabel("贴纸预览", { exact: true });
  await expect(stage.locator(".sticker-outline path")).toHaveAttribute("d", outline);
  releaseTgs();
  await expect(stage.locator(".tgs-sticker svg")).toBeVisible();
  await expect(stage.locator(".sticker-placeholder")).toHaveCount(0);
  await expect(stage.locator(".tgs-sticker")).toHaveAttribute("data-motion-autoplay", "false");
  await expect(page.locator(".sticker-set-list .tgs-sticker")).toHaveCount(0);
});

test("real WebM stickers replace the outline and obey muted reduced-motion playback", async ({ page }) => {
  await ready(page);
  await page.evaluate(async ({ storePath, outline }) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const preferencesPath = "/src/store/preferencesStore.ts";
    const { preferencesStore } = await import(preferencesPath) as typeof import("../../src/store/preferencesStore");
    preferencesStore.setState({ autoplayAnimations: true, effectiveReduceMotion: false });
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 128;
    const drawing = canvas.getContext("2d")!;
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks: BlobPart[] = [];
    const recorded = new Promise<Blob>((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });
    recorder.start();
    const paint = () => { drawing.fillStyle = "#4080d0"; drawing.fillRect(0, 0, 128, 128); };
    paint();
    const timer = setInterval(paint, 50);
    await new Promise((resolve) => setTimeout(resolve, 250));
    recorder.stop();
    clearInterval(timer);
    const blob = await recorded;
    stream.getTracks().forEach((track) => track.stop());
    const current = telegramStore.getState();
    const chatId = current.activeChatId!;
    const messages = current.messages.get(chatId)!;
    const message: Message = { ...messages.at(-1)!, id: "webm-sticker", sentAt: new Date().toISOString(), content: {
      kind: "media", mediaType: "sticker", fileId: 99005, fileName: "test.webm", mimeType: "video/webm", width: 128, height: 128,
      size: blob.size, sizeLabel: "WebM", localPath: URL.createObjectURL(blob), isDownloaded: true,
    } };
    telegramStore.setState({ messages: new Map(current.messages).set(chatId, [...messages, message]), getCachedStickerOutline: () => outline });
  }, { storePath, outline });
  const row = page.locator('[data-message-id="webm-sticker"]');
  await row.scrollIntoViewIfNeeded();
  await expect.poll(() => row.locator("video").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(row.locator(".sticker-placeholder")).toHaveCount(0);
  await expect(row.locator("video")).toHaveJSProperty("muted", true);
  await page.evaluate(async () => {
    const preferencesPath = "/src/store/preferencesStore.ts";
    const { preferencesStore } = await import(preferencesPath) as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("reduceMotion", true);
  });
  await expect(row.locator("video")).toHaveAttribute("data-motion-autoplay", "false");
  await expect(row.locator("video")).toHaveJSProperty("paused", true);
});
