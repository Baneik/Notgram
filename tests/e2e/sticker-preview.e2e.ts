import { expect, test, type Page } from "@playwright/test";
import type { EmojiPickerAsset, Message, StickerSet } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
type PreviewAudit = { reads: number; complete: (succeeded?: boolean) => void };
type PreviewWindow = typeof globalThis & { stickerPreviewAudit: PreviewAudit };
const storePath = "/src/store/telegramStore.ts";

async function preparePreview(page: Page, options: {
  cached?: boolean;
  identity?: "numeric" | "unique" | "remote" | "missing";
} = {}) {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  }
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect(page.locator("[data-message-id]").last()).toBeVisible();
  await page.evaluate(async ({ storePath, options }) => {
    const { telegramStore } = await import(storePath) as StoreModule;
    const identity = options.identity ?? "numeric";
    const rebound = identity === "unique" || identity === "remote";
    const stickers: EmojiPickerAsset[] = [0, 1, 2].map((index) => ({
      id: `preview-asset-${index}`, kind: "sticker", fileId: 92001 + index,
      stickerSetId: "preview-pack", fileName: "sticker.webp", mimeType: "image/webp",
      localPath: "/mock-video-poster.jpg", width: 128, height: 128,
    }));
    if (rebound) {
      stickers[0] = { ...stickers[0], fileId: 92002, remoteId: "other-file", remoteUniqueId: "other-unique" };
      stickers[1] = { ...stickers[1], fileId: 93002, remoteId: "refreshed-reference", remoteUniqueId: "selected-unique" };
      if (identity === "remote") stickers[1].remoteId = "selected-reference";
    }
    const set: StickerSet = { id: "preview-pack", title: "Preview selection", name: "preview_pack",
      size: stickers.length, covers: [stickers[0]], stickers };
    let cached = options.cached ? set : undefined;
    const pending = new Set<(value: StickerSet | undefined) => void>();
    const audit: PreviewAudit = { reads: 0, complete: (succeeded = true) => {
      cached = succeeded ? set : undefined;
      for (const resolve of pending) resolve(cached);
      pending.clear();
    } };
    Object.assign(globalThis, { stickerPreviewAudit: audit });
    const state = telegramStore.getState();
    const chatId = state.activeChatId!;
    const messages = state.messages.get(chatId)!;
    const added: Message[] = [1, 2].map((index) => ({
      ...messages.at(-1)!, id: `preview-message-${index}`, sentAt: new Date(Date.now() + index).toISOString(),
      content: { kind: "media", mediaType: "sticker", stickerSetId: set.id,
        fileId: index === 1 && identity === "missing" ? 92009 : 92001 + index,
        remoteId: index === 1 && rebound ? "selected-reference" : undefined,
        remoteUniqueId: index === 1 && identity === "unique" ? "selected-unique" : undefined,
        fileName: "sticker.webp", mimeType: "image/webp", sizeLabel: "1 KB",
        localPath: "/mock-video-poster.jpg", isDownloaded: true, width: 128, height: 128 },
    }));
    telegramStore.setState({ messages: new Map(state.messages).set(chatId, [...messages, ...added]),
      getCachedStickerSet: () => cached,
      loadStickerSet: async () => {
        audit.reads += 1;
        return new Promise<StickerSet | undefined>((resolve) => pending.add(resolve));
      },
      getCachedEmojiAsset: () => "/mock-video-poster.jpg",
      loadEmojiAsset: async () => "/mock-video-poster.jpg",
    });
  }, { storePath, options });
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Preview selection" });
async function openMessage(page: Page, index = 1) {
  await page.locator(`[data-message-id="preview-message-${index}"]`)
    .getByRole("button", { name: "查看贴纸包" }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as PreviewWindow).stickerPreviewAudit.reads)).toBeGreaterThan(0);
}
async function completeRead(page: Page, succeeded = true) {
  await page.evaluate((succeeded) => (globalThis as PreviewWindow).stickerPreviewAudit.complete(succeeded), succeeded);
}
async function expectSelection(page: Page, index: number) {
  await expect(dialog(page).locator(".sticker-set-stage .emoji-asset-visual"))
    .toHaveAttribute("data-asset-id", `preview-asset-${index}`);
  await expect(dialog(page).locator(".sticker-set-list button[aria-pressed=true] .emoji-asset-visual"))
    .toHaveAttribute("data-asset-id", `preview-asset-${index}`);
  await expect(dialog(page).locator('.sticker-set-stage img[data-image-state="ready"]')).toBeVisible();
}

for (const width of [1366, 390]) {
  for (const cached of [true, false]) {
    test(`message sticker preview selects the clicked sticker at ${width}px with ${cached ? "cached" : "delayed"} pack data`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await preparePreview(page, { cached });
      await openMessage(page);
      if (!cached) await completeRead(page);
      await expectSelection(page, 1);
      await dialog(page).locator(".sticker-set-list button").nth(2).click();
      if (cached) await completeRead(page);
      await expectSelection(page, 2);
      await dialog(page).getByRole("button", { name: "关闭贴纸包预览" }).click();
      await expect(dialog(page)).toBeHidden();
      await openMessage(page, 2);
      await expectSelection(page, 2);
      await dialog(page).getByRole("button", { name: "关闭贴纸包预览" }).click();
      await openMessage(page);
      await expectSelection(page, 1);
    });
  }
}

for (const identity of ["unique", "remote"] as const) {
  test(`message sticker preview uses the ${identity} identity after numeric file handles change`, async ({ page }) => {
    await preparePreview(page, { cached: true, identity });
    await openMessage(page);
    await expectSelection(page, 1);
    await completeRead(page);
    await expectSelection(page, 1);
  });
}

test("sticker preview preserves the clicked target through a failed pack read and retry", async ({ page }) => {
  await preparePreview(page);
  await openMessage(page);
  await completeRead(page, false);
  await expect(page.getByRole("alert")).toContainText("无法加载这个贴纸包");
  const readsBeforeRetry = await page.evaluate(() => (globalThis as PreviewWindow).stickerPreviewAudit.reads);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as PreviewWindow).stickerPreviewAudit.reads)).toBeGreaterThan(readsBeforeRetry);
  await completeRead(page);
  await expectSelection(page, 1);
});

test("pack links and unavailable message stickers fall back to the first sticker", async ({ page }) => {
  await preparePreview(page, { cached: true, identity: "missing" });
  await openMessage(page);
  await expectSelection(page, 0);
  await dialog(page).locator(".sticker-set-list button").nth(2).click();
  await expectSelection(page, 2);
  await page.evaluate(() => dispatchEvent(new CustomEvent("notgram:telegram-link-opened", {
    detail: { kind: "stickerSet", stickerSet: { id: "preview-pack" } },
  })));
  await expectSelection(page, 0);
});
