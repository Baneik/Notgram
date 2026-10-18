import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ComposerInputElement } from "../../src/components/ComposerInput";
import type { telegramStore as Store } from "../../src/store/telegramStore";
import { chooseMessageMenuItem, revealVirtualMessage } from "./helpers";

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

const watchSubmissions = async (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
  const { editMessage, sendMessage } = telegramStore.getState();
  document.body.dataset.editCalls = "0";
  document.body.dataset.sendCalls = "0";
  telegramStore.setState({
    editMessage: (...args) => {
      document.body.dataset.editCalls = String(Number(document.body.dataset.editCalls) + 1);
      return editMessage(...args);
    },
    sendMessage: (...args) => {
      document.body.dataset.sendCalls = String(Number(document.body.dataset.sendCalls) + 1);
      return sendMessage(...args);
    },
  });
});

const stagedTextFile = (page: Page, draftKey = "chat-product") => page.evaluate(async draftKey => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
  const attachments = await telegramStore.getState().loadLocalAttachmentDraft(draftKey);
  const file = attachments.at(-1)?.file;
  return file ? { name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) } : null;
}, draftKey);

for (const width of [1366, 390]) {
  test(`file format stages the selected UTF-8 text and keeps surrounding marks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const composer = input(page);
    await composer.focus();
    const selected = "中文🙂\n\n  second line\t";
    const text = `before ${selected} after`;
    await composer.fill(text);
    await select(composer, 0, text.length);
    await composer.press("Control+Shift+B");
    await select(composer, 7, 7 + selected.length);
    await composer.click({ button: "right" });
    await page.getByRole("menuitem", { name: "格式", exact: true }).hover();
    for (const [label, letter] of [["遮罩", "m"], ["删除线", "x"], ["下划线", "u"], ["粗体", "b"], ["引用", "q"], ["链接", "k"], ["文件", "f"]]) {
      const item = page.getByRole("menuitem", { name: label, exact: true });
      await expect(item.locator("span > small")).toHaveText(`[${letter}]`);
      await expect(item).toHaveAttribute("aria-keyshortcuts", `Control+Shift+${letter.toUpperCase()}`);
      expect(await item.locator("span").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await item.evaluate(element => parseFloat(getComputedStyle(element.querySelector("small")!).fontSize) <
        parseFloat(getComputedStyle(element.querySelector("span")!).fontSize))).toBe(true);
    }
    expect((await page.locator(".composer-format-menu").boundingBox())!.width).toBeLessThanOrEqual(150);
    await page.screenshot({ path: test.info().outputPath(`file-format-menu-${width}.png`) });
    await page.getByRole("menuitem", { name: "文件", exact: true }).click();
    const tray = page.getByRole("region", { name: "待发送附件" });
    await expect(tray.locator(".composer-attachment-item")).toHaveCount(1);
    await expect(tray).toContainText("text.txt");
    await expect(composer).toHaveJSProperty("value", "before  after");
    await expect(composer.locator("strong")).toHaveText("before  after");
    await expect(composer).toBeFocused();
    await expect.poll(() => stagedTextFile(page)).toEqual({ name: "text.txt", type: "text/plain;charset=utf-8",
      bytes: Array.from(new TextEncoder().encode(selected)) });
    await composer.press("Control+Z");
    await expect(composer).toHaveJSProperty("value", text);
    await expect(tray.locator(".composer-attachment-item")).toHaveCount(1);
    await composer.press("Control+Y");
    await expect(composer).toHaveJSProperty("value", "before  after");
    await expect.poll(() => page.evaluate(() => {
      const snapshot = JSON.parse(localStorage.getItem("notgram:ui-cache:v1") ?? "null");
      return snapshot?.drafts.find((draft: { chatId: string }) => draft.chatId === "chat-product")?.text;
    }), { timeout: 15_000 }).toBe("before  after");
    await page.reload();
    if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(tray).toContainText("text.txt");
    await expect(composer).toHaveJSProperty("value", "before  after");
    await expect.poll(() => stagedTextFile(page)).toMatchObject({ bytes: Array.from(new TextEncoder().encode(selected)) });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(tray).toHaveCount(0);
    await expect(page.locator(".message-row.is-outgoing").last()).toContainText("text.txt");
  });
}

test("file shortcut uses the visible selection and ignores empty selections and IME preedit", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("before 中文🙂 after");
  await composer.press("Control+Shift+F");
  await expect(page.getByRole("region", { name: "待发送附件" })).toHaveCount(0);
  await select(composer, 7, 11);
  await composer.dispatchEvent("keydown", { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true, isComposing: true });
  await expect(composer).toHaveJSProperty("value", "before 中文🙂 after");
  await expect(page.getByRole("region", { name: "待发送附件" })).toHaveCount(0);
  await composer.evaluate(element => {
    const text = element.querySelector("p")!.firstChild!;
    const range = document.createRange(); range.setStart(text, 7); range.setEnd(text, 11);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", code: "KeyF", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await expect(composer).toHaveJSProperty("value", "before  after");
  await expect.poll(() => stagedTextFile(page)).toMatchObject({ bytes: Array.from(new TextEncoder().encode("中文🙂")) });
});

test("file conversion retains the text when the attachment tray is full", async ({ page }) => {
  await ready(page);
  await page.locator('input[type="file"]').setInputFiles(Array.from({ length: 10 }, (_, index) => ({
    name: `existing-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("existing"),
  })));
  const tray = page.getByRole("region", { name: "待发送附件" });
  await expect(tray.locator(".composer-attachment-item")).toHaveCount(10);
  const composer = input(page);
  await composer.fill("must keep 中文🙂");
  await composer.press("Control+A");
  await composer.press("Control+Shift+F");
  await expect(composer).toHaveJSProperty("value", "must keep 中文🙂");
  await expect(tray.locator(".composer-attachment-item")).toHaveCount(10);
  await expect(page.getByText("一次最多发送 10 个附件", { exact: true })).toBeVisible();
});

