import { expect, test, type Page } from "@playwright/test";

const state = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
  const current = telegramStore.getState();
  return { chat: current.activeChatId ?? null, folder: current.chatFilter, memory: [...current.lastFolderChatIds] };
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

test("folder clicks and shortcuts select the first chat and restore independent selections after reload", async ({ page }) => {
  await ready(page);
  await rows(page).filter({ hasText: "Mia Chen" }).click();
  const mainChat = (await state(page)).chat;
  await page.keyboard.press("Control+PageDown");
  await expect.poll(async () => (await state(page)).folder).toBe("folder:work");
  const work = await rowIds(page);
  await expect.poll(async () => (await state(page)).chat).toBe(work[0]);
  await rows(page).nth(1).click();
  const workChat = (await state(page)).chat;
  await page.locator('.rail-button[data-folder-id="main"]').click();
  await expect.poll(async () => (await state(page)).chat).toBe(mainChat);
  await page.locator('.rail-button[data-folder-id="folder:work"]').click();
  await expect.poll(async () => (await state(page)).chat).toBe(workChat);
  await expect.poll(() => page.evaluate(() => {
    const cache = Object.values(localStorage).map(value => { try { return JSON.parse(value); } catch { return {}; } });
    return cache.some(value => value.lastFolderChatIds?.some((entry: { folderId: string }) => entry.folderId === "folder:work"));
  }), { timeout: 20_000 }).toBe(true);
  await page.reload();
  await expect(page.locator('.rail-button[data-folder-id="folder:work"]')).toHaveClass(/is-active/);
  await page.keyboard.press("Control+PageUp");
  await expect.poll(async () => (await state(page)).chat).toBe(mainChat);
  await page.keyboard.press("Control+PageDown");
  await expect.poll(async () => (await state(page)).chat).toBe(workChat);
});

test("empty folders clear the conversation, accept late data and cancel stale selection intents", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    telegramStore.setState(state => ({ folders: [...state.folders, { id: "folder:empty", title: "Empty", iconName: "Custom" }] }));
  });
  const empty = page.locator('.rail-button[data-folder-id="folder:empty"]');
  await empty.click();
  await expect.poll(async () => (await state(page)).chat).toBeNull();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveCount(0);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState();
    const chats = new Map(current.chats);
    const chat = chats.get("chat-mia")!;
    chats.set(chat.id, { ...chat, folderIds: [...chat.folderIds, "folder:empty"] });
    telegramStore.setState({ chats });
  });
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
  await expect.poll(async () => (await state(page)).chat).toBeNull();
  await page.locator('.rail-button[data-folder-id="folder:work"]').click();
  const before = await state(page);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const chats = new Map(telegramStore.getState().chats);
    const chat = chats.get("chat-mia")!;
    chats.set(chat.id, { ...chat, folderIds: ["main", "folder:empty"] });
    telegramStore.setState({ chats });
  });
  expect((await state(page)).chat).toBe(before.chat);
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

test("folder navigation follows reordered folders and falls back when a remembered chat leaves", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState();
    telegramStore.setState({ folders: [current.folders.find(folder => folder.id === "folder:work")!,
      current.folders.find(folder => folder.id === "main")!, current.folders.find(folder => folder.id === "archive")!] });
  });
  await page.keyboard.press("Control+PageUp");
  await expect.poll(async () => (await state(page)).folder).toBe("folder:work");
  const remembered = (await state(page)).chat!;
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
  }, remembered);
  await page.keyboard.press("Control+PageUp");
  await expect.poll(async () => (await state(page)).chat).toBe((await rowIds(page))[0]);
  expect((await state(page)).chat).not.toBe(remembered);
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
