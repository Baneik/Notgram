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
      document.body.dataset.probeBindings = JSON.stringify([...JSON.parse(document.body.dataset.probeBindings || '[]'), binding]);
      if (document.body.dataset.probeConflict === binding) return 'conflict';
      if (document.body.dataset.probeResult === 'delay') return new Promise(resolve => window.finishShortcutProbe = resolve);
      if (document.body.dataset.probeResult === 'error') throw new Error('probe failed');
      return document.body.dataset.probeResult || 'available';
    };`,
  }));
};

const topicTab = (page: Page, id: string) => page.locator(`.forum-topic-strip [data-topic-id="${id}"]`);
const openShortcutForum = async (page: Page) => {
  await page.goto("/");
  await rows(page).and(page.locator('[data-chat-id="chat-forum"]')).click();
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().forumTopicsLoading.has("chat-forum");
  })).toBe(false);
};

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`topic shortcuts cycle in both directions and preserve topic drafts at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openShortcutForum(page);
    const before = await state(page);
    const ids = await page.locator(".forum-topic-strip [data-topic-id]").evaluateAll(elements =>
      elements.map(element => element.getAttribute("data-topic-id")!));
    expect(ids).toEqual(["__all__", "1", "12", "18"]);
    await topicTab(page, ids[0]).click();
    for (const id of [...ids.slice(1), ids[0]]) {
      await page.keyboard.press("Control+ArrowRight");
      await expect(topicTab(page, id)).toHaveAttribute("aria-selected", "true");
    }
    for (const id of [...ids.slice(1).reverse(), ids[0]]) {
      await page.keyboard.press("Control+ArrowLeft");
      await expect(topicTab(page, id)).toHaveAttribute("aria-selected", "true");
    }
    await page.keyboard.press("Control+ArrowRight");
    const input = page.getByRole("textbox", { name: "消息内容" });
    await input.fill("general topic draft");
    await page.keyboard.press("Control+ArrowRight");
    await expect(topicTab(page, "12")).toHaveAttribute("aria-selected", "true");
    await expect(input).toBeFocused();
    await input.fill("release topic draft");
    await page.keyboard.press("Control+ArrowLeft");
    await expect(input).toHaveJSProperty("value", "general topic draft");
    await expect(input).toBeFocused();
    await page.keyboard.press("Control+ArrowRight");
    await expect(input).toHaveJSProperty("value", "release topic draft");
    expect(await state(page)).toEqual(before);
  });
}

test("topic shortcuts follow local order, skip hidden and missing topics and handle an All-only strip", async ({ page }) => {
  await openShortcutForum(page);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const { forumTopicOrderStore } = await (0, eval)('import("/src/store/forumTopicOrder.ts")') as typeof import("../../src/store/forumTopicOrder");
    const current = telegramStore.getState();
    forumTopicOrderStore.getState().setOrder("another-account", "chat-forum", ["12", "18", "__all__", "1"]);
    forumTopicOrderStore.getState().setOrder(current.activeAccountId, "another-chat", ["12", "18", "__all__", "1"]);
    forumTopicOrderStore.getState().setOrder(current.activeAccountId, "chat-forum", ["18", "__all__", "1", "missing", "12"]);
    const forumTopics = new Map(current.forumTopics);
    forumTopics.set("chat-forum", forumTopics.get("chat-forum")!.map(topic => ({ ...topic, isHidden: topic.id === "1" })));
    telegramStore.setState({ forumTopics });
  });
  await expect.poll(() => page.locator(".forum-topic-strip [data-topic-id]").evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-topic-id")))).toEqual(["18", "__all__", "12"]);
  await topicTab(page, "18").click();
  await page.keyboard.press("Control+ArrowLeft");
  await expect(topicTab(page, "12")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "18")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const forumTopics = new Map(telegramStore.getState().forumTopics);
    forumTopics.set("chat-forum", []);
    telegramStore.setState({ forumTopics });
  });
  await expect(page.locator(".forum-topic-strip [data-topic-id]")).toHaveCount(1);
  await page.keyboard.press("Control+ArrowLeft");
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "__all__")).toHaveAttribute("aria-selected", "true");
});

