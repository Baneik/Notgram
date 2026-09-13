import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { horizontalOverflow, revealVirtualMessage } from "./helpers";

const versionSource = JSON.parse(readFileSync(new URL("../../version.json", import.meta.url), "utf8")) as {
  version: string;
};

test("settings isolate wheel input from the covered conversation list", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 520 });
  await page.goto("/");
  const chatList = page.locator(".chat-list[data-active=true]");
  await chatList.evaluate((element) => {
    (element as HTMLElement).style.height = "120px";
    element.scrollTop = 24;
  });
  const before = await chatList.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const backdrop = page.locator(".dialog-backdrop");
  await expect(backdrop).toBeVisible();
  await backdrop.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 480 }));
  });
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop)).toBe(before);
});

test("standalone settings update the still-interactive main window", async ({ page, context }) => {
  await page.goto("/");
  const settings = await context.newPage();
  await settings.goto("/windows/settings-window.html");
  await expect(settings.locator(".settings-window-shell")).toBeVisible();
  await expect(settings.locator(".app-shell")).toHaveCount(0);
  await expect(settings.locator(".window-chrome")).toBeVisible();
  await expect(settings.locator(".window-chrome")).not.toContainText("设置");
  await expect(settings.locator(".window-controls > button")).toHaveCount(3);
  await expect(settings.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
  const settingsTitle = settings.getByRole("heading", { name: "设置", exact: true });
  const accountCategory = settings.getByRole("button", { name: /我的账号/ });
  const chatCategory = settings.getByRole("button", { name: /聊天设置/ });
  await expect(settingsTitle).toBeFocused();
  await expect(settingsTitle).toHaveCSS("outline-style", "none");
  await expect(accountCategory).not.toBeFocused();
  await settings.keyboard.press("Tab");
  await expect(accountCategory).toBeFocused();
  expect(await accountCategory.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await chatCategory.click();
  expect(await chatCategory.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
  await settings.getByRole("spinbutton", { name: "消息字体大小" }).fill("19");
  await expect(page.locator(".message-rich-text").first()).toHaveCSS("font-size", "19px");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await settings.close();
});

test("account settings only show and edit the current profile", async ({ page }) => {
  await page.goto("/windows/settings-window.html");
  const accountCategory = page.getByRole("button", { name: "我的账号", exact: true });
  await expect(accountCategory).toHaveText("我的账号");
  await expect(accountCategory.locator("small")).toHaveCount(0);
  await expect(accountCategory).not.toContainText("林然");
  const categoryLayout = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".settings-categories");
    const buttons = [...document.querySelectorAll<HTMLElement>(".settings-category")];
    return {
      navWidth: nav?.getBoundingClientRect().width ?? 0,
      buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
    };
  });
  expect(categoryLayout.navWidth).toBeLessThan(180);
  expect(new Set(categoryLayout.buttonWidths.map(Math.round)).size).toBe(1);
  await expect(page.locator(".settings-category .lucide-chevron-right")).toHaveCount(0);
  await expect(page.getByText("已登录账号", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加账号" })).toHaveCount(0);
  await expect(page.getByText("切换到此账号", { exact: true })).toHaveCount(0);

  const card = page.locator(".account-profile-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("+86 100 0000 0000", { exact: true })).toBeVisible();
  await expect(card.getByText("self", { exact: true })).toBeVisible();
  await expect(card.getByText("DC5, Singapore, SG", { exact: true })).toBeVisible();
  await expect(card.getByText("@linran_notgram", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "编辑账号资料" }).click();
  await card.getByLabel("名字").fill("林");
  await card.getByLabel("姓氏").fill("曦");
  await card.getByLabel("用户名").fill("linxi_notgram");
  await card.getByLabel("签名").fill("桌面端设计");
  await card.getByRole("button", { name: "保存资料" }).click();
  await expect(card.getByText("林 曦", { exact: true })).toBeVisible();
  await expect(card.getByText("@linxi_notgram", { exact: true })).toBeVisible();
  await expect(card.getByText("桌面端设计", { exact: true }).first()).toBeVisible();

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await card.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(card.locator(".account-profile-avatar img")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("performance monitor captures and inspects a WebView main-thread stall", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const deadline = performance.now() + 90;
    while (performance.now() < deadline) {
      // Keep the WebView main thread busy long enough to emit a long-frame entry.
    }
  });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /性能监控/ }).click();
  await expect(page.getByRole("heading", { name: "实时会话" })).toBeVisible();
  await expect(page.locator(".performance-entry")).not.toHaveCount(0);

  const stall = page.locator(".performance-entry")
    .filter({ hasText: /长动画帧|主线程长任务|掉帧/ })
    .first();
  await expect(stall).toBeVisible();
  await stall.getByRole("button").click();
  const stallDetails = stall.locator(".performance-entry-details");
  await expect(stallDetails).toContainText("总耗时");
  await expect(stallDetails).toContainText("耗时归属");
  await expect(stallDetails).toContainText("判断证据");
  await expect(stallDetails).toContainText("当前刷新率");
  await expect(stallDetails).toContainText("当前帧预算");
  await expect(stallDetails).toContainText("真实界面卡顿");

  const monitoring = page.getByRole("switch", { name: "性能监控", exact: true });
  await monitoring.click();
  await expect(monitoring).not.toBeChecked();
  await page.getByRole("button", { name: "清空性能记录" }).click();
  await expect(page.getByText("暂无性能采样")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("performance monitor attributes a conversation switch to its slowest stage", async ({ page }) => {
  await page.goto("/");
  const title = page.locator(".conversation-title strong");
  const initialTitle = await title.innerText();
  const targetChatId = initialTitle === "产品讨论" ? "chat-mia" : "chat-product";

  await page.locator(`.chat-list[data-active=true] .chat-row[data-chat-id="${targetChatId}"]`).click();
  await expect(title).not.toHaveText(initialTitle);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /性能监控/ }).click();

  const switchEntry = page.locator(".performance-entry")
    .filter({ hasText: /会话切换 ·/ })
    .first();
  await expect(switchEntry).toBeVisible();
  await switchEntry.getByRole("button").click();
  const details = switchEntry.locator(".performance-entry-details");
  await expect(details).toContainText("最大瓶颈");
  await expect(details).toContainText("瓶颈耗时");
  await expect(details).toContainText("React 提交");
  await expect(details).toContainText("滚动定位");
  await expect(details).toContainText("耗时归属");
  await expect(details).toContainText("界面响应");
  await expect(details).toContainText("缺失阶段");
  await expect(details).not.toContainText("链路超时");
});

test("desktop messaging, context actions, and preferences remain usable", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/?blockedSenders=8");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-list[data-active=true] .chat-row")).not.toHaveCount(0);
  await expect(page.locator(".message-bubble-shell")).not.toHaveCount(0);

  const visibleBubble = page.locator(".message-bubble-shell").last();
  await visibleBubble.click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("button", { name: /^回应/ })).toHaveCount(0);
  await expect(messageMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(messageMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(messageMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await page.keyboard.press("Escape");
  await expect(page.locator(".reaction-add, .message-action-trigger")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("spinbutton", { name: "消息字体大小" }).fill("18");
  await expect(page.getByRole("spinbutton", { name: "消息字体大小" })).toHaveValue("18");
  await expect(page.locator(".message-rich-text").first()).toHaveCSS("font-size", "18px");
  await page.getByRole("spinbutton", { name: "界面缩放比例" }).fill("110");
  await expect(page.getByRole("spinbutton", { name: "界面缩放比例" })).toHaveValue("110");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.1");
  await page.getByRole("spinbutton", { name: "会话列表行高" }).fill("56");
  await page.getByRole("spinbutton", { name: "消息组间距" }).fill("14");
  await page.getByRole("spinbutton", { name: "同组消息间距" }).fill("4");
  await page.getByRole("spinbutton", { name: "消息气泡纵向留白" }).fill("10");
  await expect(page.locator("html")).toHaveCSS("--chat-row-min-height", "56px");
  await expect(page.locator("html")).toHaveCSS("--message-group-spacing", "14px");
  await expect(page.locator("html")).toHaveCSS("--message-row-spacing", "4px");
  await expect(page.locator("html")).toHaveCSS("--message-bubble-padding-y", "10px");
  const lightTheme = page.getByRole("button", { name: "浅色", exact: true });
  const darkTheme = page.getByRole("button", { name: "深色", exact: true });
  await expect(lightTheme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(225, 233, 230)");
  await darkTheme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).not.toHaveClass(/theme-dark/);
  await expect(darkTheme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".settings-dialog")).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(24, 27, 31)");
  await expect(page.locator(".message-row.is-incoming:has(.message-rich-text) .message-bubble").first())
    .toHaveCSS("background-color", "rgb(37, 42, 48)");
  await expect(page.locator(".message-row.is-outgoing:has(.message-rich-text) .message-bubble").first())
    .toHaveCSS("background-color", "rgb(51, 69, 83)");
  await page.getByRole("button", { name: /高级设置/ }).click();
  await expect(page.getByLabel("缓存路径")).toHaveValue(
    "%LOCALAPPDATA%\\dev.notgram.desktop\\tdlib",
  );
  await expect(page.getByLabel("下载路径")).toHaveValue(
    "%USERPROFILE%\\Downloads\\downloads",
  );
  const cachePathHeight = await page.getByLabel("缓存路径")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).height));
  expect(cachePathHeight).toBeGreaterThanOrEqual(35);
  expect(cachePathHeight).toBeLessThanOrEqual(37);
  await page.getByRole("button", { name: "重建界面缓存" }).click();
  await expect(page.locator(".settings-dialog .cache-health"))
    .toContainText("缓存状态：刚刚重建");
  await page.getByRole("button", { name: /软件更新/ }).click();
  await expect(page.getByRole("heading", { name: `Notgram ${versionSource.version}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(page.getByRole("button", { name: "导出诊断包" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "保留脱敏崩溃报告" })).toBeDisabled();
  await expect(page.getByText("浏览器预览不生成诊断包")).toBeVisible();
  const blockedList = page.locator(".settings-section", { hasText: "Telegram 黑名单" })
    .locator(".blocked-sender-list");
  await expect(blockedList).toHaveAttribute("aria-busy", "false");
  await expect(blockedList.locator(".blocked-sender-row")).toHaveCount(8);
  const blockedListHeight = await blockedList
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).height));
  expect(blockedListHeight).toBeGreaterThanOrEqual(183);
  expect(blockedListHeight).toBeLessThanOrEqual(185);
  await expect.poll(() => blockedList.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  expect(await horizontalOverflow(page)).toBe(false);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).not.toHaveClass(/theme-dark/);
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(24, 27, 31)");
});

test("custom proxy profiles persist and enable automatic switching", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /高级设置/ }).click();
  await settings.getByRole("radio", { name: "自定义" }).click();

  const proxyList = settings.getByRole("list", { name: "自定义代理" });
  await expect(proxyList.getByRole("listitem")).toHaveCount(1);
  await proxyList.getByRole("button", { name: "添加代理" }).click();
  await expect(proxyList.getByRole("listitem")).toHaveCount(2);

  await settings.getByLabel("名称").fill("备用节点");
  await settings.getByLabel("服务器").fill("proxy.example.test");
  await settings.getByLabel("端口").fill("1088");
  const autoSwitch = settings.getByRole("switch", { name: /自动切换/ });
  await expect(autoSwitch).toBeEnabled();
  await autoSwitch.check();

  await page.setViewportSize({ width: 390, height: 700 });
  expect(await horizontalOverflow(page)).toBe(false);
  await settings.getByRole("button", { name: "保存更改" }).click();
  await expect(settings).toBeHidden();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: /高级设置/ }).click();
  await expect(settings.getByRole("radio", { name: "自定义" })).toBeChecked();
  await expect(settings.getByRole("list", { name: "自定义代理" }).getByRole("listitem"))
    .toHaveCount(2);
  await expect(settings.getByLabel("名称")).toHaveValue("备用节点");
  await expect(settings.getByRole("switch", { name: /自动切换/ })).toBeChecked();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("custom ad blocking hides matching messages and keeps rule editing local", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /Notgram/ }).click();
  await settings.getByRole("switch", { name: "自定义屏蔽" }).check();
  const keyword = settings.getByRole("textbox", { name: "添加屏蔽关键词" });
  await keyword.fill("交互稿");
  await keyword.press("Enter");
  await settings.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByText("我把交互稿更新到最新版本了", { exact: true })).toHaveCount(0);
});

test("Zalgo blocking changes only after restart confirmation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Notgram/ }).click();

  const zalgoSwitch = page.getByRole("switch", { name: "屏蔽 Zalgo 文本" });
  await expect(zalgoSwitch).toBeChecked();
  await zalgoSwitch.click();

  const confirmation = page.getByRole("dialog", { name: "关闭 Zalgo 文本屏蔽？" });
  await expect(confirmation).toBeVisible();
  await expect(page.locator("label.preference-row", { hasText: "屏蔽 Zalgo 文本" })
    .locator('input[role="switch"]')).toBeChecked();
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(zalgoSwitch).toBeChecked();

  await zalgoSwitch.click();
  await page.getByRole("dialog", { name: "关闭 Zalgo 文本屏蔽？" })
    .getByRole("button", { name: "重启 Notgram" })
    .click();

  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const preferences = JSON.parse(localStorage.getItem("notgram:preferences:v1") ?? "{}");
    return preferences.blockZalgoText;
  })).toBe(false);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Notgram/ }).click();
  await expect(page.getByRole("switch", { name: "屏蔽 Zalgo 文本" })).not.toBeChecked();
});

test("typing status is blocked by default and reaches the transport when unblocked", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const storePath = "/src/store/telegramStore.ts";
    const { telegramStore } = await import(storePath);
    const runtime = globalThis as typeof globalThis & {
      __notgramTypingCalls?: Array<{ typing: boolean }>;
    };
    runtime.__notgramTypingCalls = [];
    telegramStore.setState({
      setChatTyping: async (_chatId: string, typing: boolean) => {
        runtime.__notgramTypingCalls?.push({ typing });
      },
    });
  });

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("默认不会发送输入状态");
  await page.waitForTimeout(50);
  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __notgramTypingCalls?: Array<{ typing: boolean }> })
      .__notgramTypingCalls ?? []
  ))).toEqual([]);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /Notgram/ }).click();
  await settings.getByRole("switch", { name: "屏蔽输入状态" }).uncheck();
  await settings.getByRole("button", { name: "关闭" }).click();

  await composer.fill("取消屏蔽后发送输入状态");
  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __notgramTypingCalls?: Array<{ typing: boolean }> })
      .__notgramTypingCalls ?? []
  ))).toContainEqual({ typing: true });
  await composer.fill("");
  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __notgramTypingCalls?: Array<{ typing: boolean }> })
      .__notgramTypingCalls ?? []
  ))).toContainEqual({ typing: false });
});

test("media cache controls clean selected data and protect active files", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:cache-cleanup:default", String(Date.now()));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();

  const cacheSection = page.locator("section", {
    has: page.getByRole("heading", { name: "媒体缓存", exact: true }),
  });
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("46.5 MB");
  await expect(cacheSection.locator(".cache-category-row")).toHaveCount(5);
  for (const category of ["视频", "音频", "文件", "其他"]) {
    await cacheSection.locator(".cache-category-row", { hasText: category })
      .getByRole("checkbox").uncheck();
  }
  await cacheSection.getByLabel("自动清理周期").selectOption("30");
  await cacheSection.getByRole("button", { name: "清理所选" }).click();
  await expect(cacheSection.locator(".cache-cleanup-result"))
    .toContainText("已清理 6.0 MB，共 9 个文件；已保留 1 个受保护文件");
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("40.5 MB");

  const autoSection = page.locator("section", {
    has: page.getByRole("heading", { name: "自动下载", exact: true }),
  });
  await expect(autoSection.getByRole("switch", { name: "图片、贴纸与动画" })).toBeChecked();
  await expect(autoSection.getByRole("switch", { name: "视频与视频消息" })).not.toBeChecked();
  await expect(autoSection.getByLabel("单个文件上限")).toHaveValue("10");

  await cacheSection.getByRole("button", { name: "清理全部媒体缓存" }).click();
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("0 B");
  await expect(cacheSection.locator(".cache-cleanup-result"))
    .toContainText("已清理 40.5 MB，共 9 个文件；已保留 1 个受保护文件");
  expect(await horizontalOverflow(page)).toBe(false);

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await cacheSection.scrollIntoViewIfNeeded();
  await expect(cacheSection.locator(".cache-category-row")).toHaveCount(5);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("background syncing does not show a composer status banner", async ({ page }) => {
  await page.goto("/?connection=syncing");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect(page.locator(".composer-connection-status")).toHaveCount(0);

  await page.goto("/?connection=waitingForNetwork");
  await expect(page.locator(".composer-connection-status"))
    .toContainText("正在等待网络");
});

test("manages device sessions and Telegram privacy rules", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(settings.getByRole("heading", { name: "设备会话" })).toBeVisible();
  await expect(settings.getByText("当前设备", { exact: true })).toBeVisible();
  const phoneSession = settings.locator(".session-row", { hasText: "Telegram Android" });
  await phoneSession.getByRole("button", { name: "终止" }).click();
  await expect(phoneSession).toBeHidden();
  await settings.getByLabel("手机号码").selectOption("allowContacts");
  await expect(settings.getByLabel("手机号码")).toHaveValue("allowContacts");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
});

test("dark mode keeps interactive hover surfaces dark across the main UI", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:preferences:v1", JSON.stringify({ themeId: "notgram-dark" }));
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");

  const missingTokens = await page.evaluate(() => {
    const contract = [
      "--color-bg-canvas",
      "--color-bg-surface",
      "--color-bg-elevated",
      "--color-bg-control",
      "--color-text-primary",
      "--color-text-secondary",
      "--color-border-default",
      "--color-border-strong",
      "--color-border-focus",
      "--color-accent",
      "--color-status-danger",
      "--color-message-incoming",
      "--color-message-outgoing",
      "--color-bg-media",
      "--color-overlay",
      "--color-shadow",
    ];
    const style = getComputedStyle(document.documentElement);
    return contract.filter((token) => style.getPropertyValue(token).trim() === "");
  });
  expect(missingTokens).toEqual([]);

  const assertDarkHover = async (locator: ReturnType<typeof page.locator>) => {
    await locator.hover();
    const background = await locator.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).not.toBe("rgb(255, 255, 255)");
    expect(background).not.toBe("rgb(244, 248, 250)");
  };

  await assertDarkHover(page.locator(".rail-button").first());
  await assertDarkHover(page.locator(".chat-list[data-active=true] .chat-row").first());
  await assertDarkHover(page.locator(".conversation-profile-trigger"));

  const profile = page.getByRole("dialog", { name: "资料" });
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  await expect(profile).toBeVisible();
  await expect(profile).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(profile).toHaveCSS("border-color", "rgb(70, 80, 90)");
  await profile.locator(".profile-navigation > button").filter({ hasText: "成员" }).click();
  await assertDarkHover(profile.locator(".profile-member-identity").first());
  await profile.getByRole("button", { name: "返回资料" }).click();

  await profile.getByRole("button", { name: "管理", exact: true }).click();
  const management = page.getByRole("dialog", { name: /管理“产品讨论”/ });
  await management.getByRole("button", { name: "邀请", exact: true }).click();
  const inviteName = management.getByLabel("邀请链接名称");
  await expect(inviteName).toHaveCSS("background-color", "rgb(41, 46, 52)");
  await expect(inviteName).toHaveCSS("border-color", "rgb(70, 80, 90)");
  await expect(inviteName).toHaveCSS("color", "rgb(208, 212, 217)");
  await management.getByRole("button", { name: "关闭管理面板" }).click();
  if (await profile.isVisible()) {
    await profile.getByRole("button", { name: "关闭资料" }).click();
  }

  await page.locator(".message-bubble-shell").last().click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu).toBeVisible();
  await assertDarkHover(messageMenu.getByRole("menuitem").first());
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "表情" }).click();
  const emojiPicker = page.locator(".emoji-picker");
  await expect(emojiPicker).toBeVisible();
  await expect(emojiPicker).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await assertDarkHover(emojiPicker.locator(".emoji-picker-tabs > button").first());
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(settings.locator(".settings-categories")).toHaveCSS("background-color", "rgb(41, 47, 53)");
});

test("light mode keeps surfaces, borders, and supporting text distinguishable", async ({ page }) => {
  await page.goto("/");

  const contrast = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const parseColor = (value: string) => {
      if (value.startsWith("#")) {
        const hex = value.slice(1);
        const expanded = hex.length === 3 ? hex.split("").map((channel) => `${channel}${channel}`).join("") : hex;
        return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255);
      }
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      return channels.map((channel) => channel / 255);
    };
    const luminance = (value: string) => {
      const [red, green, blue] = parseColor(value).map((channel) => (
        channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      ));
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const ratio = (foreground: string, background: string) => {
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    };
    const token = (name: string) => style.getPropertyValue(name).trim();
    return {
      canvasSurface: ratio(token("--color-bg-canvas"), token("--color-bg-surface")),
      surfaceBorder: ratio(token("--color-border-default"), token("--color-bg-surface")),
      surfaceStrongBorder: ratio(token("--color-border-strong"), token("--color-bg-surface")),
      secondaryText: ratio(token("--color-text-secondary"), token("--color-bg-surface")),
      accentText: ratio(token("--color-accent"), token("--color-bg-surface")),
    };
  });

  expect(contrast.canvasSurface).toBeGreaterThanOrEqual(1.2);
  expect(contrast.surfaceBorder).toBeGreaterThanOrEqual(1.45);
  expect(contrast.surfaceStrongBorder).toBeGreaterThanOrEqual(1.8);
  expect(contrast.secondaryText).toBeGreaterThanOrEqual(4.5);
  expect(contrast.accentText).toBeGreaterThanOrEqual(4.5);
});

test("chat settings move unread counters onto avatars and persist the choice", async ({ page }) => {
  await page.goto("/");
  const releaseRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-release"]');
  const rightBadge = releaseRow.locator(".chat-row-meta .unread-count");
  const rightBadgeGeometry = await rightBadge.boundingBox();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("button", { name: "头像右下角", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await expect(releaseRow.locator(".chat-avatar-wrap .unread-count-avatar")).toHaveText("8");
  await expect(releaseRow.locator(".chat-row-meta .unread-count")).toHaveCount(0);
  const avatarBadgeGeometry = await releaseRow.locator(".chat-avatar-wrap .unread-count-avatar").boundingBox();
  expect(Math.abs(avatarBadgeGeometry!.width - rightBadgeGeometry!.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(avatarBadgeGeometry!.height - rightBadgeGeometry!.height)).toBeLessThanOrEqual(0.5);

  await page.reload();
  await expect(page.locator(
    '.chat-list[data-active=true] .chat-row[data-chat-id="chat-release"] .chat-avatar-wrap .unread-count-avatar',
  )).toHaveText("8");
});

test("developer mode enables raw message copy and the browser context menu", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboardState = { text: "" };
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => { clipboardState.text = text; },
      },
    });
    Object.assign(globalThis, { __notgramDeveloperClipboardState: clipboardState });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const notice = await revealVirtualMessage(page, "p-unknown");
  await expect(notice).toContainText("收到新类型消息（messageFutureType）");
  await expect(notice.getByRole("button")).toHaveCount(0);

  const regularMessageBeforeSettings = await revealVirtualMessage(page, "p-2");
  const shellBeforeSettings = regularMessageBeforeSettings.locator(".message-bubble-shell");
  await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramDeveloperClipboardState: { text: string } }
  ).__notgramDeveloperClipboardState.text = "unchanged");
  await shellBeforeSettings.click({ modifiers: ["Control"] });
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramDeveloperClipboardState: { text: string } }
  ).__notgramDeveloperClipboardState.text)).toBe("unchanged");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  const developerMode = page.getByRole("switch", { name: "开发者模式" });
  await expect(developerMode).toBeVisible();
  await expect(developerMode).not.toBeChecked();
  await developerMode.check();
  await expect(developerMode).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  const regularMessage = await revealVirtualMessage(page, "p-2");
  const shell = regularMessage.locator(".message-bubble-shell");
  await shell.click({ modifiers: ["Control"] });
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramDeveloperClipboardState: { text: string } }
  ).__notgramDeveloperClipboardState.text)).not.toBe("");
  const rawMessage = await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramDeveloperClipboardState: { text: string } }
  ).__notgramDeveloperClipboardState.text);
  expect(JSON.parse(rawMessage)).toMatchObject({
    "@type": "message",
    id: "p-2",
    chat_id: "chat-product",
  });

  const developerContextMenu = await shell.evaluate((element) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      ctrlKey: true,
    });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched };
  });
  expect(developerContextMenu).toEqual({ defaultPrevented: false, dispatched: true });

  await shell.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "消息操作" })).toBeVisible();
});
