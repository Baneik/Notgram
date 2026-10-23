import { expect, test, type Page } from "@playwright/test";
import type { EmojiPickerAsset, Message, StickerSet } from "../../src/telegram/types";
import { horizontalOverflow } from "./helpers";

type Audit = { exports: { fileIds: number[]; name: string }[]; sends: number; finish?: () => void };
type AuditWindow = typeof globalThis & { stickerExportAudit: Audit };
const storePath = "/src/store/telegramStore.ts";
const mockPath = "/src/telegram/mockTransport.ts";
const picker = (page: Page) => page.locator(".emoji-picker");
const preview = (page: Page) => page.getByRole("dialog", { name: "Export test pack" });

async function prepare(page: Page, mode: "saved" | "cancelled" | "failed" | "pending" = "saved") {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  }
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect(page.locator("[data-message-id]").last()).toBeVisible();
  await page.evaluate(async ({ storePath, mockPath, mode }) => {
    const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import(mockPath) as typeof import("../../src/telegram/mockTransport");
    const stickers: EmojiPickerAsset[] = ["🙂", "😊", "😃"].map((emoji, index) => ({
      id: `export-sticker-${index}`, kind: "sticker", fileId: 94001 + index, stickerSetId: "export-pack",
      fileName: "sticker.webp", mimeType: "image/webp", emoji, localPath: "/mock-video-poster.jpg",
    }));
    const pack: StickerSet = { id: "export-pack", title: "Export test pack", name: "export_test", size: 3, covers: [stickers[0]], stickers };
    const catalog = { recentStickers: stickers, stickerSets: [pack], savedAnimations: [] };
    const audit: Audit = { exports: [], sends: 0 };
    Object.assign(globalThis, { stickerExportAudit: audit });
    MockTelegramTransport.prototype.getStickerSet = async () => ({ ...pack, isInstalled: false, isArchived: false });
    MockTelegramTransport.prototype.exportStickers = async (assets, name) => {
      audit.exports.push({ fileIds: assets.map(asset => asset.fileId), name });
      if (mode === "pending") await new Promise<void>(resolve => { audit.finish = resolve; });
      if (mode === "failed") throw new Error("Export failed");
      return mode !== "cancelled";
    };
    const state = telegramStore.getState();
    const chatId = state.activeChatId!;
    const messages = state.messages.get(chatId)!;
    const message: Message = { ...messages.at(-1)!, id: "export-preview-message", sentAt: new Date().toISOString(), content: {
      kind: "media", mediaType: "sticker", stickerSetId: pack.id, fileId: stickers[1].fileId,
      fileName: "sticker.webp", mimeType: "image/webp", localPath: "/mock-video-poster.jpg", isDownloaded: true, sizeLabel: "1 KB",
    } };
    telegramStore.setState({
      messages: new Map(state.messages).set(chatId, [...messages, message]),
      getCachedEmojiPicker: () => catalog, loadEmojiPicker: async () => catalog,
      getCachedEmojiAsset: () => "/mock-video-poster.jpg", loadEmojiAsset: async () => "/mock-video-poster.jpg",
      sendSticker: async () => { audit.sends++; return true; },
    });
  }, { storePath, mockPath, mode });
}

async function openPreview(page: Page) {
  await page.locator('[data-message-id="export-preview-message"]').getByRole("button", { name: "查看贴纸包" }).click();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).getByRole("button", { name: "导出贴纸包" })).toBeEnabled();
}

async function exports(page: Page) {
  return page.evaluate(() => (globalThis as AuditWindow).stickerExportAudit.exports);
}

