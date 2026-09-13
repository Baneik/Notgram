import { expect, test, type Page } from "@playwright/test";
import type { MockTelegramTransport } from "../../src/telegram/mockTransport";

declare global {
  interface Window {
    __menuTransport: MockTelegramTransport;
    __menuProbe: {
      mode: "success" | "failure" | "deferred";
      calls: number;
      releases: Array<() => void>;
    };
    __menuCommands: string[];
    __lateEditCompleted?: boolean;
  }
}

const prepare = async (page: Page) => {
  await page.route("**/src/telegram/createTransport.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      "return new MockTelegramTransport(", "return window.__menuTransport = new MockTelegramTransport(",
    ) });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => {
    const load = window.__menuTransport.getMessageProperties.bind(window.__menuTransport);
    window.__menuProbe = { mode: "success", calls: 0, releases: [] };
    window.__menuTransport.getMessageProperties = async (chatId, messageId) => {
      const probe = window.__menuProbe;
      probe.calls++;
      if (probe.mode === "failure") throw new Error("synthetic permission lookup failure");
      if (probe.mode === "deferred") await new Promise<void>(resolve => probe.releases.push(resolve));
      return load(chatId, messageId);
    };
  });
};

const openMenu = async (page: Page, id = "p-4") => {
  const bubble = page.locator(`[data-message-id="${id}"] .message-bubble-shell`).first();
  await bubble.click({ button: "right" });
};
const calls = (page: Page) => page.evaluate(() => window.__menuProbe.calls);
const setConnection = (page: Page, connectionStatus: "offline" | "online" | "syncing") => page.evaluate(async connectionStatus => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
  // Isolate the menu from history refreshes that a transport reconnect would also start.
  telegramStore.setState({ connectionStatus });
}, connectionStatus);

const nativeMenu = async (page: Page) => {
  const child = await page.context().newPage();
  await child.route("**/windows/context-menu-window.html", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      '<script type="module" src="/src/windows/contextMenuWindowEntry.tsx"></script>', `<script type="module">
      import { mockIPC, mockWindows, mockConvertFileSrc } from "/node_modules/@tauri-apps/api/mocks.js";
      window.isTauri = true;
      window.__menuCommands = [];
      mockWindows("context-menu-shared");
      mockConvertFileSrc("windows");
      mockIPC((command) => { window.__menuCommands.push(command); return true; }, { shouldMockEvents: true });
      await import("/src/windows/contextMenuWindowEntry.tsx");
    </script>`) });
  });
  await child.goto("/windows/context-menu-window.html");
  await expect(child.locator("html")).toHaveClass(/context-menu-window-page/);
  await page.evaluate(async () => {
    const { mockIPC, mockWindows, mockConvertFileSrc } = await import("/node_modules/@tauri-apps/api/mocks.js" as string) as typeof import("@tauri-apps/api/mocks");
    Object.assign(window, { isTauri: true });
    window.__menuCommands = [];
    mockWindows("main");
    mockConvertFileSrc("windows");
    mockIPC(command => {
      window.__menuCommands.push(command);
      if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
      if (command === "plugin:window|inner_size") return { width: innerWidth, height: innerHeight };
      if (command === "plugin:window|scale_factor") return 1;
      if (command === "plugin:window|monitor_from_point") return null;
      return true;
    }, { shouldMockEvents: true });
  });
  return child;
};

