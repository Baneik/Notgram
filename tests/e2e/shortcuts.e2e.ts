import { expect, test, type Page } from "@playwright/test";
import { scrollAwayFromBottom, visibleMessageAnchor } from "./helpers";

const state = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
  const current = telegramStore.getState();
  return { chat: current.activeChatId ?? null, folder: current.chatFilter };
});
const ready = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
};
const rows = (page: Page) => page.locator('.chat-list[data-active="true"] [data-chat-id]');
const rowIds = (page: Page) => rows(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-chat-id")!));
const recorder = (page: Page, name = "上一个会话") => page.getByRole("button", { name, exact: true });
const settings = async (page: Page) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
};
const mockProbe = async (page: Page) => {
  await page.route("**/src/shortcuts/shortcutAvailability.ts", route => route.fulfill({
    contentType: "application/javascript",
    body: `export const checkShortcutAvailability = async binding => {
      document.body.dataset.probeBinding = binding;
      if (document.body.dataset.probeResult === 'delay') return new Promise(resolve => window.finishShortcutProbe = resolve);
      if (document.body.dataset.probeResult === 'error') throw new Error('probe failed');
      return document.body.dataset.probeResult || 'available';
    };`,
  }));
};

test("chat shortcuts follow displayed order, preserve drafts and stop at list boundaries", async ({ page }) => {
  await ready(page);
  const ids = await rowIds(page);
  await rows(page).first().click();
  const input = page.getByRole("textbox", { name: "消息内容" });
  await input.fill("shortcut draft");
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[1]);
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[0]);
  await expect(input).toHaveJSProperty("value", "shortcut draft");
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[0]);
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[0]);
});

test("folder clicks and shortcuts preserve the conversation until chat navigation starts at the first row", async ({ page }) => {
  await ready(page);
  await rows(page).filter({ hasText: "Mia Chen" }).click();
  const mainChat = (await state(page)).chat;
  const input = page.getByRole("textbox", { name: "消息内容" });
  await input.fill("folder switch draft");
  const editor = await input.elementHandle();
  await page.keyboard.press("Control+PageDown");
  await expect.poll(async () => (await state(page)).folder).toBe("folder:work");
  const work = await rowIds(page);
  expect((await state(page)).chat).toBe(mainChat);
  await expect(input).toHaveJSProperty("value", "folder switch draft");
  expect(await editor!.evaluate(node => node.isConnected)).toBe(true);
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(work[0]);
  await rows(page).nth(1).click();
  const workChat = (await state(page)).chat;
  await page.locator('.rail-button[data-folder-id="main"]').click();
  expect((await state(page)).chat).toBe(workChat);
  await page.locator('.rail-button[data-folder-id="folder:work"]').click();
  expect((await state(page)).chat).toBe(workChat);
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(work[0]);
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(work[1]);
  await page.locator('.rail-button[data-folder-id="main"]').click();
  await rows(page).filter({ hasText: "Mia Chen" }).click();
  await expect(input).toHaveJSProperty("value", "folder switch draft");
});

test("empty folders and late list data preserve the conversation until another chat shortcut", async ({ page }) => {
  await ready(page);
  await rows(page).and(page.locator('[data-chat-id="chat-product"]')).click();
  const before = (await state(page)).chat;
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    telegramStore.setState(state => ({ folders: [...state.folders, { id: "folder:empty", title: "Empty", iconName: "Custom" }] }));
  });
  const empty = page.locator('.rail-button[data-folder-id="folder:empty"]');
  await empty.click();
  expect((await state(page)).chat).toBe(before);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await page.keyboard.press("Control+ArrowDown");
  expect((await state(page)).chat).toBe(before);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState();
    const chats = new Map(current.chats);
    const chat = chats.get("chat-mia")!;
    chats.set(chat.id, { ...chat, folderIds: [...chat.folderIds, "folder:empty"] });
    telegramStore.setState({ chats });
  });
  await expect(rows(page)).toHaveCount(1);
  expect((await state(page)).chat).toBe(before);
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await state(page)).chat).toBe("chat-mia");
  await page.locator('.rail-button[data-folder-id="main"]').click();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const chats = new Map(telegramStore.getState().chats);
    const chat = chats.get("chat-mia")!;
    chats.set(chat.id, { ...chat, folderIds: ["main"] });
    telegramStore.setState({ chats });
  });
  await empty.click();
  expect((await state(page)).chat).toBe("chat-mia");
  await page.locator('.rail-button[data-folder-id="folder:work"]').click();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const chats = new Map(telegramStore.getState().chats);
    const chat = chats.get("chat-mia")!;
    chats.set(chat.id, { ...chat, folderIds: ["main", "folder:empty"] });
    telegramStore.setState({ chats });
  });
  expect((await state(page)).chat).toBe("chat-mia");
});

