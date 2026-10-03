import { expect, test, type Page } from "@playwright/test";

const preview = (page: Page) => page.getByRole("region", { name: "待发送附件" });
const composer = (page: Page) => page.getByRole("textbox", { name: "消息内容" });
const image = {
  name: "staged-image.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
};
const localDraft = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
  return telegramStore.getState().localAttachmentDrafts.get("chat-product") ?? null;
});
const persistedDraft = (page: Page) => page.evaluate(() => {
  const snapshot = JSON.parse(localStorage.getItem("notgram:ui-cache:v1") ?? "null");
  return {
    attachment: snapshot?.localAttachmentDrafts.find((draft: { draftKey: string }) => draft.draftKey === "chat-product") ?? null,
    text: snapshot?.drafts.find((draft: { chatId: string }) => draft.chatId === "chat-product")?.text ?? "",
  };
});
const stage = async (page: Page) => {
  await page.goto("/");
  await expect(composer(page)).toBeFocused();
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(preview(page)).toBeVisible();
  await expect.poll(() => localDraft(page)).not.toBeNull();
  await expect(composer(page)).toBeFocused();
};

test("attachment staging removes redundant rows and keeps the composer send action", async ({ page }) => {
  await stage(page);
  await expect(preview(page).locator("header, footer")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送附件", exact: true })).toHaveCount(0);
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
  await composer(page).fill("staged caption");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  await expect(page.getByRole("log").getByText("staged caption", { exact: true })).toBeVisible();
});

test("Tab toggles media mode, persists options and ignores key repeat", async ({ page }) => {
  await stage(page);
  await preview(page).getByRole("checkbox", { name: "剧透" }).check();
  await composer(page).focus();
  await composer(page).press("Tab");
  await expect(composer(page)).toBeFocused();
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await expect(preview(page).getByRole("checkbox", { name: "剧透" })).not.toBeChecked();
  await expect.poll(() => localDraft(page)).toMatchObject({ mode: "file", hasSpoiler: false, muteVideos: false });
  await composer(page).dispatchEvent("keydown", { key: "Tab", code: "Tab", repeat: true });
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await expect.poll(() => persistedDraft(page), { timeout: 15_000 }).toMatchObject({ attachment: { mode: "file" } });
  await page.reload();
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await composer(page).focus();
  await composer(page).press("Tab");
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
  await expect.poll(() => localDraft(page)).toMatchObject({ mode: "media" });
  await preview(page).getByRole("radio", { name: "媒体", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await composer(page).fill("original file caption");
  await composer(page).press("Enter");
  await expect(preview(page)).toHaveCount(0);
  await expect(page.getByText("staged-image.png", { exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("original file caption", { exact: true })).toBeVisible();
});

test("Escape discards all staged files, preserves the caption and restores editor focus", async ({ page }) => {
  await stage(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "staged-note.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
  await expect(preview(page).locator("article")).toHaveCount(2);
  await composer(page).fill("keep this caption");
  await preview(page).getByRole("radio", { name: "原文件", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveJSProperty("value", "keep this caption");
  await expect.poll(() => localDraft(page)).toBeNull();
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().drafts.get("chat-product")?.text;
  })).toBe("keep this caption");
  await expect.poll(() => persistedDraft(page), { timeout: 15_000 }).toEqual({ attachment: null, text: "keep this caption" });
  await page.reload();
  await expect(composer(page)).toHaveJSProperty("value", "keep this caption");
  await expect(preview(page)).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
  await composer(page).press("Escape");
  await expect(preview(page)).toHaveCount(0);
});

test("staging shortcuts preserve IME, completion, modified Tab and modal ownership", async ({ page }) => {
  await stage(page);
  await composer(page).dispatchEvent("compositionstart", { data: "中" });
  await composer(page).dispatchEvent("keydown", { key: "Tab", code: "Tab", isComposing: true });
  await composer(page).dispatchEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229 });
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
  await composer(page).dispatchEvent("compositionend", { data: "中" });
  await composer(page).press("Shift+Tab");
  await expect(composer(page)).toBeFocused();
  await composer(page).fill("/sta");
  await expect(page.getByRole("listbox", { name: "机器人命令建议" })).toBeVisible();
  await composer(page).press("Tab");
  await expect(composer(page)).toHaveJSProperty("value", "/start@notgram_bot ");
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect.poll(() => localDraft(page)).toMatchObject({ mode: "media" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
  await composer(page).focus();
  await composer(page).press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await composer(page).press("Tab");
  await expect(composer(page)).toBeFocused();
});

test("media mode binding can be rebound, cleared and reset to local Tab", async ({ page }) => {
  await page.route("**/src/shortcuts/shortcutAvailability.ts", route => route.fulfill({
    contentType: "application/javascript", body: "export const checkShortcutAvailability = async () => 'available';",
  }));
  await stage(page);
  const settings = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
  };
  const field = page.getByRole("button", { name: "切换媒体发送模式", exact: true });
  await settings();
  await expect(field).toHaveText("Tab");
  await field.click();
  await page.keyboard.press("Control+Shift+g");
  await expect(field).toHaveText("Ctrl + Shift + G");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await composer(page).focus();
  await composer(page).press("Tab");
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
  await composer(page).focus();
  await composer(page).press("Control+Shift+g");
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await expect.poll(() => persistedDraft(page), { timeout: 15_000 }).toMatchObject({ attachment: { mode: "file" } });
  await page.reload();
  await settings();
  await expect(field).toHaveText("Ctrl + Shift + G");
  await page.getByRole("button", { name: "清除切换媒体发送模式快捷键", exact: true }).click();
  await expect(field).toHaveText("未设置");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await composer(page).focus();
  await composer(page).press("Control+Shift+g");
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await settings();
  await page.getByRole("button", { name: "重置切换媒体发送模式快捷键", exact: true }).click();
  await expect(field).toHaveText("Tab");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await composer(page).focus();
  await composer(page).press("Tab");
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeChecked();
});

test("file-only batches keep existing Tab behavior and the limit warning stays visible", async ({ page }) => {
  await page.goto("/");
  await expect(composer(page)).toBeFocused();
  await page.locator('input[type="file"]').setInputFiles(Array.from({ length: 11 }, (_, index) => ({
    name: `staged-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("note"),
  })));
  await expect(preview(page).locator("article")).toHaveCount(10);
  await expect(preview(page).getByRole("alert")).toHaveText("一次最多发送 10 个附件");
  await expect.poll(() => localDraft(page)).not.toBeNull();
  await expect(page.getByRole("button", { name: "添加附件", exact: true })).toBeEnabled();
  await composer(page).press("Tab");
  await expect(composer(page)).toBeFocused();
  await expect(preview(page).getByRole("radio", { name: "媒体", exact: true })).toBeDisabled();
  await expect(preview(page).getByRole("radio", { name: "原文件", exact: true })).toBeChecked();
  await composer(page).focus();
  await composer(page).press("Escape");
  await expect(preview(page)).toHaveCount(0);
});

test("bare Tab can be recorded for media mode locally and remains reserved for navigation", async ({ page }) => {
  await page.goto("/");
  await expect(composer(page)).toBeFocused();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索设置" }).fill("切换媒体发送模式");
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
  const field = page.getByRole("button", { name: "切换媒体发送模式", exact: true });
  await page.getByRole("button", { name: "清除切换媒体发送模式快捷键", exact: true }).click();
  await expect(field).toHaveText("未设置");
  await field.click();
  await page.keyboard.press("Tab");
  await expect(field).toHaveText("Tab");
  await page.getByRole("button", { name: "上一个会话", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("alert")).toHaveText("此快捷键已被应用占用");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
  await expect(field).toHaveText("Tab");
});

test("compact staging fits narrow, scaled and dark layouts", async ({ page }) => {
  await stage(page);
  for (const layout of [
    { width: 1366, height: 768, themeId: "notgram-light", interfaceScale: 100 },
    { width: 390, height: 660, themeId: "notgram-dark", interfaceScale: 100 },
    { width: 1024, height: 768, themeId: "notgram-light", interfaceScale: 125 },
  ] as const) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    if (layout.width === 390) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await page.evaluate(async ({ themeId, interfaceScale }) => {
      const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("themeId", themeId);
      preferencesStore.getState().setPreference("interfaceScale", interfaceScale);
    }, layout);
    await expect.poll(() => preview(page).evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const card = element.querySelector("article")!.getBoundingClientRect();
      const options = element.querySelector(".composer-attachment-options")!.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && bounds.top >= 0 &&
        bounds.bottom <= innerHeight && card.top - bounds.top < 18 && bounds.bottom - options.bottom < 18;
    })).toBe(true);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeInViewport();
    await page.screenshot({ path: `artifacts/attachment-staging-${layout.width}-${layout.interfaceScale}.png` });
  }
});