test("native composer format menu preserves the selected range and returns typing after activation", async ({ page }) => {
  await prepare(page);
  const input = page.locator(".composer-input");
  await input.fill("before selected after");
  await input.evaluate(element => (element as HTMLElement & { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(7, 15));
  const surface = await nativeMenu(page);
  await input.focus();
  await input.evaluate(element => (element as HTMLElement & { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(7, 15));
  await input.dispatchEvent("contextmenu", { clientX: 700, clientY: 650, button: 2 });
  await expect(surface.getByRole("menuitem", { name: "格式", exact: true })).toBeVisible();
  await surface.getByRole("menuitem", { name: "格式", exact: true }).hover();
  await expect(surface.getByRole("menuitem", { name: "链接", exact: true })).toBeVisible();
  await surface.getByRole("menuitem", { name: "粗体", exact: true }).click();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(input.locator("strong")).toHaveText("selected");
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("selectionStart", 7);
  await expect(input).toHaveJSProperty("selectionEnd", 15);
  await surface.close();
});

test("a delayed ArrowUp permission response cannot replace newly typed text", async ({ page }) => {
  await prepare(page);
  const input = page.locator(".composer-input");
  await input.fill("candidate for delayed edit"); await input.press("Enter");
  await expect(page.locator(".message-row.is-outgoing").filter({ hasText: "candidate for delayed edit" })).toBeVisible();
  await page.evaluate(() => {
    window.__menuProbe.mode = "deferred";
    const load = window.__menuTransport.getMessageProperties.bind(window.__menuTransport);
    window.__menuTransport.getMessageProperties = async (...args) => {
      try { return await load(...args); } finally { window.__lateEditCompleted = true; }
    };
  });
  await input.press("ArrowUp");
  await expect.poll(() => page.evaluate(() => window.__menuProbe.releases.length)).toBe(1);
  await input.pressSequentially("keep this draft");
  await page.evaluate(() => window.__menuProbe.releases.forEach(release => release()));
  await expect.poll(() => page.evaluate(() => window.__lateEditCompleted)).toBe(true);
  await expect(input).toHaveJSProperty("value", "keep this draft");
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
});

for (const destination of ["conversation", "discussion", "search"] as const) {
  test(`replying from a native message menu respects the focus destination after window activation (${destination})`, async ({ page }) => {
    await prepare(page);
    const discussion = destination === "discussion";
    if (discussion) {
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
      await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
      await expect(page.locator(".channel-discussion-panel .composer-input")).toBeFocused();
    }
    const surface = await nativeMenu(page);
    const scope = page.locator(discussion ? ".channel-discussion-panel" : ".conversation");
    const input = scope.locator(".composer-input").last();
    const bubble = scope.locator(".message-bubble-shell").last();
    await bubble.focus();
    await bubble.click({ button: "right" });
    await expect(surface.getByRole("menu", { name: "消息操作", exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    await surface.getByRole("menuitem", { name: "回复", exact: true }).click();
    await expect(surface.getByRole("menu", { name: "消息操作", exact: true })).toHaveCount(0);
    const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
    if (destination === "search") await search.click();
    await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      Reflect.deleteProperty(document, "hasFocus");
      window.dispatchEvent(new Event("focus"));
      document.activeElement?.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: null }));
    });
    const target = destination === "search" ? search : input;
    await expect(target).toBeFocused();
    await page.keyboard.type("typing after native reply");
    if (destination === "search") await expect(target).toHaveValue("typing after native reply");
    else await expect(target).toHaveJSProperty("value", "typing after native reply");
    if (destination === "search") await expect(input).toHaveJSProperty("value", "");
    await surface.close();
  });
}

test("native chat list menus expose and dispatch private, bot, and channel actions", async ({ page }) => {
  await prepare(page);
  const botId = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return (await telegramStore.getState().startPrivateChat("u-notgram-bot"))!;
  });
  const surface = await nativeMenu(page);
  const row = (id: string) => page.locator(`.chat-list[data-active=true] .chat-row[data-chat-id="${id}"]`);
  await row(botId).click({ button: "right" });
  const botMenu = surface.getByRole("menu", { name: "会话操作：Notgram Bot" });
  await expect(botMenu.getByRole("menuitem")).toHaveText(["置顶", "分组", "静音", "停用", "删除"]);
  await surface.screenshot({ path: test.info().outputPath("native-bot-menu.png") });
  await botMenu.getByRole("menuitem", { name: "停用", exact: true }).click();
  const stopping = page.getByRole("dialog", { name: "停用“Notgram Bot”？" });
  await stopping.getByRole("button", { name: "停用", exact: true }).click();
  await expect(stopping).toBeHidden();
  await row(botId).click({ button: "right" });
  await expect(botMenu.getByRole("menuitem", { name: "已停用" })).toBeDisabled();
  await botMenu.getByRole("menuitem", { name: "静音", exact: true }).click();
  await row(botId).click({ button: "right" });
  await expect(botMenu.getByRole("menuitem", { name: "取消静音" })).toBeEnabled();
  await botMenu.getByRole("menuitem", { name: "删除", exact: true }).click();
  const deleting = page.getByRole("dialog", { name: "删除“Notgram Bot”？" });
  await deleting.getByRole("button", { name: "删除", exact: true }).click();
  await expect(deleting).toBeHidden();
  await expect(row(botId)).toHaveCount(0);
  await row("chat-mia").click({ button: "right" });
  const direct = surface.getByRole("menu", { name: "会话操作：Mia Chen" });
  await expect(direct.getByRole("menuitem")).toHaveText(["取消置顶", "分组", "静音", "删除"]);
  await surface.keyboard.press("Escape");
  await row("chat-release").click({ button: "right" });
  const channel = surface.getByRole("menu", { name: "会话操作：Release Notes" });
  await expect(channel.getByRole("menuitem")).toHaveText(["置顶", "分组", "取消静音", "退出频道"]);
  await channel.getByRole("menuitem", { name: "退出频道" }).click();
  const leaving = page.getByRole("dialog", { name: "退出“Release Notes”？" });
  await leaving.getByRole("button", { name: "退出频道" }).click();
  await expect(leaving).toBeHidden();
  await expect(row("chat-release")).toHaveCount(0);
  await surface.close();
});