test("modal dialogs and IME composition retain their keys", async ({ page }) => {
  await ready(page);
  const before = await state(page);
  const input = page.getByRole("textbox", { name: "消息内容" });
  await input.dispatchEvent("compositionstart", { data: "中" });
  await page.keyboard.press("Control+ArrowDown");
  expect((await state(page)).chat).toBe(before.chat);
  await input.dispatchEvent("compositionend", { data: "中" });
  await settings(page);
  await page.keyboard.press("Control+PageDown");
  expect(await state(page)).toEqual(before);
});

test("folder navigation follows reordered folders and starts from the current first row", async ({ page }) => {
  await ready(page);
  const before = (await state(page)).chat;
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState();
    telegramStore.setState({ folders: [current.folders.find(folder => folder.id === "folder:work")!,
      current.folders.find(folder => folder.id === "main")!, current.folders.find(folder => folder.id === "archive")!] });
  });
  await page.keyboard.press("Control+PageUp");
  await expect.poll(async () => (await state(page)).folder).toBe("folder:work");
  expect((await state(page)).chat).toBe(before);
  await rows(page).first().click();
  const removed = (await state(page)).chat!;
  await page.keyboard.press("Control+PageUp");
  expect((await state(page)).folder).toBe("folder:work");
  await page.keyboard.press("Control+PageDown");
  await expect.poll(async () => (await state(page)).folder).toBe("main");
  await page.evaluate(async id => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const chats = new Map(telegramStore.getState().chats);
    const chat = chats.get(id)!;
    chats.set(id, { ...chat, folderIds: chat.folderIds.filter(folder => folder !== "folder:work") });
    telegramStore.setState({ chats });
  }, removed);
  await page.keyboard.press("Control+PageUp");
  expect((await state(page)).chat).toBe(removed);
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await state(page)).chat).toBe((await rowIds(page))[0]);
  expect((await state(page)).chat).not.toBe(removed);
});

test("the first shortcut selects the first row even when the retained chat already belongs to the folder", async ({ page }) => {
  await ready(page);
  const main = await rowIds(page);
  await rows(page).nth(2).click();
  await page.keyboard.press("Control+PageDown");
  await page.keyboard.press("Control+PageUp");
  expect((await state(page)).chat).toBe(main[2]);
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await state(page)).chat).toBe(main[0]);

  await page.keyboard.press("Control+PageDown");
  await page.keyboard.press("Control+PageUp");
  await page.keyboard.press("Control+ArrowDown");
  expect((await state(page)).chat).toBe(main[0]);
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(main[1]);
});

test("explicit chat clicks resume navigation and selecting the same folder does not reset it", async ({ page }) => {
  await ready(page);
  const main = await rowIds(page);
  await rows(page).nth(1).click();
  await page.keyboard.press("Control+PageDown");
  await page.keyboard.press("Control+PageUp");
  await rows(page).nth(1).click();
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe(main[2]);
  await page.locator('.rail-button[data-folder-id="main"]').click();
  await page.keyboard.press("Control+PageUp");
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await state(page)).chat).toBe(main[1]);
});