test("file format is disabled while editing a message and its shortcut retains the edit", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("original text"); await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await composer.press("Control+A");
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "格式", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "文件", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await composer.press("Control+Shift+F");
  await expect(composer).toHaveJSProperty("value", "original text");
  await expect(page.getByRole("region", { name: "待发送附件" })).toHaveCount(0);
});

test("discussion editor stages file conversions in its own attachment draft", async ({ page }) => {
  await ready(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  const composer = panel.getByRole("textbox", { name: "消息内容" });
  await composer.fill("讨论附件🙂"); await composer.press("Control+A"); await composer.press("Control+Shift+F");
  await expect(composer).toHaveJSProperty("value", "");
  await expect(panel.getByRole("region", { name: "待发送附件" })).toContainText("text.txt");
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
    return [...telegramStore.getState().localAttachmentDrafts.keys()];
  })).toEqual([expect.stringContaining("discussion")]);
});

for (const exitKey of ["Control+r", "Escape"]) {
  test(`editing exits with ${exitKey} and restores the previous draft without submitting`, async ({ page }) => {
    await ready(page);
    const composer = input(page);
    await composer.fill("original message"); await composer.press("Enter");
    const row = page.locator(".message-row.is-outgoing").filter({ hasText: "original message" });
    await expect(row).toBeVisible();
    await composer.fill("saved draft");
    await select(composer, 0, 5); await composer.press("Control+Shift+B");
    await row.locator(".message-bubble-shell").click({ button: "right" });
    await chooseMessageMenuItem(page, "编辑");
    await expect(composer).toHaveJSProperty("value", "original message");
    await watchSubmissions(page);
    await composer.fill("unsaved changes");
    await composer.press(exitKey);
    await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
    await expect(composer).toHaveJSProperty("value", "saved draft");
    await expect(composer.locator("strong")).toHaveText("saved");
    await expect(composer).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "0");
    await expect(page.locator("body")).toHaveAttribute("data-send-calls", "0");
  });
}

