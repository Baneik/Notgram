import { expect, test, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { EmojiPickerAsset, EmojiPickerCatalog, StickerSet } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
type ControllerModule = typeof import("../../src/store/telegramStore.emoji");
type Transport = import("../../src/telegram/transport").TelegramTransport;
const dialog = (page: Page) => page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
const image = readFileSync("tests/fixtures/public/mock-video-poster.jpg");
const video = readFileSync("tests/fixtures/sticker.webm");
const animation = gzipSync(JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 30, w: 96, h: 96, ddd: 0, assets: [], layers: [
  { ddd: 0, ind: 1, ty: 4, sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [48, 48, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, ao: 0,
    shapes: [{ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [80, 80] } }, { ty: "fl", c: { a: 0, k: [0.2, 0.6, 0.9, 1] }, o: { a: 0, k: 100 }, r: 1 }], ip: 0, op: 30, st: 0, bm: 0 },
] }));

const ready = async (page: Page) => {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    return telegramStore.getState().authorization.kind;
  })).toBe("ready");
};

for (const width of [1366, 390]) {
  test(`persisted sticker pixels survive heavy-cache eviction and a restart with stalled refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/src/telegram/mockTransport.ts", async route => {
      const response = await route.fetch();
      const source = (await response.text())
        .replace("async getEmojiPickerCatalog() {", 'async getEmojiPickerCatalog() { if (sessionStorage.getItem("notgram-prepared-sticker-restart")) return new Promise(() => {});')
        .replace("async getStickerSet(stickerSetId) {", 'async getStickerSet(stickerSetId) { if (sessionStorage.getItem("notgram-prepared-sticker-restart")) return new Promise(() => {});');
      await route.fulfill({ response, body: source });
    });
    await page.route("**/ready-sticker-*", route => {
      const path = route.request().url();
      const tgs = path.endsWith(".tgs");
      const webm = path.endsWith(".webm");
      return route.fulfill({ body: tgs ? animation : webm ? video : image,
        headers: { "Content-Type": tgs ? "application/gzip" : webm ? "video/webm" : "image/jpeg", "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*" } });
    });
    await ready(page);
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const { createEmojiPickerController } = await import("/src/store/telegramStore.emoji.ts" as string) as ControllerModule;
      const assets: EmojiPickerAsset[] = ["jpg", "tgs", "webm"].map((extension, index) => ({
        id: `prepared-${extension}`, kind: "sticker", fileId: 99400 + index, remoteId: `remote-${extension}`, remoteUniqueId: `stable-${extension}`,
        fileName: `sticker.${extension}`, localPath: `${location.origin.replace("127.0.0.1", "localhost")}/ready-sticker-${index}.${extension}`,
        mimeType: extension === "tgs" ? "application/x-tgsticker" : extension === "webm" ? "video/webm" : "image/jpeg", emoji: ["😊", "🙂", "😺"][index],
      }));
      const pack: StickerSet = { id: "prepared-pack", title: "Prepared pack", name: "prepared", size: assets.length, covers: [assets[0]], stickers: assets, isInstalled: true };
      const catalog: EmojiPickerCatalog = { recentStickers: assets, stickerSets: [pack], savedAnimations: [] };
      const controller = createEmojiPickerController({ transport: {
        getEmojiPickerCatalog: async () => catalog, getStickerSet: async () => pack,
        loadEmojiAsset: async (asset: EmojiPickerAsset) => asset.localPath,
      } as unknown as Transport, get: () => ({ authorization: { kind: "ready" }, activeAccountId: "default" }),
        set: patch => telegramStore.setState(patch), onError: (_error, fallback) => fallback });
      Object.assign(globalThis, { preparedController: controller });
      controller.warm();
    });
    await expect.poll(() => page.evaluate(() => {
      const controller = (globalThis as unknown as { preparedController: ReturnType<ControllerModule["createEmojiPickerController"]> }).preparedController;
      return controller.snapshot().emojiPickerPreviews?.length;
    })).toBe(3);
    const previewPixels = await page.evaluate(async () => {
      const controller = (globalThis as unknown as { preparedController: ReturnType<ControllerModule["createEmojiPickerController"]> }).preparedController;
      return Promise.all(controller.snapshot().emojiPickerPreviews!.map(async preview => {
        const image = new Image(); image.src = preview.dataUrl; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 96;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, 96, 96).data.some((value, index) => index % 4 === 3 && value > 0);
      }));
    });
    expect(previewPixels).toEqual([true, true, true]);

    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      await telegramStore.getState().rebuildCachedSnapshot();
      const key = Object.keys(localStorage).find(key => key.startsWith("notgram:ui-cache:"))!;
      const snapshot = JSON.parse(localStorage.getItem(key)!);
      const controller = (globalThis as unknown as { preparedController: ReturnType<ControllerModule["createEmojiPickerController"]> }).preparedController;
      Object.assign(snapshot, controller.snapshot());
      // Original TDLib files and shared decoded/Blob caches are replaceable.
      for (const asset of snapshot.emojiPickerCatalog.recentStickers) delete asset.localPath;
      for (const set of snapshot.emojiPickerSets) for (const asset of set.stickers) delete asset.localPath;
      localStorage.setItem(key, JSON.stringify(snapshot));
      sessionStorage.setItem("notgram-prepared-sticker-restart", "1");
    });
    await page.reload();
    if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const state = telegramStore.getState();
      // Verify restoration before substituting stalled refreshes.
      if (state.getCachedStickerPickerPreview({ id: "prepared-tgs", kind: "sticker", fileId: 99401, remoteUniqueId: "stable-tgs", fileName: "sticker.tgs" }) === undefined)
        throw new Error("The persisted animation preview was not restored");
      const sends: number[] = [];
      Object.assign(globalThis, { preparedSends: sends });
      telegramStore.setState({ getCachedEmojiAsset: () => undefined,
        loadEmojiAsset: async () => new Promise(() => undefined), sendSticker: async asset => { sends.push(asset.fileId); return new Promise(() => undefined); } });
      const { clearMediaPreviewCache } = await import("/src/media/mediaPreviewCache.ts" as string) as typeof import("../../src/media/mediaPreviewCache");
      const { clearLocalAssetCache } = await import("/src/media/localAssetCache.ts" as string) as typeof import("../../src/media/localAssetCache");
      const { clearTgsAnimationCache } = await import("/src/media/tgsAnimationCache.ts" as string) as typeof import("../../src/media/tgsAnimationCache");
      clearMediaPreviewCache(); clearLocalAssetCache(); clearTgsAnimationCache();
    });
    await page.getByRole("button", { name: "表情", exact: true }).click();
    await expect(dialog(page).locator('.emoji-asset-grid img[data-picker-preview="true"]')).toHaveCount(3, { timeout: 1500 });
    await expect(dialog(page).locator(".emoji-asset-grid .sticker-placeholder")).toHaveCount(0);
    await dialog(page).getByTitle("Prepared pack", { exact: true }).click();
    await expect(dialog(page).getByText("正在加载贴纸包", { exact: true })).toHaveCount(0);
    await expect(dialog(page).locator('.emoji-asset-grid img[data-picker-preview="true"]')).toHaveCount(3, { timeout: 1500 });
    await dialog(page).getByRole("button", { name: "发送贴纸 🙂", exact: true }).click({ timeout: 1500 });
    expect(await page.evaluate(() => (globalThis as unknown as { preparedSends: number[] }).preparedSends)).toEqual([99401]);
    await dialog(page).getByRole("button", { name: "关闭表情面板" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "表情", exact: true }).click();
    await expect(dialog(page).locator('.emoji-asset-grid img[data-picker-preview="true"]')).toHaveCount(3, { timeout: 1500 });
    await expect(dialog(page).locator(".emoji-asset-grid .sticker-placeholder")).toHaveCount(0);
  });
}

test("background preparation shares two slots, uses thumbnail identity, and ignores late work after reset", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { createEmojiPickerController } = await import("/src/store/telegramStore.emoji.ts" as string) as ControllerModule;
    const assets: EmojiPickerAsset[] = [1, 2, 3].map(fileId => ({ id: String(fileId), kind: "sticker", fileId,
      fileName: "sticker.tgs", mimeType: "application/x-tgsticker", previewFileId: fileId + 10, previewRemoteId: `thumbnail-${fileId}` }));
    const calls: Array<{ fileId: number; remoteId?: string; priority?: number }> = [];
    const pending: Array<(path: string) => void> = [];
    const controller = createEmojiPickerController({ transport: { getEmojiPickerCatalog: async () => ({ recentStickers: assets, stickerSets: [], savedAnimations: [] }),
      loadEmojiAsset: async (asset: EmojiPickerAsset, priority?: number) => {
        calls.push({ fileId: asset.fileId, remoteId: asset.remoteId, priority });
        return new Promise<string>(resolve => pending.push(resolve));
      },
    } as unknown as Transport, get: () => ({ authorization: { kind: "ready" }, activeAccountId: "one" }), set: () => undefined,
      onError: (_error, fallback) => fallback, preparePreview: async () => "data:image/webp;base64,AAAA" });
    await controller.loadEmojiPicker();
    const queued = calls.slice();
    controller.reset();
    for (const resolve of pending) resolve("/unused.jpg");
    await new Promise(resolve => setTimeout(resolve, 0));
    return { queued, completed: controller.snapshot().emojiPickerPreviews, calls: calls.length };
  });
  expect(result.queued).toEqual([{ fileId: 11, remoteId: "thumbnail-1", priority: 19 }, { fileId: 12, remoteId: "thumbnail-2", priority: 19 }]);
  expect(result.completed).toEqual([]);
  expect(result.calls).toBe(2);
});