test("folder browsing preserves the message viewport and detached reading position", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const anchor = await visibleMessageAnchor(page);
  expect(anchor.id).toBeTruthy();
  const viewport = await page.locator(".message-list").elementHandle();
  const before = (await state(page)).chat;
  await page.keyboard.press("Control+PageDown");
  expect((await state(page)).chat).toBe(before);
  expect(await viewport!.evaluate(element => element.isConnected)).toBe(true);
  expect((await visibleMessageAnchor(page)).id).toBe(anchor.id);
  expect(Math.abs((await visibleMessageAnchor(page)).offset - anchor.offset)).toBeLessThanOrEqual(1);
  await page.locator('.rail-button[data-folder-id="main"]').click();
  expect((await visibleMessageAnchor(page)).id).toBe(anchor.id);
  expect(Math.abs((await visibleMessageAnchor(page)).offset - anchor.offset)).toBeLessThanOrEqual(1);
});

test("folder browsing keeps the selected forum topic and its draft open", async ({ page }) => {
  await ready(page);
  await rows(page).and(page.locator('[data-chat-id="chat-forum"]')).click();
  await page.getByRole("navigation", { name: "话题切换" }).locator('[data-topic-id="12"]').click();
  const topic = page.getByRole("region", { name: "构建与发布 话题 对话" });
  await expect(topic).toBeVisible();
  const input = page.getByRole("textbox", { name: "消息内容" });
  await input.fill("retained topic draft");
  const editor = await input.elementHandle();
  await page.keyboard.press("Control+PageDown");
  await expect(topic).toBeVisible();
  expect((await state(page)).chat).toBe("chat-forum");
  expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
  await expect(input).toHaveJSProperty("value", "retained topic draft");
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(async () => (await state(page)).chat).toBe((await rowIds(page))[0]);
});

test("shortcut recording checks duplicates, reserved keys, OS conflicts and errors before saving", async ({ page }) => {
  await mockProbe(page);
  await ready(page);
  await settings(page);
  const field = recorder(page);
  await field.click();
  await page.keyboard.press("Control+ArrowDown");
  await expect(page.getByRole("alert")).toHaveText('已用于“下一个会话”');
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("alert")).toHaveText("此快捷键已被应用占用");
  await page.keyboard.press("F12");
  await expect(page.getByRole("alert")).toHaveText("此快捷键由系统保留");
  await page.evaluate(() => { document.body.dataset.probeResult = "conflict"; });
  await page.keyboard.press("Control+Shift+g");
  await expect(page.getByRole("alert")).toHaveText("此快捷键已被系统或其他应用占用");
  await page.evaluate(() => { document.body.dataset.probeResult = "error"; });
  await page.keyboard.press("Control+Shift+g");
  await expect(page.getByRole("alert")).toHaveText("快捷键检查失败，请重试");
  await page.evaluate(() => { document.body.dataset.probeResult = "available"; });
  await page.keyboard.press("Control+Shift+g");
  await expect(field).toHaveText("Ctrl + Shift + G");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await rows(page).nth(1).click();
  const ids = await rowIds(page);
  await page.keyboard.press("Control+Shift+g");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[0]);
  await page.reload();
  await settings(page);
  await expect(recorder(page)).toHaveText("Ctrl + Shift + G");
});