test("Enter exits unchanged or reverted edits, while text and format changes are submitted", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("original 🙂\nsecond line"); await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  await watchSubmissions(page);
  for (const reverted of [false, true]) {
    await composer.press("Control+r");
    await expect(composer).toHaveJSProperty("value", "original 🙂\nsecond line");
    if (reverted) {
      await composer.fill("changed");
      await composer.fill("original 🙂\nsecond line");
      await expect(composer).toHaveJSProperty("value", "original 🙂\nsecond line");
      await select(composer, 0, 8);
      await composer.press("Control+Shift+B"); await composer.press("Control+Shift+B");
      await expect(composer.locator("strong")).toHaveCount(0);
    }
    await composer.press("Enter");
    await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
    await expect(composer).toHaveJSProperty("value", "");
    await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "0");
  }
  await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await composer.fill("changed message"); await composer.press("Enter");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "1");
  await composer.press("Control+r");
  await expect(composer).toHaveJSProperty("value", "changed message");
  await composer.press("Control+A"); await composer.press("Control+Shift+B"); await composer.press("Enter");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "2");
  await composer.press("Control+r");
  await expect(composer.locator("strong")).toHaveText("changed message");
  await composer.press("Control+A");
  await composer.press("Control+Shift+B"); await composer.press("Control+Shift+B");
  await composer.press("Enter");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "2");
  await expect(page.locator("body")).toHaveAttribute("data-send-calls", "0");
});

test("edit keys respect IME and key repeat; Enter exits even with Enter-to-send disabled", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("IME original"); await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await composer.dispatchEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, repeat: true });
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await composer.dispatchEvent("compositionstart");
  for (const key of ["Escape", "Enter", "r"]) {
    await composer.dispatchEvent("keydown", { key, code: key === "r" ? "KeyR" : key, ctrlKey: key === "r", isComposing: true });
  }
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await composer.dispatchEvent("compositionend");
  await page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("sendOnEnter", false);
  });
  await watchSubmissions(page);
  await composer.press("Shift+Enter");
  await expect(composer).toHaveJSProperty("value", "IME original\n");
  await composer.press("Backspace"); await composer.press("Enter");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "0");
});

test("unchanged empty captions and whitespace-preserving originals exit without an edit request", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("fixture message"); await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  await watchSubmissions(page);
  for (const caption of [false, true]) {
    await page.evaluate(async (caption) => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
      const messages = new Map(telegramStore.getState().messages);
      const rows = [...messages.get("chat-product")!];
      rows[rows.length - 1] = { ...rows.at(-1)!, content: caption
        ? { kind: "file", fileName: "example.txt", sizeLabel: "1 B", caption: "" }
        : { kind: "text", text: "  original with whitespace\n" } };
      messages.set("chat-product", rows);
      telegramStore.setState({ messages });
    }, caption);
    await composer.press("Control+r");
    await expect(page.locator(".composer-context.is-editing")).toBeVisible();
    await expect(composer).toHaveJSProperty("value", caption ? "" : "  original with whitespace\n");
    await composer.press("Enter");
    await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
    await expect(page.locator("body")).toHaveAttribute("data-edit-calls", "0");
  }
  await expect(page.locator("body")).toHaveAttribute("data-send-calls", "0");
});

test("IME preedit hides the placeholder through updates, commit and cancellation", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  const ime = await page.context().newCDPSession(page);
  const placeholder = () => composer.evaluate(element => getComputedStyle(element, "::before").content);
  await expect.poll(placeholder).toBe('"写一条消息"');
  for (const text of ["n", "ni"]) {
    await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await expect(composer).toHaveText(text);
    await expect.poll(placeholder).toBe("none");
  }
  await ime.send("Input.insertText", { text: "你" });
  await expect(composer).toHaveJSProperty("value", "你");
  await expect.poll(placeholder).toBe("none");
  await composer.press("Control+A");
  await composer.press("Backspace");
  await expect.poll(placeholder).toBe('"写一条消息"');
  await ime.send("Input.imeSetComposition", { text: "hao", selectionStart: 3, selectionEnd: 3 });
  await expect.poll(placeholder).toBe("none");
  await ime.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await expect(composer).toHaveJSProperty("value", "");
  await expect.poll(placeholder).toBe('"写一条消息"');
});