test("topic shortcuts retain native editing outside forums and yield to IME, menus and dialogs", async ({ page }) => {
  await ready(page);
  const before = await state(page);
  expect(await page.getByRole("textbox", { name: "消息内容" }).evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
  expect(await state(page)).toEqual(before);
  await rows(page).and(page.locator('[data-chat-id="chat-forum"]')).click();
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  const input = page.getByRole("textbox", { name: "消息内容" });
  await input.dispatchEvent("compositionstart", { data: "中" });
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await input.dispatchEvent("compositionend", { data: "中" });
  await input.dispatchEvent("keydown", { key: "Process", code: "ArrowRight", ctrlKey: true, keyCode: 229 });
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await input.click({ button: "right" });
  await expect(page.getByRole("menu").first()).toBeVisible();
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await settings(page);
  await page.keyboard.press("Control+ArrowLeft");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "12")).toHaveAttribute("aria-selected", "true");
});

test("topic shortcut settings support search, conflicts, persistence, clear and reset", async ({ page }) => {
  await mockProbe(page);
  await openShortcutForum(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索设置" }).fill("下一个话题");
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
  const previous = recorder(page, "上一个话题");
  const next = recorder(page, "下一个话题");
  await expect(previous).toHaveText("Ctrl + ←");
  await expect(next).toHaveText("Ctrl + →");
  await previous.click(); await page.keyboard.press("Control+ArrowDown");
  await expect(page.getByRole("alert")).toHaveText('已用于“下一个会话”');
  await page.keyboard.press("Control+Alt+g");
  await expect(previous).toHaveText("Ctrl + Alt + G");
  await next.click(); await page.keyboard.press("Control+Shift+g");
  await expect(next).toHaveText("Ctrl + Shift + G");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.keyboard.press("Control+ArrowRight");
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+g");
  await expect(topicTab(page, "12")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Alt+g");
  await expect(topicTab(page, "1")).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await settings(page);
  await expect(previous).toHaveText("Ctrl + Alt + G");
  await expect(next).toHaveText("Ctrl + Shift + G");
  await page.getByRole("button", { name: "清除下一个话题快捷键", exact: true }).click();
  await expect(next).toHaveText("未设置");
  await page.getByRole("button", { name: "重置下一个话题快捷键", exact: true }).click();
  await expect(next).toHaveText("Ctrl + →");
  await page.getByRole("button", { name: "重置上一个话题快捷键", exact: true }).click();
  await expect(previous).toHaveText("Ctrl + ←");
});

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

test("message formatting modifiers probe every letter, persist and apply all formats to the selection", async ({ page }) => {
  await mockProbe(page);
  await ready(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索设置" }).fill("消息格式修饰");
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
  const field = recorder(page, "消息格式修饰");
  await expect(field).toHaveText("Ctrl + Shift");
  await field.click();
  await page.keyboard.press("Control+Alt");
  await expect(field).toHaveText("Ctrl + Alt");
  expect(await page.locator("body").getAttribute("data-probe-bindings")).toBe(JSON.stringify([
    "Ctrl+Alt+KeyM", "Ctrl+Alt+KeyX", "Ctrl+Alt+KeyU", "Ctrl+Alt+KeyB", "Ctrl+Alt+KeyQ", "Ctrl+Alt+KeyK", "Ctrl+Alt+KeyF",
  ]));
  await page.reload();
  await settings(page);
  await expect(field).toHaveText("Ctrl + Alt");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("format selection");
  await composer.press("Control+a");
  await composer.press("Control+Shift+m");
  await expect(composer.locator('[data-composer-entity="spoiler"]')).toHaveCount(0);
  for (const [letter, kind] of [["m", "spoiler"], ["x", "strikethrough"], ["u", "underline"], ["b", "bold"], ["q", "blockquote"]]) {
    await composer.press(`Control+Alt+${letter}`);
    await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveText("format selection");
    await composer.dispatchEvent("keydown", { key: "Process", code: `Key${letter.toUpperCase()}`, keyCode: 229, ctrlKey: true, altKey: true });
    await expect(composer.locator(`[data-composer-entity="${kind}"]`)).toHaveCount(0);
  }
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "格式", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "下划线", exact: true })).toHaveAttribute("aria-keyshortcuts", "Control+Alt+U");
  await page.keyboard.press("Escape");
  await composer.press("Control+Alt+k");
  await expect(composer).toHaveJSProperty("value", "[format selection]()");
  await composer.fill("file selection"); await composer.press("Control+a"); await composer.press("Control+Alt+f");
  await expect(page.getByRole("region", { name: "待发送附件" })).toContainText("text.txt");
  await expect(composer).toHaveJSProperty("value", "");
});