test("canceling or leaving recording invalidates a late native response; clear and reset remain usable", async ({ page }) => {
  await mockProbe(page);
  await ready(page);
  await settings(page);
  await page.evaluate(() => { document.body.dataset.probeResult = "delay"; });
  await recorder(page).click();
  await page.keyboard.press("Control+Shift+g");
  await expect(recorder(page)).toHaveText("检查中…");
  await page.keyboard.press("Escape");
  await page.evaluate(() => Reflect.get(window, "finishShortcutProbe")("available"));
  await expect(recorder(page)).toHaveText("Ctrl + ↑");
  await expect(page.getByRole("heading", { name: "快捷键", level: 3, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除上一个会话快捷键", exact: true }).click();
  await expect(recorder(page)).toHaveText("未设置");
  await page.evaluate(() => { document.body.dataset.probeResult = "available"; });
  await page.getByRole("button", { name: "重置上一个会话快捷键", exact: true }).click();
  await expect(recorder(page)).toHaveText("Ctrl + ↑");
  await expect(page.getByRole("heading", { name: "录入", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Enter 键发送" })).toHaveCount(0);
});

test("browser-only recording reports unavailable native verification", async ({ page }) => {
  await ready(page);
  await settings(page);
  await recorder(page).click();
  await page.keyboard.press("Control+Shift+g");
  await expect(page.getByRole("alert")).toHaveText("当前环境无法检查系统快捷键");
  await page.keyboard.press("Escape");
  await expect(recorder(page)).toHaveText("Ctrl + ↑");
});

test("re-edit shortcut can be rebound, cleared, restored and persisted without changing folders", async ({ page }) => {
  await mockProbe(page);
  await ready(page);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("configurable edit"); await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
  const before = await state(page);
  await settings(page);
  const field = recorder(page, "重新编辑上一条消息");
  await expect(field).toHaveText("Ctrl + R");
  await recorder(page).click();
  await page.keyboard.press("Control+r");
  await expect(page.getByRole("alert")).toHaveText('已用于“重新编辑上一条消息”');
  await page.keyboard.press("Escape");
  await field.click(); await page.keyboard.press("Control+Shift+e");
  await expect(field).toHaveText("Ctrl + Shift + E");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await composer.focus();
  await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await composer.press("Control+Shift+e");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  expect(await state(page)).toEqual(before);
  await composer.press("Control+Shift+e");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await settings(page);
  await page.getByRole("button", { name: "清除重新编辑上一条消息快捷键", exact: true }).click();
  await expect(field).toHaveText("未设置");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await composer.focus(); await composer.press("Control+r"); await composer.press("Control+Shift+e");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await settings(page);
  await page.getByRole("button", { name: "重置重新编辑上一条消息快捷键", exact: true }).click();
  await expect(field).toHaveText("Ctrl + R");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await composer.focus(); await composer.press("Control+r");
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  await composer.press("Escape");
  await page.reload(); await settings(page);
  await expect(field).toHaveText("Ctrl + R");
});

test("Ctrl+R reassigned to navigation stays blocked in settings and works in the conversation", async ({ page }) => {
  await mockProbe(page);
  await ready(page);
  await rows(page).nth(1).click();
  const ids = await rowIds(page);
  const before = await state(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索设置" }).fill("重新编辑上一条消息");
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
  await page.getByRole("button", { name: "清除重新编辑上一条消息快捷键", exact: true }).click();
  await recorder(page).click(); await page.keyboard.press("Control+r");
  await expect(recorder(page)).toHaveText("Ctrl + R");
  await page.keyboard.press("Control+r");
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
  expect(await state(page)).toEqual(before);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("textbox", { name: "消息内容" }).focus();
  await page.keyboard.press("Control+r");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[0]);
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
});

test("standalone settings synchronize bindings with the main window and fit a narrow dark layout", async ({ page, context }) => {
  await ready(page);
  const standalone = await context.newPage();
  await mockProbe(standalone);
  await standalone.goto("/windows/settings-window.html");
  await standalone.getByRole("button", { name: "快捷键", exact: true }).click();
  await recorder(standalone).click();
  await standalone.keyboard.press("Control+Shift+g");
  await expect(recorder(standalone)).toHaveText("Ctrl + Shift + G");
  await page.bringToFront();
  const ids = await rowIds(page);
  await rows(page).nth(1).click();
  await page.keyboard.press("Control+Shift+g");
  await expect.poll(async () => (await state(page)).chat).toBe(ids[0]);
  await standalone.bringToFront();
  await standalone.setViewportSize({ width: 390, height: 760 });
  await standalone.evaluate(async () => {
    const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("themeId", "notgram-dark");
  });
  await expect(recorder(standalone)).toBeVisible();
  await expect(standalone.locator(".settings-detail")).toHaveCSS("opacity", "1");
  await expect(standalone.locator(".settings-categories")).toHaveCSS("opacity", "0");
  expect(await standalone.locator(".settings-detail").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await standalone.screenshot({ path: "artifacts/shortcuts-settings-dark-narrow.png" });
  await standalone.setViewportSize({ width: 1024, height: 768 });
  await expect(standalone.locator(".settings-detail")).toHaveCSS("opacity", "1");
  await standalone.screenshot({ path: "artifacts/shortcuts-settings-desktop.png" });
  await standalone.evaluate(async () => {
    const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("themeId", "notgram-light");
  });
  await standalone.screenshot({ path: "artifacts/shortcuts-settings-light.png" });
});