for (const [key, kind] of [["M", "spoiler"], ["X", "strikethrough"], ["U", "underline"], ["B", "bold"], ["Q", "blockquote"], ["K", "link"]]) {
  test(`format shortcut ${key} flushes a pending browser selection`, async ({ page }) => {
    await ready(page);
    const composer = input(page);
    await composer.fill("selected text");
    await composer.evaluate((element, letter) => {
      // Selection changes can still be queued when a keydown reaches the editor.
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("p")!);
      const selection = getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: letter, code: `Key${letter}`, keyCode: letter.charCodeAt(0),
        ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    }, key);
    if (kind === "link") await expect(composer).toHaveJSProperty("value", "[selected text]()");
    else await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("selected text");
  });

  test(`format shortcut ${key} uses a keyboard selection after IME commit`, async ({ page }) => {
    await ready(page);
    const composer = input(page);
    const ime = await page.context().newCDPSession(page);
    await ime.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
    await ime.send("Input.insertText", { text: "你好" });
    await composer.press("Control+A");
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("你好");
    await composer.press(`Control+Shift+${key}`);
    if (kind === "link") await expect(composer).toHaveJSProperty("value", "[你好]()");
    else await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("你好");
  });
}

test("format shortcuts recognize physical letters when an IME reports Process", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("选中文字");
  await composer.press("Control+A");
  await expect(composer).toHaveJSProperty("selectionStart", 0);
  for (const [key, kind] of [["M", "spoiler"], ["X", "strikethrough"], ["U", "underline"], ["B", "bold"], ["Q", "blockquote"], ["K", "link"]]) {
    await composer.dispatchEvent("keydown", { key: "Process", code: `Key${key}`, keyCode: 229, ctrlKey: true, shiftKey: true });
    if (kind === "link") await expect(composer).toHaveJSProperty("value", "[选中文字]()");
    else await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("选中文字");
  }
});

test("IME owns candidate Enter and formatting keys until composition ends", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "ni", selectionStart: 0, selectionEnd: 2 });
  for (const key of ["M", "X", "U", "B", "Q", "K"]) {
    await composer.dispatchEvent("keydown", { key, code: `Key${key}`, ctrlKey: true, shiftKey: true, isComposing: true });
  }
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  await expect(composer).toHaveText("ni");
  await expect(composer.locator("[data-composer-entity]")).toHaveCount(0);
  await ime.send("Input.insertText", { text: "你" });
  await expect(composer).toHaveJSProperty("value", "你");
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  await expect(page.locator(".message-row.is-outgoing").filter({ hasText: "你" }).last()).toBeVisible();
});

test("format shortcuts preserve a partial mouse selection and leave other text alone", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("before 选中 text after");
  const bounds = await composer.evaluate(element => {
    const range = document.createRange();
    const text = element.querySelector("p")!.firstChild!;
    range.setStart(text, 7); range.setEnd(text, 9);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.right, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.left, bounds.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("选中");
  for (const [key, kind] of [["M", "spoiler"], ["X", "strikethrough"], ["U", "underline"], ["B", "bold"], ["Q", "blockquote"]]) {
    await composer.press(`Control+Shift+${key}`);
    await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("选中");
  }
  await composer.press("Control+Shift+K");
  await expect(composer).toHaveJSProperty("value", "before [选中]() text after");
  await expect(composer).toBeFocused();
});

test("Ctrl+A uses text boundaries when inserting a link from the menu", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("全部文字");
  await composer.press("Control+A");
  await expect(composer).toHaveJSProperty("selectionStart", 0);
  await expect(composer).toHaveJSProperty("selectionEnd", 4);
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "格式", exact: true }).hover();
  await page.getByRole("menuitem", { name: "链接", exact: true }).click();
  await expect(composer).toHaveJSProperty("value", "[全部文字]()");
  await expect(composer).toHaveJSProperty("selectionStart", 7);
});

test("discussion editor shares IME placeholder and format shortcut behavior", async ({ page }) => {
  await ready(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const composer = page.locator(".channel-discussion-panel").getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "liuyan", selectionStart: 6, selectionEnd: 6 });
  await expect(composer).toHaveText("liuyan");
  expect(await composer.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none");
  await ime.send("Input.insertText", { text: "留言" });
  await composer.press("Control+A");
  await composer.press("Control+Shift+B");
  await expect(composer.locator("strong")).toHaveText("留言");
  await expect(composer).toBeFocused();
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
});

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