for (const native of [false, true]) {
  test(`${native ? "native" : "browser"} message menu recovers after reconnect and retries failures in place`, async ({ page }) => {
    await prepare(page);
    const surface = native ? await nativeMenu(page) : page;
    await setConnection(page, "offline");
    await openMenu(page);
    const menu = surface.getByRole("menu", { name: "消息操作", exact: true });
    await expect(menu.getByRole("status")).toHaveText("连接恢复后自动重试");
    await expect(menu.getByRole("menuitem", { name: "复制", exact: true })).toBeEnabled();
    await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toHaveCount(0);
    expect(await calls(page)).toBe(0);
    const node = await menu.elementHandle();

    await page.evaluate(() => { window.__menuProbe.mode = "failure"; });
    await setConnection(page, "online");
    await expect(menu.getByRole("status")).toHaveText("无法读取操作权限");
    expect(await calls(page)).toBe(1);
    await page.waitForTimeout(150);
    expect(await calls(page)).toBe(1);
    await page.evaluate(() => { window.__menuProbe.mode = "deferred"; });
    await menu.getByRole("menuitem", { name: "重试", exact: true }).click();
    await expect(menu.getByRole("status")).toHaveText("正在读取操作权限");
    await expect(menu.getByRole("menuitem", { name: "重试", exact: true })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "复制", exact: true }).focus();
    await page.evaluate(() => { window.__menuProbe.releases.splice(0).forEach(release => release()); });
    await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
    expect(await node!.evaluate(element => element.isConnected)).toBe(true);
    await expect(menu.getByRole("menuitem", { name: "复制", exact: true })).toBeFocused();
    if (native) {
      expect(await page.evaluate(() => window.__menuCommands.filter(command => command === "notgram_open_context_menu_window").length)).toBe(1);
      // Descriptor updates must retain blur dismissal after the initial grace period.
      await surface.waitForTimeout(80);
      await surface.evaluate(async () => {
        const { emit } = await import("/node_modules/@tauri-apps/api/event.js" as string) as typeof import("@tauri-apps/api/event");
        await emit("tauri://blur");
      });
      await expect(menu).toHaveCount(0);
      expect(await surface.evaluate(() => window.__menuCommands.includes("notgram_close_context_menu_window"))).toBe(true);
      await openMenu(page);
      await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.__menuCommands.filter(command => command === "notgram_open_context_menu_window").length)).toBe(2);
    }
  });
}