test("a global conflict on the final formatting letter preserves the previous modifiers", async ({ page }) => {
  await mockProbe(page); await ready(page); await settings(page);
  const field = recorder(page, "消息格式修饰");
  await page.evaluate(() => { document.body.dataset.probeConflict = "Ctrl+Alt+KeyF"; });
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(page.getByRole("alert")).toHaveText("此快捷键已被系统或其他应用占用 (Ctrl + Alt + F)");
  expect(JSON.parse((await page.locator("body").getAttribute("data-probe-bindings"))!)).toHaveLength(7);
  await page.keyboard.press("Escape");
  await expect(field).toHaveText("Ctrl + Shift");
  await page.reload(); await settings(page);
  await expect(field).toHaveText("Ctrl + Shift");
});

test("formatting and individual actions reject conflicts in both directions, including reset", async ({ page }) => {
  await mockProbe(page); await ready(page); await settings(page);
  await recorder(page).click(); await page.keyboard.press("Control+Alt+f");
  await expect(recorder(page)).toHaveText("Ctrl + Alt + F");
  const field = recorder(page, "消息格式修饰");
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(page.getByRole("alert")).toHaveText('已用于“上一个会话”');
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "清除上一个会话快捷键", exact: true }).click();
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(field).toHaveText("Ctrl + Alt");
  await recorder(page).click(); await page.keyboard.press("Control+Alt+f");
  await expect(page.getByRole("alert")).toHaveText('已用于“消息格式修饰”');
  await page.keyboard.press("Control+Shift+m");
  await expect(recorder(page)).toHaveText("Ctrl + Shift + M");
  await page.getByRole("button", { name: "重置消息格式修饰快捷键", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText('已用于“上一个会话”');
  await expect(field).toHaveText("Ctrl + Alt");
  await page.getByRole("button", { name: "清除上一个会话快捷键", exact: true }).click();
  await page.getByRole("button", { name: "重置消息格式修饰快捷键", exact: true }).click();
  await expect(field).toHaveText("Ctrl + Shift");
});

test("modifier recording rejects ordinary keys and unsafe modifiers and cancels pending checks", async ({ page }) => {
  await mockProbe(page); await ready(page); await settings(page);
  const field = recorder(page, "消息格式修饰");
  await field.click(); await page.keyboard.press("Control+Shift+g");
  await expect(page.getByRole("alert")).toHaveText("请按修饰键组合后松开");
  await page.keyboard.press("Shift");
  await expect(page.getByRole("alert")).toHaveText("请使用包含 Ctrl 或 Alt 的修饰键组合");
  await page.keyboard.press("Control");
  await expect(page.getByRole("alert")).toContainText("此快捷键已被应用占用");
  await page.evaluate(() => { document.body.dataset.probeResult = "delay"; });
  await page.keyboard.press("Control+Alt");
  await expect(field).toHaveText("检查中…");
  await page.keyboard.press("Escape");
  await page.evaluate(() => Reflect.get(window, "finishShortcutProbe")("available"));
  await expect(field).toHaveText("Ctrl + Shift");
  expect(JSON.parse((await page.locator("body").getAttribute("data-probe-bindings"))!)).toEqual(["Ctrl+Alt+KeyM"]);
  await page.getByRole("button", { name: "清除消息格式修饰快捷键", exact: true }).click();
  await expect(field).toHaveText("未设置");
  await page.evaluate(() => { document.body.dataset.probeResult = "available"; });
  await page.getByRole("button", { name: "重置消息格式修饰快捷键", exact: true }).click();
  await expect(field).toHaveText("Ctrl + Shift");
});

