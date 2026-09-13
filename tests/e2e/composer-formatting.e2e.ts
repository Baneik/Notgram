import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ComposerInputElement } from "../../src/components/ComposerInput";
import type { telegramStore as Store } from "../../src/store/telegramStore";
import { revealVirtualMessage } from "./helpers";

const input = (page: Page) => page.getByRole("textbox", { name: "消息内容" });
const select = async (composer: Locator, start: number, end: number) => {
  await composer.focus();
  await composer.evaluate((element, range) => (element as ComposerInputElement).setSelectionRange(...range), [start, end] as [number, number]);
};
const ready = async (page: Page) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(input(page)).toBeFocused();
};
const paste = async (composer: Locator, text: string) => composer.evaluate((element, value) => {
  const data = new DataTransfer(); data.setData("text/plain", value);
  element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
}, text);

for (const [label, key, kind] of [
  ["遮罩", "M", "spoiler"], ["删除线", "X", "strikethrough"], ["下划线", "U", "underline"],
  ["粗体", "B", "bold"], ["引用", "Q", "blockquote"],
]) {
  test(`previews, toggles, persists and sends ${label} from a selection`, async ({ page }) => {
    await ready(page);
    const composer = input(page);
    await composer.fill("🙂 selected text");
    await select(composer, 3, 11);
    await composer.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "输入框操作", exact: true });
    await expect(menu.locator("kbd")).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "格式", exact: true }).hover();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("selected");
    await expect(composer).toBeFocused();
    await composer.press(`Control+Shift+${key}`);
    await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveCount(0);
    await composer.press(`Control+Shift+${key}`);
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("selected");
    await expect(composer).toHaveJSProperty("selectionStart", 16);
    await composer.press("Enter");
    await expect(composer).toHaveJSProperty("value", "");
    await expect.poll(() => page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
      const message = telegramStore.getState().messages.get("chat-product")?.at(-1);
      return message?.content.kind === "text" ? message.content.entities : [];
    })).toContainEqual({ kind, offset: 3, length: 8 });
  });
}

test("overlapping styles survive editing inside a span and undo/redo", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("hello world");
  await select(composer, 0, 5); await composer.press("Control+Shift+B");
  await composer.press("Control+Shift+U");
  await select(composer, 2, 2); await composer.press("i");
  await expect(composer.locator("strong u")).toHaveText("heillo");
  await composer.press("Control+Z");
  await expect(composer.locator("strong u")).toHaveText("hello");
  await composer.press("Control+Y");
  await expect(composer.locator("strong u")).toHaveText("heillo");
});

test("link shortcut inserts a template and paste exits the parentheses", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("before selected after");
  await select(composer, 7, 15); await composer.press("Control+Shift+K");
  await expect(composer).toHaveJSProperty("value", "before [selected]() after");
  await expect(composer).toHaveJSProperty("selectionStart", 18);
  await paste(composer, "https://example.test");
  await expect(composer).toHaveJSProperty("value", "before [selected](https://example.test) after");
  await expect(composer).toHaveJSProperty("selectionStart", "before [selected](https://example.test) after".length);
  await composer.press("!");
  await expect(composer).toHaveJSProperty("value", "before [selected](https://example.test) after!");
});

test("context clipboard actions preserve selection and paste at the saved caret", async ({ page }) => {
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async (text: string) => { copied = text; }, readText: async () => copied,
    } });
  });
  await ready(page);
  const composer = input(page);
  await composer.fill("hello world");
  await select(composer, 0, 5); await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "剪切", exact: true }).click();
  await expect(composer).toHaveJSProperty("value", " world");
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
  await expect(composer).toHaveJSProperty("value", "hello world");
  await select(composer, 0, 5); await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect(composer).toHaveJSProperty("value", "hello world");
});

test("ArrowUp edits only the latest visible outgoing message and leaves drafts alone", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("latest visible edit"); await composer.press("Enter");
  await expect(page.locator(".message-row.is-outgoing").filter({ hasText: "latest visible edit" })).toBeVisible();
  await composer.press("ArrowUp");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await expect(composer).toHaveJSProperty("value", "latest visible edit");
  await expect(composer).toHaveJSProperty("selectionStart", 19);
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await composer.fill("draft"); await composer.press("ArrowUp");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(composer).toHaveJSProperty("value", "draft");
});

test("ArrowUp ignores outgoing messages outside the viewport, then edits a visible older one", async ({ page }) => {
  await ready(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
    const state = telegramStore.getState();
    const original = state.messages.get("chat-mia")!.at(-1)!;
    const messages = new Map(state.messages);
    messages.set("chat-mia", Array.from({ length: 60 }, (_, index) => ({
      ...original, id: `visible-edit-${index}`, outgoing: index === 0 || index === 30,
      senderId: index === 0 || index === 30 ? "u-self" : "u-mia",
      sentAt: new Date(Date.now() + index * 1000).toISOString(),
      permissions: { canEdit: true, canReply: true, canForward: true, canDeleteOnlyForSelf: true, canDeleteForAllUsers: true },
      content: { kind: "text", text: `row ${index}\nsecond line\nthird line` },
    })));
    telegramStore.setState({ messages });
  });
  await expect.poll(() => page.locator(".message-list").evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return Boolean(element.querySelector('[data-message-id="visible-edit-59"]'));
  })).toBe(true);
  await revealVirtualMessage(page, "visible-edit-59");
  await input(page).focus(); await input(page).press("ArrowUp");
  await expect(input(page)).toHaveJSProperty("value", "");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await revealVirtualMessage(page, "visible-edit-30");
  await input(page).focus(); await input(page).press("ArrowUp");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await expect(input(page)).toHaveJSProperty("value", "row 30\nsecond line\nthird line");
});

test("discussion drafts restore formatting and the caret at the end", async ({ page }) => {
  await ready(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  const open = page.locator('[data-message-id="release-post-1"] .channel-post-discussion');
  await open.click();
  const panel = page.locator(".channel-discussion-panel");
  const composer = panel.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();
  await composer.fill("discussion draft");
  await select(composer, 0, 10); await composer.press("Control+Shift+B");
  await panel.getByRole("button", { name: "返回频道", exact: true }).click();
  await open.click();
  await expect(composer).toBeFocused();
  await expect(composer.locator("strong")).toHaveText("discussion");
  await expect(composer).toHaveJSProperty("selectionStart", "discussion draft".length);
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  await composer.press("ArrowUp");
  await expect(panel.locator(".composer-context.is-editing")).toBeVisible();
  await expect(composer.locator("strong")).toHaveText("discussion");
});
