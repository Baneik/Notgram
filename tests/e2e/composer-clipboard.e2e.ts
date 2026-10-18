import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ComposerInputElement } from "../../src/components/ComposerInput";

const input = (page: Page) => page.getByRole("textbox", { name: "消息内容" });
const select = async (composer: Locator, start: number, end: number) => {
  await composer.focus();
  await composer.evaluate((element, range) => (element as ComposerInputElement).setSelectionRange(...range), [start, end] as [number, number]);
};
const ready = async (page: Page, width = 1366) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await input(page).focus();
  await expect(input(page)).toBeFocused();
};
const clipboardText = (page: Page) => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n"));
const paste = (composer: Locator, text: string) => composer.evaluate((element, value) => {
  const data = new DataTransfer(); data.setData("text/plain", value);
  element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
}, text);
const menuAction = async (page: Page, composer: Locator, name: string) => {
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(composer).toBeFocused();
};

for (const width of [1366, 390]) {
  test(`keyboard copy preserves typed trailing and consecutive newlines at ${width}px`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page, width);
    const composer = input(page);
    await composer.press("Shift+Enter");
    await composer.pressSequentially("first");
    await composer.press("Shift+Enter");
    await composer.press("Shift+Enter");
    await page.keyboard.insertText("中文🙂\t  last");
    await composer.press("Shift+Enter");
    await composer.press("Shift+Enter");
    const expected = "\nfirst\n\n中文🙂\t  last\n\n";
    await expect(composer).toHaveJSProperty("value", expected);
    await composer.press("Control+A"); await composer.press("Control+C");
    await expect.poll(() => clipboardText(page)).toBe(expected);
    await menuAction(page, composer, "复制");
    await expect.poll(() => clipboardText(page)).toBe(expected);
    await expect(composer).toHaveJSProperty("value", expected);
  });
}

test("keyboard copy preserves newline-only and partial reverse selections without extra text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  const composer = input(page);
  for (const text of ["\n", "\n\n", "\n  \t\n"]) {
    await composer.fill(text); await composer.press("Control+A"); await composer.press("Control+C");
    await expect.poll(() => clipboardText(page)).toBe(text);
  }
  const text = "before 中文🙂\n\nsecond\nafter";
  await composer.fill(text);
  await select(composer, 7, text.length - 5);
  await composer.press("Control+Shift+B");
  await select(composer, text.length - 5, 7);
  await composer.press("Control+C");
  await expect.poll(() => clipboardText(page)).toBe("中文🙂\n\nsecond\n");
  await expect(composer).toHaveJSProperty("value", text);
});

for (const method of ["keyboard", "menu"] as const) {
  test(`${method} cut retains selected newlines and undo restores text and formatting`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page);
    const composer = input(page);
    const selected = "中文🙂\n\n";
    const text = `before ${selected}after`;
    await composer.fill(text);
    await select(composer, 7, 7 + selected.length); await composer.press("Control+Shift+B");
    if (method === "keyboard") await composer.press("Control+X");
    else await menuAction(page, composer, "剪切");
    await expect(composer).toHaveJSProperty("value", "before after");
    await expect.poll(() => clipboardText(page)).toBe(selected);
    await composer.press("Control+Z");
    await expect(composer).toHaveJSProperty("value", text);
    await expect(composer.locator("strong")).toHaveText("中文🙂");
    await composer.press("Control+Y");
    await expect(composer).toHaveJSProperty("value", "before after");
  });
}

test("keyboard paste normalizes line endings, replaces only the selection and preserves surrounding marks", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  const composer = input(page);
  await composer.fill("before selected after");
  await composer.press("Control+A"); await composer.press("Control+Shift+B");
  await select(composer, 7, 15);
  await page.evaluate(() => navigator.clipboard.writeText("中文🙂\r\n\rnext\n\n"));
  await composer.press("Control+V");
  await expect(composer).toHaveJSProperty("value", "before 中文🙂\n\nnext\n\n after");
  await expect(composer.locator("strong")).toContainText("before 中文🙂");
  await composer.press("Control+Z");
  await expect(composer).toHaveJSProperty("value", "before selected after");
  await expect(composer.locator("strong")).toHaveText("before selected after");
});

for (const method of ["keyboard", "menu"] as const) {
  test(`${method} paste has its own undo boundary between adjacent typing and pastes`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page);
    const composer = input(page);
    await composer.pressSequentially("before");
    const pasteText = async (text: string) => {
      await page.evaluate(text => navigator.clipboard.writeText(text), text);
      if (method === "keyboard") await composer.press("Control+V");
      else await menuAction(page, composer, "粘贴");
    };
    await pasteText(" first\n");
    await expect(composer).toHaveJSProperty("value", "before first\n");
    await pasteText("second\n");
    await composer.pressSequentially("after");
    await expect(composer).toHaveJSProperty("value", "before first\nsecond\nafter");
    for (const expected of ["before first\nsecond\n", "before first\n", "before", ""]) {
      await composer.press("Control+Z");
      await expect(composer).toHaveJSProperty("value", expected);
    }
    for (const expected of ["before", "before first\n", "before first\nsecond\n", "before first\nsecond\nafter"]) {
      await composer.press("Control+Y");
      await expect(composer).toHaveJSProperty("value", expected);
    }
  });
}

test("empty paste leaves a selection intact and multiline deletion is reversible", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  const text = "中文🙂\n\nlast\n";
  await composer.fill(text);
  // Restore a draft so its original insertion is outside this editor's undo history.
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(composer).toHaveJSProperty("value", text);
  await select(composer, 0, 4);
  await paste(composer, "");
  await expect(composer).toHaveJSProperty("value", text);
  await composer.press("Control+A"); await composer.press("Backspace");
  await expect(composer).toHaveJSProperty("value", "");
  await expect(composer).toHaveAttribute("data-empty", "true");
  await composer.press("Control+Z");
  await expect(composer).toHaveJSProperty("value", text);
  await select(composer, text.length, text.length);
  await composer.press("Backspace");
  await expect(composer).toHaveJSProperty("value", text.slice(0, -1));
  await composer.press("Control+Z");
  await expect(composer).toHaveJSProperty("value", text);
});

test("switching drafts preserves trailing newlines and isolates undo history", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  const composer = input(page);
  const text = "草稿🙂\n\n";
  await composer.fill(text);
  await select(composer, 0, text.length); await composer.press("Control+Shift+U");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveJSProperty("value", "");
  await composer.press("Control+Z");
  await expect(composer).toHaveJSProperty("value", "");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(composer).toHaveJSProperty("value", text);
  await expect(composer.locator("u")).toHaveText("草稿🙂");
  await expect(composer).toHaveJSProperty("selectionStart", text.length);
  await composer.press("Control+A"); await composer.press("Control+C");
  await expect.poll(() => clipboardText(page)).toBe(text);
});

test("discussion clipboard preserves trailing newlines in the active editor", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const composer = page.locator(".channel-discussion-panel").getByRole("textbox", { name: "消息内容" });
  const text = "讨论🙂\n\n";
  await composer.fill(text); await composer.press("Control+A"); await composer.press("Control+X");
  await expect.poll(() => clipboardText(page)).toBe(text);
  await expect(composer).toHaveJSProperty("value", "");
  await composer.press("Control+V");
  await expect(composer).toHaveJSProperty("value", text);
  await expect(composer).toBeFocused();
});