test("context paste stages clipboard images instead of inserting their fallback text", async ({ page }) => {
  await page.addInitScript(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), character => character.charCodeAt(0));
    Object.defineProperty(navigator, "clipboard", { value: {
      read: async () => [{ types: ["text/plain", "image/png"], getType: async (type: string) =>
        type === "image/png" ? new Blob([bytes], { type }) : new Blob(["image fallback"], { type }) }],
      readText: async () => "image fallback",
    } });
  });
  await ready(page);
  const composer = input(page);
  await composer.fill("retain caption");
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
  const attachments = page.getByRole("region", { name: "待发送附件" });
  await expect(attachments.locator(".composer-attachment-item")).toHaveCount(1);
  await expect(attachments.locator("img")).toBeVisible();
  await expect(composer).toHaveJSProperty("value", "retain caption");
  await expect(composer).toBeFocused();
});

test("dropping external multiline text uses the drop caret and keeps it plain", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("before after");
  await select(composer, 0, 6);
  await composer.evaluate(element => {
    const paragraph = element.querySelector("p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 7); range.collapse(true);
    const caret = range.getBoundingClientRect();
    const data = new DataTransfer();
    data.setData("text/plain", "line one\r\nline two");
    data.setData("text/html", "<p><strong>line one</strong></p><p>line two</p>");
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true,
      dataTransfer: data, clientX: caret.x, clientY: caret.y + caret.height / 2 }));
  });
  await expect(composer).toHaveJSProperty("value", "before line one\nline twoafter");
  await expect(composer.locator("strong")).toHaveCount(0);
  await expect(composer).toHaveJSProperty("selectionStart", "before line one\nline two".length);
  await composer.press("Control+z");
  await expect(composer).toHaveJSProperty("value", "before after");
});

test("dropping a file on the editor stages it once without inserting its URL", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("retain caption");
  await composer.evaluate(element => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), character => character.charCodeAt(0));
    data.items.add(new File([bytes], "editor-drop.png", { type: "image/png" }));
    data.setData("text/plain", "file:///private/editor-drop.png");
    data.setData("text/html", '<img src="file:///private/editor-drop.png">');
    const rect = element.getBoundingClientRect();
    for (const type of ["dragenter", "dragover", "drop"]) element.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.x + 10, clientY: rect.y + 10,
    }));
  });
  await expect(page.getByRole("region", { name: "待发送附件" }).locator(".composer-attachment-item")).toHaveCount(1);
  await expect(composer).toHaveJSProperty("value", "retain caption");
  await expect(page.locator(".composer-wrap")).not.toHaveClass(/is-file-dragging/);
});

test("context paste reads an actual PNG clipboard item", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  const composer = input(page);
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
  await expect(page.getByRole("region", { name: "待发送附件" }).locator("img")).toBeVisible();
  await expect(composer).toHaveJSProperty("value", "");
  await expect(page.locator(".composer-clipboard-error")).toHaveCount(0);
});

for (const destination of ["typing", "search", "conversation"] as const) {
  test(`a delayed context paste yields to ${destination}`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: {
        readText: () => new Promise<string>(resolve => {
          Object.assign(window, { __releaseClipboard: () => {
            resolve("late clipboard");
            document.body.dataset.clipboardReleased = "true";
          } });
          document.body.dataset.clipboardWaiting = "true";
        }),
      } });
    });
    await ready(page);
    const composer = input(page);
    await composer.fill("retain draft");
    await composer.click({ button: "right" });
    await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-clipboard-waiting", "true");
    const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
    if (destination === "typing") { await composer.focus(); await composer.press("End"); await composer.pressSequentially(" newer"); }
    else if (destination === "search") await search.click();
    else await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
    await page.evaluate(async () => {
      (window as unknown as { __releaseClipboard: () => void }).__releaseClipboard();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await expect(composer).toHaveJSProperty("value", destination === "typing" ? "retain draft newer" : destination === "search" ? "retain draft" : "");
    await expect(page.locator(".composer-clipboard-error")).toHaveCount(0);
    if (destination === "search") await expect(search).toBeFocused();
    else await expect(composer).toBeFocused();
  });
}

