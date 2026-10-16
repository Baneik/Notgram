import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { EmojiPickerAsset, EmojiPickerCatalog } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
const pixels = `data:image/jpeg;base64,${readFileSync("tests/fixtures/public/mock-video-poster.jpg").toString("base64")}`;
const dialog = (page: Page) => page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
const ready = async (page: Page) => {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
};

for (const width of [1366, 390]) {
  test(`prepared sticker grids open without starting full animations at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await page.evaluate(async pixels => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const assets: EmojiPickerAsset[] = [1, 2, 3].map(id => ({ id: `prepared-${id}`, fileId: 99500 + id,
        kind: "sticker", fileName: "sticker.tgs", mimeType: "application/x-tgsticker", emoji: ["😊", "🙂", "😺"][id - 1] }));
      const catalog: EmojiPickerCatalog = { recentStickers: assets, stickerSets: [], savedAnimations: [] };
      const loads: number[] = [];
      Object.assign(globalThis, { preparedLoads: loads });
      telegramStore.setState({ getCachedEmojiPicker: () => catalog, loadEmojiPicker: async () => catalog,
        getCachedStickerPickerPreview: () => pixels, getCachedEmojiAsset: () => undefined,
        loadEmojiAsset: async asset => { loads.push(asset.fileId); return new Promise(() => undefined); } });
    }, pixels);
    await page.getByRole("button", { name: "表情", exact: true }).click();
    await expect(dialog(page).locator('img[data-picker-preview="true"]')).toHaveCount(3, { timeout: 1500 });
    expect(await page.evaluate(() => (globalThis as unknown as { preparedLoads: number[] }).preparedLoads)).toEqual([]);
    await expect(dialog(page).locator(".tgs-sticker, video")).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "发送贴纸 😊", exact: true }).hover();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { preparedLoads: number[] }).preparedLoads)).toEqual([99501]);
  });

  test(`sticker clicks show a pending message before TDLib returns and failed sends retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/src/telegram/mockTransport.ts", async route => {
      const response = await route.fetch();
      const source = (await response.text()).replace("async sendSticker(input) {", `async sendSticker(input) {
        if (input.asset.remoteId === "latency-remote") {
          const audit = globalThis.stickerSendLatency;
          audit.calls++;
          await new Promise((resolve, reject) => { audit.finish = resolve; audit.fail = reject; });
        }`);
      await route.fulfill({ response, body: source });
    });
    await ready(page);
    await page.evaluate(async pixels => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const asset: EmojiPickerAsset = { id: "latency-sticker", fileId: 99510, remoteId: "latency-remote", remoteUniqueId: "latency-stable",
        kind: "sticker", fileName: "sticker.webp", mimeType: "image/webp", emoji: "🙂", previewDataUrl: pixels };
      const catalog: EmojiPickerCatalog = { recentStickers: [asset], stickerSets: [], savedAnimations: [] };
      Object.assign(globalThis, { stickerSendLatency: { calls: 0 } });
      telegramStore.setState({ getCachedEmojiPicker: () => catalog, loadEmojiPicker: async () => catalog,
        getCachedStickerPickerPreview: () => pixels, getCachedEmojiAsset: () => undefined,
        loadEmojiAsset: async () => new Promise(() => undefined) });
    }, pixels);
    await page.getByRole("button", { name: "表情", exact: true }).click();
    await dialog(page).getByRole("button", { name: "发送贴纸 🙂", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0, { timeout: 1000 });
    const pending = page.locator('[data-message-id^="outbox:"]');
    await expect(pending).toBeVisible({ timeout: 1000 });
    await expect(pending.locator('[data-delivery="sending"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { stickerSendLatency: { calls: number } }).stickerSendLatency.calls)).toBe(1);
    await page.evaluate(() => (globalThis as unknown as { stickerSendLatency: { fail: (error: Error) => void } }).stickerSendLatency.fail(new Error("temporary send failure")));
    await expect(pending.locator('[data-delivery="failed"]')).toBeVisible();
    await pending.getByRole("button", { name: "重试发送", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { stickerSendLatency: { calls: number } }).stickerSendLatency.calls)).toBe(2);
    await page.evaluate(() => (globalThis as unknown as { stickerSendLatency: { finish: () => void } }).stickerSendLatency.finish());
    await expect(pending).toHaveCount(0);
    await expect(page.locator('[data-media-type="sticker"]')).toHaveCount(1);
  });
}