test("permission timeout exposes retry and a closed request cannot overwrite a new menu", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => { window.__menuProbe.mode = "deferred"; });
  await openMenu(page);
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  await expect(menu.getByRole("status")).toHaveText("正在读取操作权限");
  await expect(menu.getByRole("menuitem", { name: "重试", exact: true })).toBeVisible({ timeout: 12_000 });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await openMenu(page);
  await expect(menu.getByRole("status")).toHaveText("正在读取操作权限");
  const before = await calls(page);
  await page.evaluate(() => { window.__menuProbe.releases.shift()!(); });
  await page.waitForTimeout(100);
  await expect(menu.getByRole("status")).toHaveText("正在读取操作权限");
  expect(await calls(page)).toBe(before);
  await page.evaluate(() => { window.__menuProbe.releases.splice(0).forEach(release => release()); });
  await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
});

test("native forward item repeats on middle-click", async ({ page }) => {
  await prepare(page);
  const surface = await nativeMenu(page);
  await openMenu(page, "p-4");
  const menu = surface.getByRole("menu", { name: "消息操作", exact: true });
  await expect(menu.getByRole("menuitem", { name: "复读", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "转发", exact: true }).dispatchEvent("auxclick", { button: 1 });
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, Array<{
            outgoing: boolean;
            forwardInfo?: { source?: { messageId?: string } };
          }>>;
        };
      };
    };
    return module.telegramStore.getState().messages.get("chat-product")
      ?.some(message => message.outgoing && message.forwardInfo?.source?.messageId === "p-4");
  }, "/src/store/telegramStore.ts")).toBe(true);
});

test("live message replacement is bounded and invalidated permissions can recover", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => { window.__menuProbe.mode = "deferred"; });
  await openMenu(page);
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect.poll(() => calls(page)).toBe(attempt);
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const messages = new Map(telegramStore.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4" ? { ...message, editedAt: new Date().toISOString(), permissions: undefined } : message));
      telegramStore.setState({ messages });
      window.__menuProbe.releases.shift()!();
    });
  }
  await expect(menu.getByRole("status")).toHaveText("无法读取操作权限");
  expect(await calls(page)).toBe(3);
  await page.evaluate(() => { window.__menuProbe.mode = "success"; });
  await menu.getByRole("menuitem", { name: "重试", exact: true }).click();
  await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
  const loaded = await calls(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4" ? { ...message, permissions: undefined } : message));
    telegramStore.setState({ messages });
  });
  await expect.poll(() => calls(page)).toBe(loaded + 1);
  await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
});

test("connection recovery replaces a pending request without allowing its late response", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => { window.__menuProbe.mode = "deferred"; });
  await openMenu(page);
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  await expect.poll(() => calls(page)).toBeGreaterThan(0);
  await setConnection(page, "offline");
  await expect(menu.getByRole("status")).toHaveText("连接恢复后自动重试");
  await setConnection(page, "syncing");
  await expect(menu.getByRole("status")).toHaveText("正在读取操作权限");
  await page.evaluate(() => { window.__menuProbe.releases.splice(0).forEach(release => release()); });
  await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
});

test("discussion menus share connection recovery", async ({ page }) => {
  await prepare(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  await expect(page.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await setConnection(page, "offline");
  await openMenu(page, "release-comment-1");
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  await expect(menu.getByRole("status")).toHaveText("连接恢复后自动重试");
  await setConnection(page, "online");
  await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
});

test("closing the menu cancels pending permissions and snapshot retries", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => { window.__menuProbe.mode = "deferred"; });
  await openMenu(page);
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  await expect(menu.getByRole("status")).toHaveText("正在读取操作权限");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4" ? { ...message, editedAt: new Date().toISOString() } : message));
    telegramStore.setState({ messages });
    window.__menuProbe.releases.splice(0).forEach(release => release());
  });
  await page.waitForTimeout(100);
  expect(await calls(page)).toBe(1);
  expect(await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!.permissions;
  })).toBeUndefined();
});