test("clearing formatting modifiers disables keys and hints while preserving menu formatting", async ({ page }) => {
  await ready(page); await settings(page);
  await page.getByRole("button", { name: "清除消息格式修饰快捷键", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("menu only"); await composer.press("Control+a"); await composer.press("Control+Shift+m");
  await expect(composer.locator('[data-composer-entity="spoiler"]')).toHaveCount(0);
  await composer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "格式", exact: true }).hover();
  const bold = page.getByRole("menuitem", { name: "粗体", exact: true });
  await expect(bold.locator(".context-menu-shortcut")).toHaveCount(0);
  await expect(bold).not.toHaveAttribute("aria-keyshortcuts");
  await bold.click();
  await expect(composer.locator('[data-composer-entity="bold"]')).toHaveText("menu only");
});

test("browser-only modifier recording preserves the default when native verification is unavailable", async ({ page }) => {
  await ready(page); await settings(page);
  const field = recorder(page, "消息格式修饰");
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(page.getByRole("alert")).toHaveText("当前环境无法检查系统快捷键 (Ctrl + Alt + M)");
  await page.keyboard.press("Escape");
  await expect(field).toHaveText("Ctrl + Shift");
});

test("format modifier probe failures and concurrent action changes preserve the previous setting", async ({ page }) => {
  await mockProbe(page); await ready(page); await settings(page);
  const field = recorder(page, "消息格式修饰");
  await page.evaluate(() => { document.body.dataset.probeResult = "error"; });
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(page.getByRole("alert")).toHaveText("快捷键检查失败，请重试");
  await page.keyboard.press("Escape"); await expect(field).toHaveText("Ctrl + Shift");
  await page.evaluate(() => { document.body.dataset.probeResult = "delay"; });
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(field).toHaveText("检查中…");
  await page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    const state = preferencesStore.getState();
    state.setPreference("shortcuts", { ...state.shortcuts, nextChat: "Ctrl+Alt+KeyF" });
    document.body.dataset.probeResult = "available";
    Reflect.get(window, "finishShortcutProbe")("available");
  });
  await expect(page.getByRole("alert")).toHaveText('已用于“下一个会话”');
  await page.keyboard.press("Escape"); await expect(field).toHaveText("Ctrl + Shift");
});

test("starting another modifier chord invalidates an earlier probe before release", async ({ page }) => {
  await mockProbe(page); await ready(page); await settings(page);
  const field = recorder(page, "消息格式修饰");
  await page.evaluate(() => { document.body.dataset.probeResult = "delay"; });
  await field.click(); await page.keyboard.press("Control+Alt");
  await expect(field).toHaveText("检查中…");
  await page.keyboard.down("Alt"); await page.keyboard.down("Shift");
  await page.evaluate(() => {
    document.body.dataset.probeResult = "available";
    Reflect.get(window, "finishShortcutProbe")("available");
  });
  await expect(field).toHaveText("请按修饰键组合后松开");
  expect(JSON.parse((await page.locator("body").getAttribute("data-probe-bindings"))!)).toEqual(["Ctrl+Alt+KeyM"]);
  await page.keyboard.up("Shift"); await page.keyboard.up("Alt");
  await expect(field).toHaveText("Alt + Shift");
});

test("standalone settings synchronize formatting modifiers with a mounted editor at narrow widths", async ({ page, context }) => {
  await ready(page);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("live modifier");
  const standalone = await context.newPage();
  await mockProbe(standalone);
  await standalone.setViewportSize({ width: 390, height: 760 });
  await standalone.goto("/windows/settings-window.html");
  await standalone.getByRole("button", { name: "快捷键", exact: true }).click();
  const field = recorder(standalone, "消息格式修饰");
  await field.click(); await standalone.keyboard.press("Control+Alt+Shift");
  await expect(field).toHaveText("Ctrl + Alt + Shift");
  expect(await standalone.locator(".settings-detail").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await standalone.screenshot({ path: test.info().outputPath("format-modifier-settings-narrow.png") });
  await standalone.setViewportSize({ width: 1024, height: 768 });
  await standalone.screenshot({ path: test.info().outputPath("format-modifier-settings-desktop.png") });
  await page.bringToFront();
  await expect.poll(() => page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    return preferencesStore.getState().shortcuts.messageFormatModifier;
  })).toBe("Ctrl+Alt+Shift");
  await composer.focus(); await composer.press("Control+a"); await composer.press("Control+Alt+Shift+b");
  await expect(composer.locator("strong")).toHaveText("live modifier");
  await standalone.close();
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