test("an empty context clipboard leaves the selected text intact", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "" } }));
  await ready(page);
  const composer = input(page);
  await composer.fill("retain selected text");
  await select(composer, 0, 6);
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "粘贴", exact: true }).click();
  await expect(composer).toHaveJSProperty("value", "retain selected text");
  await expect(composer).toHaveJSProperty("selectionStart", 0);
  await expect(composer).toHaveJSProperty("selectionEnd", 6);
  await expect(composer).toBeFocused();
});

for (const width of [1366, 390]) {
  test(`dragging a displayed image to the composer stages an image at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.goto("/");
    if (width < 680) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const composer = input(page);
    await composer.click();
    await composer.fill("image caption");
    await page.evaluate(width => {
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = "connect-src 'self'; img-src 'self' data: blob:";
      document.head.append(policy);
      const source = document.createElement("img");
      source.id = "image-drag-source";
      source.alt = "Drag source";
      source.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      if (width === 390) {
        const bytes = Uint8Array.from(atob(source.src.split(",")[1]), character => character.charCodeAt(0));
        source.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      }
      source.style.cssText = "position:fixed;left:120px;top:150px;width:80px;height:80px;z-index:9999";
      document.body.append(source);
    }, width);
    await page.locator("#image-drag-source").dragTo(composer);
    const attachments = page.getByRole("region", { name: "待发送附件" });
    await expect(attachments.locator(".composer-attachment-item")).toHaveCount(1);
    await expect(attachments.locator("img")).toBeVisible();
    await expect(composer).toHaveJSProperty("value", "image caption");
    await expect(composer).toBeFocused();
    await page.locator("#image-drag-source").evaluate(element => element.remove());
    await page.screenshot({ path: test.info().outputPath(`composer-image-drop-${width}.png`) });
  });
}

test("dropping an external image URL does not fetch it or insert a URL fallback", async ({ page }) => {
  let requests = 0;
  await page.route("https://external.test/**", route => { requests++; return route.abort(); });
  await ready(page);
  const composer = input(page);
  await composer.fill("retain draft");
  await composer.evaluate(element => {
    const data = new DataTransfer();
    data.setData("text/html", '<img src="https://external.test/image.png">');
    data.setData("text/plain", "https://external.test/image.png");
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await expect(page.getByRole("alert")).toHaveText("无法读取拖入的图片，请将图片保存为文件后拖入");
  await expect(composer).toHaveJSProperty("value", "retain draft");
  await expect(page.getByRole("region", { name: "待发送附件" })).toHaveCount(0);
  expect(requests).toBe(0);
});

test("protected message content cannot start an image or text drag", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4"
      ? { ...message, canSave: false } : message));
    telegramStore.setState({ messages });
  });
  await revealVirtualMessage(page, "p-4");
  const source = page.locator('[data-message-id="p-4"] .message-bubble-shell');
  expect(await source.evaluate(element => element.dispatchEvent(new DragEvent("dragstart", {
    bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
  })))).toBe(false);
});

test("Ctrl+R replaces ArrowUp for editing the latest visible outgoing message and leaves drafts alone", async ({ page }) => {
  await ready(page);
  const composer = input(page);
  await composer.fill("latest visible edit"); await composer.press("Enter");
  await expect(page.locator(".message-row.is-outgoing").filter({ hasText: "latest visible edit" })).toBeVisible();
  await composer.press("ArrowUp");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await expect(composer).toHaveJSProperty("value", "latest visible edit");
  await expect(composer).toHaveJSProperty("selectionStart", 19);
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await composer.fill("draft"); await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(composer).toHaveJSProperty("value", "draft");
});

test("Ctrl+R ignores outgoing messages outside the viewport, then edits a visible older one", async ({ page }) => {
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
  await input(page).focus(); await input(page).press("Control+r");
  await expect(input(page)).toHaveJSProperty("value", "");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await revealVirtualMessage(page, "visible-edit-30");
  await input(page).focus(); await input(page).press("Control+r");
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
  await composer.press("Control+r");
  await expect(panel.locator(".composer-context.is-editing")).toBeVisible();
  await expect(composer.locator("strong")).toHaveText("discussion");
  await composer.press("Escape");
  await expect(panel.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(composer).toHaveJSProperty("value", "");
  await expect(composer).toBeFocused();
});