for (const width of [1366, 390]) {
  test(`pack preview exports the complete pack from its footer at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await prepare(page);
    await openPreview(page);
    const footer = preview(page).locator(".sticker-set-footer");
    const buttons = await footer.getByRole("button").evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, height: rect.height, className: node.className };
    }));
    expect(buttons).toHaveLength(2);
    expect(buttons[0].x).toBeLessThan(buttons[1].x);
    expect(buttons[0].y).toBe(buttons[1].y);
    expect(buttons[0].className).toBe(buttons[1].className);
    await preview(page).getByRole("button", { name: "导出贴纸包" }).click();
    await expect(preview(page).getByRole("status")).toHaveText("贴纸已导出");
    expect(await exports(page)).toEqual([{ fileIds: [94001, 94002, 94003], name: "export_test" }]);
    expect(await horizontalOverflow(page)).toBe(false);
    await preview(page).screenshot({ path: testInfo.outputPath(`export-preview-${width}.png`) });
  });

  test(`picker group and sticker context menus export their exact targets at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await prepare(page);
    await page.getByRole("button", { name: "表情", exact: true }).click();
    await picker(page).getByRole("button", { name: "Export test pack" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "导出贴纸包" }).click();
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).getByRole("status")).toHaveText("贴纸已导出");
    await picker(page).getByRole("button", { name: "发送贴纸 😊" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "导出贴纸", exact: true }).click();
    await expect.poll(() => exports(page)).toEqual([
      { fileIds: [94001, 94002, 94003], name: "export_test" }, { fileIds: [94002], name: "export_test_002" },
    ]);
    expect(await page.evaluate(() => (globalThis as AuditWindow).stickerExportAudit.sends)).toBe(0);
    expect(await horizontalOverflow(page)).toBe(false);
    await picker(page).screenshot({ path: testInfo.outputPath(`export-picker-${width}.png`) });
  });
}

test("preview grid and enlarged sticker export the clicked sticker without changing selection", async ({ page }) => {
  await prepare(page);
  await openPreview(page);
  await preview(page).locator(".sticker-set-list > button").nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "导出贴纸", exact: true }).click();
  await expect.poll(() => exports(page)).toEqual([{ fileIds: [94003], name: "export_test_003" }]);
  await expect(preview(page).locator(".sticker-set-stage .emoji-asset-visual")).toHaveAttribute("data-asset-id", "export-sticker-1");
  await preview(page).locator(".sticker-set-stage").click({ button: "right" });
  await page.getByRole("menuitem", { name: "导出贴纸", exact: true }).click();
  await expect.poll(() => exports(page)).toEqual([
    { fileIds: [94003], name: "export_test_003" }, { fileIds: [94002], name: "export_test_002" },
  ]);
});

for (const surface of ["picker", "preview"] as const) {
  test(`${surface} context menu consumes Escape and restores keyboard focus`, async ({ page }) => {
    await prepare(page);
    if (surface === "picker") await page.getByRole("button", { name: "表情", exact: true }).click();
    else await openPreview(page);
    const panel = surface === "picker" ? picker(page) : preview(page);
    const target = surface === "picker" ? panel.getByRole("button", { name: "发送贴纸 😊" }) : panel.locator(".sticker-set-list > button").nth(1);
    await target.focus();
    await target.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "导出贴纸", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(target).toBeFocused();
    expect(await exports(page)).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
}

test("cancelled folder selection shows no success or error and keeps the picker open", async ({ page }) => {
  await prepare(page, "cancelled");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await picker(page).getByRole("button", { name: "发送贴纸 😊" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "导出贴纸", exact: true }).click();
  await expect.poll(() => exports(page)).toHaveLength(1);
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator(".sticker-export-status")).toHaveCount(0);
});

test("an in-progress pack export prevents duplicate exports and reports completion", async ({ page }) => {
  await prepare(page, "pending");
  await openPreview(page);
  await preview(page).getByRole("button", { name: "导出贴纸包" }).click();
  await expect(preview(page).getByRole("button", { name: "导出贴纸包" })).toBeDisabled();
  await expect(preview(page).getByRole("status")).toHaveText("正在导出贴纸");
  await preview(page).locator(".sticker-set-list > button").nth(0).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "导出贴纸", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (globalThis as AuditWindow).stickerExportAudit.finish?.());
  await expect(preview(page).getByRole("status")).toHaveText("贴纸已导出");
  await expect(preview(page).getByRole("button", { name: "导出贴纸包" })).toBeEnabled();
  expect(await exports(page)).toHaveLength(1);
});

test("failed export reports an error and leaves the export button available", async ({ page }) => {
  await prepare(page, "failed");
  await openPreview(page);
  await preview(page).getByRole("button", { name: "导出贴纸包" }).click();
  await expect(preview(page).getByRole("alert")).toHaveText("导出贴纸失败");
  await expect(preview(page).getByRole("button", { name: "导出贴纸包" })).toBeEnabled();
});
