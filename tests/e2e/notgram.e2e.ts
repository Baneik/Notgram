import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

interface ConversationSwitchRecord {
  durationMs?: number;
  navigationKind?: number;
  cancelled?: boolean;
  [key: string]: number | boolean | undefined;
}

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  }));

const conversationSwitchRecords = (page: Page): Promise<ConversationSwitchRecord[]> =>
  page.evaluate(async () => {
    const performanceModule = await (0, eval)('import("/src/utils/performanceMonitor.ts")') as {
      getPerformanceRecords: () => Array<{
        event: string;
        durationMs?: number;
        details: Record<string, number | boolean>;
      }>;
    };
    return performanceModule.getPerformanceRecords()
      .filter((record) => record.event === "ui_conversation_switch")
      .map((record) => ({ durationMs: record.durationMs, ...record.details }));
  });

const messageListMetrics = (page: Page) => page.locator(".message-list").evaluate((element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
  distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
}));

const latestMessageBottomGap = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const messages = element.querySelectorAll<HTMLElement>("[data-message-id]");
  const latest = messages.item(messages.length - 1);
  if (!latest) return Number.POSITIVE_INFINITY;
  return Math.abs(
    element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom,
  );
});

const visibleMessageAnchor = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const listBounds = element.getBoundingClientRect();
  const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
    });
  return {
    id: row?.dataset.messageId,
    offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    scrollTop: element.scrollTop,
  };
});

const scrollAwayFromBottom = async (page: Page) => {
  await expect.poll(async () => {
    const metrics = await messageListMetrics(page);
    return metrics.scrollHeight - metrics.clientHeight;
  }).toBeGreaterThan(200);
  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.hover();
  await page.mouse.wheel(0, -1);
  await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(100, Math.floor(maximum * 0.45));
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
};

const revealVirtualMessage = async (page: Page, messageId: string) => {
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -1,
    }));
  });
  await expect.poll(() => messageList.evaluate((element, targetId) => {
    const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => row.dataset.messageId === targetId);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "auto" });
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    }
    element.scrollTop = Math.max(0, element.scrollTop - Math.max(320, element.clientHeight * 0.75));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return false;
  }, messageId)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  return row;
};

const openConversationMessageSearch = async (page: Page) => {
  const menu = page.getByRole("menu", { name: "会话操作" });
  if (!await menu.isVisible()) {
    await page.getByRole("button", { name: "更多操作" }).click();
  }
  await menu.getByRole("menuitem", { name: "搜索消息" }).click();
};

test("forum groups reopen the last topic and expose compact horizontal navigation", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-forum"]').click();

  await expect(page.getByRole("region", { name: "常规 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.getByRole("button", { name: "返回话题列表" })).toHaveCount(0);
  await expect(page.locator('[data-message-id="forum-general-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await conversationSwitchRecords(page))
    .filter((record) => record.navigationKind === 1 && record.cancelled !== true).length).toBe(1);
  const strip = page.getByRole("navigation", { name: "话题切换" });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("tab")).toHaveCount(3);
  await expect(strip.locator('[data-topic-id="12"] .forum-topic-tab-avatar')).toBeVisible();
  await expect(strip.locator('[data-topic-id="12"] .forum-topic-tab-name')).toHaveText("构建与发布");
  await expect(strip.locator('[data-topic-id="12"] .forum-topic-tab-count')).toHaveText("3");

  await page.addStyleTag({ content: ".forum-topic-tabs { max-width: 180px; }" });
  const wheelResult = await strip.locator(".forum-topic-tabs").evaluate((element) => {
    element.scrollLeft = 0;
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    element.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      maximumScrollLeft: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });
  expect(wheelResult.maximumScrollLeft).toBeGreaterThan(0);
  expect(wheelResult.defaultPrevented).toBe(true);
  expect(wheelResult.scrollLeft).toBeGreaterThan(0);

  await strip.locator('[data-topic-id="12"]').click();
  await expect(page.getByRole("region", { name: "构建与发布 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await expect.poll(async () => (await conversationSwitchRecords(page))
    .filter((record) => record.navigationKind === 4 && record.cancelled !== true).length).toBe(1);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-forum"]').click();
  await expect(page.getByRole("region", { name: "构建与发布 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.getByRole("button", { name: "返回话题列表" })).toHaveCount(0);
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
});

test("non-forum group conversations keep messages that belong to a message thread", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="product-thread-1"]')).toBeVisible();
  await expect(page.getByText("群组线程消息也应显示在主会话中。", { exact: true })).toBeVisible();
});

test("the top bar keeps only window controls and the account entry opens settings", async ({ page }) => {
  await page.goto("/");

  const settingsButton = page.locator(".rail-account");
  await expect(settingsButton).toHaveRole("button");
  await expect(settingsButton).toHaveAccessibleName("设置");
  await expect(settingsButton).toContainText("林然");
  await expect(settingsButton.locator(".avatar")).toBeVisible();
  await expect(page.locator(".rail-footer")).toHaveCount(0);
  await expect(page.locator(".rail-brand")).toHaveCount(0);
  await expect(page.locator(".window-chrome")).toBeVisible();
  await expect(page.locator(".window-chrome")).not.toContainText("Notgram");
  await expect(page.locator(".window-controls > button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "最小化窗口" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最大化窗口" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭窗口" })).toBeVisible();
  await expect(page.locator(".rail-settings, .rail-connection")).toHaveCount(0);
  await expect(page.locator(".sidebar-heading .connection-status")).toHaveCount(0);
  await expect(page.locator(".conversation-title > span")).toHaveCount(0);

  const contextMenu = await page.locator(".app-shell").evaluate((element) => {
    let propagated = false;
    element.addEventListener("contextmenu", () => { propagated = true; }, { once: true });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched, propagated };
  });
  expect(contextMenu).toEqual({ defaultPrevented: true, dispatched: false, propagated: true });

  const shortcut = await page.locator("body").evaluate((element) => {
    let propagated = false;
    window.addEventListener("keydown", () => { propagated = true; }, { once: true });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      shiftKey: true,
    });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched, propagated };
  });
  expect(shortcut).toEqual({ defaultPrevented: true, dispatched: false, propagated: false });

  await settingsButton.click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("settings isolate wheel input from the covered conversation list", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 520 });
  await page.goto("/");
  const chatList = page.locator(".chat-list");
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
  await settings.goto("/?settingsWindow");
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

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await settings.close();
});

test("account settings only show and edit the current profile", async ({ page }) => {
  await page.goto("/?settingsWindow");
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

  const pause = page.getByRole("button", { name: "暂停刷新" });
  await pause.click();
  await expect(page.getByRole("button", { name: "继续刷新" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "清空性能记录" }).click();
  await expect(page.getByText("暂无性能采样")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("performance monitor attributes a conversation switch to its slowest stage", async ({ page }) => {
  await page.goto("/");
  const title = page.locator(".conversation-title strong");
  const initialTitle = await title.innerText();
  const targetChatId = initialTitle === "产品讨论" ? "chat-mia" : "chat-product";

  await page.locator(`.chat-row[data-chat-id="${targetChatId}"]`).click();
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

test("desktop messaging, context actions, and preferences remain usable", async ({ page }) => {
  await page.goto("/?blockedSenders=8");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-row")).not.toHaveCount(0);
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
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(232, 239, 237)");
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
  await expect(page.getByRole("heading", { name: /Notgram 0\.5\.0-rc\.3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(page.getByRole("button", { name: "导出诊断包" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "保留脱敏崩溃报告" })).toBeDisabled();
  await expect(page.getByText("浏览器预览不生成诊断包")).toBeVisible();
  const blockedList = page.locator(".blocked-sender-list");
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

test("composer keeps focus, typing status is visible, and previews name the sender", async ({ page }) => {
  await page.goto("/?typing=group");

  const composer = page.getByRole("textbox", { name: "消息内容" });
  const previewSender = page.locator('[data-chat-id="chat-product"] .chat-preview-sender');
  await expect(page.locator(".conversation-header-status")).toHaveText("Jules 正在输入...");
  await expect(page.locator('[data-chat-id="chat-product"] .chat-preview'))
    .toContainText("Jules: 我把交互稿更新到最新版本了");
  await expect(previewSender).toHaveText("Jules:");
  await expect(previewSender).toHaveCSS("color", "rgb(66, 120, 165)");
  await expect(page.locator('[data-chat-id="chat-mia"] .chat-preview-sender')).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
  });
  await expect(previewSender).toHaveCSS("color", "rgb(120, 167, 200)");

  await composer.fill("发送后继续输入");
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await composer.fill("第二条消息无需重新点击");
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await expect(page.getByText("第二条消息无需重新点击", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Notgram/ }).click();
  const typingSwitch = page.getByRole("switch", { name: "发送输入状态" });
  await expect(typingSwitch).toBeChecked();
  await typingSwitch.uncheck();
  await expect(typingSwitch).not.toBeChecked();
});

test("live messages animate without replaying history rows", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".message-row.is-entering-incoming, .message-row.is-entering-outgoing"))
    .toHaveCount(0);

  const entranceReport = page.evaluate(() => new Promise<{
    className: string;
    awaitingEntranceObserved: boolean;
    rowBottom: number;
    listBottom: number;
    composerTop: number;
    opacity: number;
    animationDuration: string;
  }>((resolve) => {
    let awaitingEntranceObserved = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".message-row.is-awaiting-entrance")) {
        awaitingEntranceObserved = true;
      }
      const entering = document.querySelector<HTMLElement>(".message-row.is-entering-outgoing");
      if (!entering) return;
      const list = entering.closest<HTMLElement>(".message-list");
      const composer = document.querySelector<HTMLElement>(".composer-wrap");
      observer.disconnect();
      resolve({
        className: entering.className,
        awaitingEntranceObserved,
        rowBottom: entering.getBoundingClientRect().bottom,
        listBottom: list?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY,
        composerTop: composer?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
        opacity: Number.parseFloat(getComputedStyle(entering).opacity),
        animationDuration: getComputedStyle(entering).animationDuration,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    globalThis.setTimeout(() => {
      observer.disconnect();
      resolve({
        className: "",
        awaitingEntranceObserved,
        rowBottom: Number.POSITIVE_INFINITY,
        listBottom: Number.NEGATIVE_INFINITY,
        composerTop: Number.NEGATIVE_INFINITY,
        opacity: 0,
        animationDuration: "",
      });
    }, 2_000);
  }));
  await page.getByRole("textbox", { name: "消息内容" }).fill("动画消息测试");
  await page.getByRole("button", { name: "发送消息" }).click();

  const report = await entranceReport;
  expect(report.className).toContain("is-entering-outgoing");
  expect(report.awaitingEntranceObserved).toBe(false);
  expect(report.rowBottom).toBeLessThanOrEqual(report.listBottom + 1);
  expect(report.listBottom).toBeLessThanOrEqual(report.composerTop + 1);
  expect(report.opacity).toBeGreaterThanOrEqual(0.99);
  expect(report.animationDuration).toBe("0.14s");
  await expect(page.getByText("动画消息测试", { exact: true })).toBeVisible();
  await expect(page.locator(".message-row.is-entering-outgoing")).toHaveCount(0);
});

test("incoming messages do not wait for a bottom pin while reading away from latest", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: /^跳到最新消息/ })).toBeVisible();

  const messageId = "m-detached-incoming";
  const report = await page.evaluate(async ({ entrancePath, storePath, targetId }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (partial: { messages: Map<string, Message[]> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Message) => void;
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-mia") ?? [])];
    const latest = current.at(-1);
    if (!latest) throw new Error("Missing incoming fixture");
    const appended: Message = {
      ...latest,
      id: targetId,
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "离开底部时收到的新消息立即显示" },
    };
    entranceModule.markMessageEntrance(appended);
    current.push(appended);
    messages.set("chat-mia", current);
    const startedAt = performance.now();
    storeModule.telegramStore.setState({ messages });
    let mountedAt: number | undefined;
    while (performance.now() - startedAt < 500) {
      const row = document.querySelector<HTMLElement>(`[data-message-id="${targetId}"]`);
      if (row) {
        mountedAt ??= performance.now();
        const style = getComputedStyle(row);
        if (style.visibility !== "hidden" && Number.parseFloat(style.opacity) > 0) {
          return {
            mountedAt: mountedAt - startedAt,
            visibleAt: performance.now() - startedAt,
            className: row.className,
          };
        }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error("Detached incoming message stayed hidden");
  }, {
    entrancePath: "/src/utils/messageEntrance.ts",
    storePath: "/src/store/telegramStore.ts",
    targetId: messageId,
  });

  expect(report.visibleAt, JSON.stringify(report)).toBeLessThan(250);
  expect(report.className).not.toContain("is-preparing-entrance");
});

test("new messages stay pinned without viewport rebound", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("逐帧滚动稳定性测试");
  const samplesPromise = page.evaluate(() => new Promise<Array<{
    scrollTop: number;
    distanceBottom: number;
    rowBottom?: number;
    rowVisible: boolean;
    listBottom: number;
  }>>((resolve) => {
    const samples: Array<{
      scrollTop: number;
      distanceBottom: number;
      rowBottom?: number;
      rowVisible: boolean;
      listBottom: number;
    }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.textContent?.includes("逐帧滚动稳定性测试"));
      if (list) {
        samples.push({
          scrollTop: list.scrollTop,
          distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
          rowBottom: row?.getBoundingClientRect().bottom,
          rowVisible: Boolean(row && getComputedStyle(row).visibility !== "hidden"),
          listBottom: list.getBoundingClientRect().bottom,
        });
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  await page.getByRole("button", { name: "发送消息" }).click();
  const samples = await samplesPromise;
  const afterAppend = samples.findIndex((sample) => sample.rowBottom !== undefined);
  expect(afterAppend).toBeGreaterThanOrEqual(0);
  const visibleSamples = samples.slice(afterAppend);
  const viewportRebounds = visibleSamples.slice(1).filter((sample, index) =>
    sample.scrollTop < visibleSamples[index].scrollTop - 8,
  );
  expect(viewportRebounds, JSON.stringify(visibleSamples)).toHaveLength(0);
  const animatedSamples = visibleSamples.filter((sample) => sample.rowVisible);
  expect(
    animatedSamples.every((sample) =>
      sample.rowBottom !== undefined && sample.rowBottom <= sample.listBottom + 1
    ),
    JSON.stringify(visibleSamples),
  ).toBe(true);
  const bubbleRebounds = animatedSamples.slice(1).filter((sample, index) =>
    sample.rowBottom !== undefined && animatedSamples[index].rowBottom !== undefined &&
    sample.rowBottom > animatedSamples[index].rowBottom! + 0.5,
  );
  expect(bubbleRebounds, JSON.stringify(animatedSamples)).toHaveLength(0);
  expect(visibleSamples.at(-1)?.distanceBottom).toBeLessThanOrEqual(13);
  expect(Math.abs(
    (visibleSamples.at(-1)?.listBottom ?? 0) - (visibleSamples.at(-1)?.rowBottom ?? 0),
  )).toBeLessThanOrEqual(13);
});

test("incoming animated messages remain visible while following latest", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: /^跳到最新消息/ }).click();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const appendIncoming = (id: string, text: string) => page.evaluate(async ({
    storePath,
    entrancePath,
    messageId,
    messageText,
  }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Record<string, unknown>) => void;
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-mia") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const appended = {
      ...latest,
      id: messageId,
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: messageText },
    };
    entranceModule.markMessageEntrance(appended);
    current.push(appended);
    messages.set("chat-mia", current);
    storeModule.telegramStore.setState({ messages });
  }, {
    storePath: "/src/store/telegramStore.ts",
    entrancePath: "/src/utils/messageEntrance.ts",
    messageId: id,
    messageText: text,
  });

  const samplesPromise = page.evaluate(() => new Promise<Array<{
    animationName: string;
    distanceBottom: number;
    rowBottom: number;
    listBottom: number;
    rowVisible: boolean;
    opacity: number;
  }>>((resolve) => {
    const samples: Array<{
      animationName: string;
      distanceBottom: number;
      rowBottom: number;
      listBottom: number;
      rowVisible: boolean;
      opacity: number;
    }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      const row = document.querySelector<HTMLElement>('[data-message-id="m-live-incoming"]');
      if (!list || !row) {
        requestAnimationFrame(sample);
        return;
      }
      const style = getComputedStyle(row);
      samples.push({
        animationName: style.animationName,
        distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        rowBottom: row.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
        rowVisible: style.visibility !== "hidden",
        opacity: Number.parseFloat(style.opacity),
      });
      frames += 1;
      if (frames < 24) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  await appendIncoming("m-live-incoming", "实时收到的新消息需要完整播放入场动画");

  const samples = await samplesPromise;
  const animatedSamples = samples.filter(
    (sample) => sample.animationName === "message-enter-incoming",
  );
  expect(animatedSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
  expect(
    samples.filter((sample) => sample.rowVisible)
      .every((sample) => sample.rowBottom <= sample.listBottom + 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.rowBottom <= sample.listBottom + 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.distanceBottom <= 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.opacity >= 0.99),
    JSON.stringify(samples),
  ).toBe(true);
  expect(samples.at(-1)?.distanceBottom).toBeLessThanOrEqual(1);
  await appendIncoming("m-live-incoming-next", "下一条实时消息仍应自动跟随");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await expect.poll(() => page.locator('[data-message-id="m-live-incoming-next"]')
    .evaluate((row) => {
      const list = row.closest<HTMLElement>(".message-list");
      return list ? list.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom : -1;
    })).toBeGreaterThanOrEqual(-1);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("expired entrance metadata does not delay appended-message anchoring", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const firstMountedFrame = page.evaluate(() => new Promise<{
    className: string;
    visibility: string;
    rowBottom: number;
    listBottom: number;
  }>((resolve) => {
    const observer = new MutationObserver(() => {
      const row = document.querySelector<HTMLElement>('[data-message-id="p-expired-entrance"]');
      const list = document.querySelector<HTMLElement>(".message-list");
      if (!row || !list) return;
      observer.disconnect();
      resolve({
        className: row.className,
        visibility: getComputedStyle(row).visibility,
        rowBottom: row.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }));

  await page.evaluate(async ({ storePath, entrancePath }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Record<string, unknown>) => void;
    };
    const { telegramStore } = storeModule;
    const { markMessageEntrance } = entranceModule;
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const appended = {
      ...latest,
      id: "p-expired-entrance",
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "延迟挂载的新消息" },
    };
    markMessageEntrance(appended);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));
    current.push(appended);
    messages.set("chat-product", current);
    telegramStore.setState({ messages });
  }, {
    storePath: "/src/store/telegramStore.ts",
    entrancePath: "/src/utils/messageEntrance.ts",
  });

  const report = await firstMountedFrame;
  expect(report.className).not.toContain("is-entering-");
  expect(
    report.visibility === "hidden" || report.rowBottom <= report.listBottom + 1,
    JSON.stringify(report),
  ).toBe(true);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await expect(page.locator('[data-message-id="p-expired-entrance"]')).toBeVisible();
});

test("downward wheel input at the exact bottom never rebounds", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await page.waitForTimeout(400);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const samplesPromise = page.evaluate(() => new Promise<number[]>((resolve) => {
    const samples: number[] = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      if (list) samples.push(list.scrollHeight - list.clientHeight - list.scrollTop);
      frames += 1;
      if (frames < 45) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));
  await messageList.hover();
  for (let attempt = 0; attempt < 8; attempt += 1) await page.mouse.wheel(0, 600);
  const samples = await samplesPromise;
  const directions = samples.slice(1)
    .map((sample, index) => sample - samples[index])
    .filter((delta) => Math.abs(delta) > 1)
    .map((delta) => Math.sign(delta));
  const reversals = directions.slice(1)
    .filter((direction, index) => direction !== directions[index]);
  expect(reversals, JSON.stringify(samples)).toHaveLength(0);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
});

test("blank message viewport clicks never force a bottom correction", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await page.waitForTimeout(400);

  const before = await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(0, maximum - 26);
    return element.scrollTop;
  });
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");
  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45);
  await page.waitForTimeout(120);

  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
});

test("middle mouse scrolling detaches instead of fighting bottom following", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await page.waitForTimeout(400);
  await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(0, maximum - 420);
  });
  await page.waitForTimeout(32);
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");

  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45, {
    button: "middle",
  });
  await messageList.evaluate((element) => {
    element.scrollTop = Math.min(
      element.scrollHeight - element.clientHeight,
      element.scrollTop + 180,
    );
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(160);
  await page.waitForTimeout(120);

  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(160);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(false);
});

test("primary pointer scrolling still detaches from latest messages", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");

  await page.mouse.move(bounds.x + 3, bounds.y + bounds.height * 0.45);
  await page.mouse.down();
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 240);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(32);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(false);
  await page.mouse.up();
  await page.waitForTimeout(120);

  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(32);
  await expect(page.getByRole("button", { name: /跳到最新消息/ })).toBeVisible();
});

test("appended mixed-height row growth during downward wheel input stays pinned", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await page.waitForTimeout(400);

  await messageList.hover();
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    }));
  });

  const samplesPromise = page.evaluate(() => new Promise<Array<{
    scrollTop: number;
    distanceBottom: number;
  }>>((resolve) => {
    const samples: Array<{ scrollTop: number; distanceBottom: number }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      if (list) {
        samples.push({
          scrollTop: list.scrollTop,
          distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        });
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  const growingMessage = "组合高度变化滚动稳定性测试";
  await page.getByRole("textbox", { name: "消息内容" }).fill(growingMessage);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText(growingMessage, { exact: true })).toBeVisible();
  await page.evaluate(async (messageText) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => candidate.textContent?.includes(messageText));
    const lastItem = row?.closest<HTMLElement>("[data-index]");
    if (!list || !lastItem) throw new Error("Growing latest virtual item is not mounted");
    const spacer = document.createElement("div");
    spacer.dataset.delayedMeasurement = "true";
    spacer.style.height = "0px";
    lastItem.appendChild(spacer);
    for (let frame = 1; frame <= 16; frame += 1) {
      list.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
      }));
      spacer.style.height = `${frame * 6}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, growingMessage);

  const samples = await samplesPromise;
  const rebounds = samples.slice(1).filter((sample, index) =>
    sample.scrollTop < samples[index].scrollTop - 1 && sample.distanceBottom > 1
  );
  expect(rebounds, JSON.stringify(samples)).toHaveLength(0);
  expect(samples.at(-1)?.distanceBottom).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(true);
});

test("history loading hides transient scrollbar geometry until anchoring settles", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { observed: false };
    Object.assign(globalThis, { __notgramHistoryScrollbar: state });
    globalThis.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver(() => {
        if (document.querySelector(".message-list.is-history-adjusting")) state.observed = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryScrollbar: { observed: boolean } }
  ).__notgramHistoryScrollbar.observed)).toBe(true);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".message-list")).not.toHaveClass(/is-history-adjusting/);
});

test("composer provides recent Emoji, installed stickers, and saved GIFs", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const composerControls = await page.locator(".composer").evaluate((element) =>
    [...element.children].map((child) => child.getAttribute("aria-label") ?? child.tagName));
  expect(composerControls).toEqual(["添加附件", "消息内容", "表情", "发送消息"]);
  await page.getByRole("button", { name: "表情" }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("tab", { name: "贴纸" })).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByRole("heading", { name: "最近使用" })).toBeVisible();
  await picker.getByRole("button", { name: "工作日常" }).click();
  await expect(picker.getByRole("heading", { name: "工作日常" })).toBeVisible();
  await picker.getByRole("tab", { name: "Emoji" }).click();
  await picker.getByRole("button", { name: "插入 😀" }).click();
  await expect(composer).toHaveValue("😀");
  await expect(composer).toBeFocused();
  await picker.getByRole("button", { name: "关闭表情面板" }).click();
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "表情" }).click();
  await expect(picker.getByRole("heading", { name: "最近使用" })).toBeVisible();
  const sticker = picker.getByRole("button", { name: /发送贴纸/ }).first();
  await expect(sticker).toBeVisible();
  await sticker.click();
  await expect(picker).toBeHidden();
  await expect(page.locator('[data-media-type="sticker"]').last()).toBeVisible();
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "表情" }).click();
  await picker.getByRole("tab", { name: "GIF 动态图" }).click();
  const animation = picker.getByRole("button", { name: "发送 GIF" }).first();
  await expect(animation).toBeVisible();
  await animation.click();
  await expect(page.locator('[data-media-type="animation"]').last()).toBeVisible();
  await expect(composer).toBeFocused();
});

test("sticker picker uses deliberate hover intent and closes promptly", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "表情", exact: true });
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });

  await trigger.hover();
  await page.waitForTimeout(140);
  await expect(picker).toBeHidden();
  await expect(picker).toBeVisible({ timeout: 500 });

  const pickerBox = await picker.boundingBox();
  expect(pickerBox?.height).toBeGreaterThanOrEqual(600);
  await trigger.click();
  await expect(picker).toBeVisible();
  await picker.hover();
  await page.waitForTimeout(140);
  await expect(picker).toBeVisible();

  await page.getByRole("textbox", { name: "消息内容" }).hover();
  await expect(picker).toBeHidden({ timeout: 300 });

  await trigger.click();
  await expect(picker).toBeVisible();
  await page.getByRole("textbox", { name: "消息内容" }).fill("发送时关闭贴纸面板");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByText("发送时关闭贴纸面板", { exact: true })).toBeVisible();
});

test("message copy supports text and image clipboard payloads", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboardState = { text: "", types: [] as string[] };
    class TestClipboardItem {
      types: string[];
      constructor(readonly data: Record<string, Blob>) {
        this.types = Object.keys(data);
      }
    }
    Object.defineProperty(globalThis, "ClipboardItem", { value: TestClipboardItem });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => { clipboardState.text = text; },
        write: async (items: TestClipboardItem[]) => { clipboardState.types = items[0]?.types ?? []; },
      },
    });
    Object.assign(globalThis, { __notgramClipboardState: clipboardState });
  });
  await page.goto("/");

  await (await revealVirtualMessage(page, "p-2"))
    .locator(".message-bubble-shell")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramClipboardState: { text: string } }
  ).__notgramClipboardState.text)).toBe("看到了。消息区再留一点呼吸感，信息密度就比较平衡。");

  await (await revealVirtualMessage(page, "p-tall"))
    .locator(".message-bubble-shell")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramClipboardState: { types: string[] } }
  ).__notgramClipboardState.types)).toEqual(expect.arrayContaining(["image/png", "text/plain"]));
});

test("composer coalesces resizing and persists drafts without blocking input", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const result = await composer.evaluate(async (textarea) => {
    const input = textarea as HTMLTextAreaElement;
    const text = "responsive-input-".repeat(12);
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!valueSetter) throw new Error("Textarea value setter is unavailable");

    const observer = new MutationObserver(() => undefined);
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    const startedAt = performance.now();
    for (const [index, character] of [...text].entries()) {
      valueSetter.call(input, input.value + character);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: character,
        inputType: "insertText",
      }));
      if ((index + 1) % 24 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    const dispatchMs = performance.now() - startedAt;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const styleMutationCount = observer.takeRecords().length;
    observer.disconnect();
    return { dispatchMs, styleMutationCount, text, value: input.value };
  });

  expect(result.value).toBe(result.text);
  expect(result.dispatchMs).toBeLessThan(300);
  expect(result.styleMutationCount).toBeLessThanOrEqual(6);
  await expect.poll(() => page.evaluate(async ({ chatId, modulePath }) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get(chatId)?.text;
  }, {
    chatId: "chat-product",
    modulePath: "/src/store/telegramStore.ts",
  })).toBe(result.text);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
});

test("member mentions stay in their chat and the resulting draft can be cleared", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const senderAvatar = page.locator(".message-sender-avatar").last();
  await expect(senderAvatar).toBeVisible();
  await senderAvatar.click({ button: "right" });
  const senderMenu = page.getByRole("menu", { name: "成员操作" });
  await senderMenu.getByRole("menuitem", { name: /^@/ }).click();

  await expect(composer).toHaveValue(/^@[A-Za-z0-9_]{5,32} $/);
  const mentionDraft = await composer.inputValue();
  await page.waitForTimeout(250);
  await expect(page.locator(".inline-query-panel")).toHaveCount(0);
  await expect(page.locator(".operation-error")).toHaveCount(0);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveValue("");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(composer).toHaveValue(mentionDraft);

  await composer.fill("");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveValue("");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(composer).toHaveValue("");
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, unknown> };
      };
    };
    return storeModule.telegramStore.getState().drafts.has("chat-product");
  }, "/src/store/telegramStore.ts")).toBe(false);
});

test("IME composition defers draft persistence and layout work until commit", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeVisible();

  const result = await composer.evaluate(async (textarea) => {
    const input = textarea as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!valueSetter) throw new Error("Textarea value setter is unavailable");
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const observer = new MutationObserver(() => undefined);
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    for (const value of ["n", "ni", "你"]) {
      input.dispatchEvent(new CompositionEvent("compositionupdate", {
        bubbles: true,
        data: value,
      }));
      valueSetter.call(input, value);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertCompositionText",
        isComposing: true,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 850));
    const storeModule = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    const duringCompositionDraft = storeModule.telegramStore
      .getState().drafts.get("chat-product")?.text;
    const styleMutationCount = observer.takeRecords().length;
    observer.disconnect();
    input.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "你",
    }));
    return { duringCompositionDraft, styleMutationCount, value: input.value };
  });

  expect(result.value).toBe("你");
  expect(result.duringCompositionDraft).toBeUndefined();
  expect(result.styleMutationCount).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.text;
  }, "/src/store/telegramStore.ts")).toBe("你");
});

test("private chats show incoming typing state", async ({ page }) => {
  await page.goto("/?typing=direct");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-typing-status")).toHaveText("正在输入...");
  const titlePositionWhileTyping = await page.locator(".conversation-title strong").boundingBox();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { typingUserIds: Map<string, string[]> };
        setState: (partial: { typingUserIds: Map<string, string[]> }) => void;
      };
    };
    const typingUserIds = new Map(module.telegramStore.getState().typingUserIds);
    typingUserIds.delete("chat-mia");
    module.telegramStore.setState({ typingUserIds });
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".conversation-typing-status")).toHaveCount(0);
  const titlePositionWithoutTyping = await page.locator(".conversation-title strong").boundingBox();
  expect(Math.abs(
    titlePositionWhileTyping!.y - titlePositionWithoutTyping!.y,
  )).toBeLessThanOrEqual(0.5);
});

test("sidebar dragging and window resizing keep the responsive layout live", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("notgram.sidebar-width", "250"));
  await page.reload();
  await expect.poll(() => page.locator(".chat-sidebar").evaluate((element) =>
    Math.round(element.getBoundingClientRect().width),
  )).toBe(250);
  const resizer = page.getByRole("separator", { name: "调整会话列表宽度" });
  const before = await page.evaluate(() => ({
    stored: localStorage.getItem("notgram.sidebar-width"),
    width: getComputedStyle(document.documentElement).getPropertyValue("--chat-sidebar-width"),
  }));
  const bounds = await resizer.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 42, bounds!.y + 80, { steps: 5 });
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--chat-sidebar-width"),
  )).not.toBe(before.width);
  expect(await page.evaluate(() => localStorage.getItem("notgram.sidebar-width")))
    .toBe(before.stored);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("notgram.sidebar-width")))
    .not.toBe(before.stored);

  for (const viewport of [
    { width: 940, height: 680 },
    { width: 780, height: 620 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".message-list-content .message-row").first()).toBeVisible();
    const layout = await page.locator(".app-shell").evaluate((shell) => ({
      width: shell.getBoundingClientRect().width,
      scrollWidth: shell.scrollWidth,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
  }
});

test("conversation suppresses horizontal scrolling and reveals its vertical scrollbar only while scrolling", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toBeVisible();
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(messageList).not.toHaveClass(/is-scrolling/);

  const idle = await messageList.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".message-list-content");
    return {
      clientWidth: element.clientWidth,
      contentWidth: content?.getBoundingClientRect().width,
      horizontalOverflow: element.scrollWidth > (element as HTMLElement).offsetWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollbarColor: getComputedStyle(element).scrollbarColor,
    };
  });
  expect(idle.overflowX).toBe("hidden");
  expect(idle.horizontalOverflow).toBe(false);
  expect(idle.scrollbarColor).toContain("rgba(0, 0, 0, 0)");

  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -160 }));
    element.scrollTop = Math.max(0, element.scrollTop - 160);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(messageList).toHaveClass(/is-scrolling/);

  const scrolling = await messageList.evaluate((element) => ({
    clientWidth: element.clientWidth,
    contentWidth: element.querySelector<HTMLElement>(".message-list-content")
      ?.getBoundingClientRect().width,
    scrollbarColor: getComputedStyle(element).scrollbarColor,
  }));
  expect(scrolling.clientWidth).toBe(idle.clientWidth);
  expect(scrolling.contentWidth).toBe(idle.contentWidth);
  expect(scrolling.scrollbarColor).not.toBe(idle.scrollbarColor);

  await expect(messageList).not.toHaveClass(/is-scrolling/, { timeout: 2_000 });
  await expect.poll(() => messageList.evaluate((element) => element.clientWidth))
    .toBe(idle.clientWidth);
});

test("message viewport reaches the composer and keeps a scrollable bottom gap", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const geometry = await page.evaluate(() => {
    const latest = document.querySelector<HTMLElement>('[data-message-id="p-video"]');
    const list = latest?.closest<HTMLElement>(".message-list");
    const composer = document.querySelector<HTMLElement>(".composer");
    const sentinel = list?.querySelector<HTMLElement>(".message-list-end-sentinel");
    if (!latest || !list || !composer || !sentinel) return null;
    return {
      latestGap: composer.getBoundingClientRect().top - latest.getBoundingClientRect().bottom,
      viewportGap: composer.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
      bottomSpacer: sentinel.getBoundingClientRect().height,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.viewportGap).toBeCloseTo(0, 1);
  expect(geometry!.bottomSpacer).toBeCloseTo(12, 1);
  expect(geometry!.latestGap).toBeGreaterThanOrEqual(11);
  expect(geometry!.latestGap).toBeLessThanOrEqual(13);
});

test("single-click entry restores the server read marker without exposing intermediate jumps", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { chats: Map<string, { unreadCount: number }> };
        setState: (partial: { chats: Map<string, { unreadCount: number }> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const chats = new Map(state.chats);
    const chat = chats.get("chat-chen");
    if (chat) chats.set("chat-chen", { ...chat, unreadCount: 1 });
    storeModule.telegramStore.setState({ chats });
  }, "/src/store/telegramStore.ts");
  await page.evaluate(() => {
    const diagnosticWindow = window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
        transitionCovered: boolean;
        snapshotCovered: boolean;
        snapshotMessageCount: number;
        snapshotVisibleMessageCount: number;
        messageCount: number;
        scrollTop: number;
      }>;
    };
    diagnosticWindow.__notgramEntryFrames = [];
    const startedAt = performance.now();
    const sample = () => {
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-row[aria-current="true"]',
      )?.dataset.chatId;
      const list = document.querySelector<HTMLElement>(".message-list");
      const shell = document.querySelector<HTMLElement>(".message-list-shell");
      if (activeChatId === "chat-chen" && list && shell) {
        diagnosticWindow.__notgramEntryFrames?.push({
          busy: list.getAttribute("aria-busy"),
          placeholder: Boolean(shell.querySelector(".message-positioning-placeholder")),
          transitionCovered: document.documentElement.classList.contains(
            "is-conversation-view-transition",
          ),
          snapshotCovered: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
          snapshotMessageCount: Number(document.querySelector<HTMLElement>(
            "[data-conversation-switch-snapshot]",
          )?.dataset.snapshotMessageCount ?? 0),
          snapshotVisibleMessageCount: Number(document.querySelector<HTMLElement>(
            "[data-conversation-switch-snapshot]",
          )?.dataset.snapshotVisibleMessageCount ?? 0),
          messageCount: list.querySelectorAll("[data-message-id]").length,
          scrollTop: Math.round(list.scrollTop),
        });
      }
      if (performance.now() - startedAt < 2_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const serverChat = page.locator('[data-chat-id="chat-chen"]');
  await serverChat.click();
  await expect(serverChat).toHaveAttribute("aria-current", "true");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-old-25"]')).toBeVisible();

  const result = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const target = document.querySelector<HTMLElement>('[data-message-id="c-old-25"]')!;
    const latest = document.querySelector<HTMLElement>('[data-message-id="c-2"]');
    const listBounds = list.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const frames = (window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
        transitionCovered: boolean;
        snapshotCovered: boolean;
        snapshotMessageCount: number;
        snapshotVisibleMessageCount: number;
        messageCount: number;
        scrollTop: number;
      }>;
    }).__notgramEntryFrames ?? [];
    const placeholderFrames = frames.filter((frame) => frame.placeholder);
    const transitionCoveredFrames = frames.filter((frame) => frame.transitionCovered);
    const snapshotCoveredFrames = frames.filter((frame) => frame.snapshotCovered);
    const exposedPositions = new Set(
      frames.filter(
        (frame) => frame.busy === "false" && !frame.placeholder && !frame.transitionCovered &&
          !frame.snapshotCovered && frame.messageCount > 0,
      )
        .map((frame) => frame.scrollTop),
    );
    return {
      targetOffset: targetBounds.top - listBounds.top,
      listHeight: listBounds.height,
      latestVisible: Boolean(
        latest && latest.getBoundingClientRect().top < listBounds.bottom &&
        latest.getBoundingClientRect().bottom > listBounds.top,
      ),
      placeholderFrameCount: placeholderFrames.length,
      transitionCoveredFrameCount: transitionCoveredFrames.length,
      snapshotCoveredFrameCount: snapshotCoveredFrames.length,
      emptySnapshotFrameCount: snapshotCoveredFrames.filter(
        (frame) => frame.snapshotMessageCount === 0 || frame.snapshotVisibleMessageCount === 0,
      ).length,
      exposedPositionCount: exposedPositions.size,
      exposedPositions: [...exposedPositions],
      exposedPositionSpan: exposedPositions.size > 0
        ? Math.max(...exposedPositions) - Math.min(...exposedPositions)
        : 0,
      scrollBehavior: getComputedStyle(list).scrollBehavior,
      pseudoOverlayContent: getComputedStyle(
        document.querySelector<HTMLElement>(".message-list-shell")!,
        "::after",
      ).content,
    };
  });
  expect(result.targetOffset, JSON.stringify(result)).toBeGreaterThanOrEqual(-1);
  expect(result.targetOffset, JSON.stringify(result)).toBeLessThan(result.listHeight);
  expect(result.latestVisible).toBe(false);
  expect(
    result.placeholderFrameCount + result.transitionCoveredFrameCount,
  ).toBe(0);
  expect(result.snapshotCoveredFrameCount).toBeGreaterThan(0);
  expect(result.emptySnapshotFrameCount).toBe(0);
  expect(result.exposedPositionSpan, JSON.stringify(result.exposedPositions)).toBeLessThanOrEqual(4);
  expect(result.scrollBehavior).toBe("auto");
  expect(result.pseudoOverlayContent).toBe("none");
});

test("read conversations settle behind a non-empty switch snapshot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const sampleChenSwitch = () => page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('[data-chat-id="chat-chen"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    const samples: Array<{
      busy: string | null;
      placeholder: boolean;
      transitionCovered: boolean;
      snapshotCovered: boolean;
      messageCount: number;
      distanceBottom: number;
    }> = [];
    let settledFrames = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-row[aria-current="true"]',
      )?.dataset.chatId;
      const list = document.querySelector<HTMLElement>(".message-list");
      const shell = document.querySelector<HTMLElement>(".message-list-shell");
      if (activeChatId !== "chat-chen" || !list || !shell) continue;
      const sample = {
        busy: list.getAttribute("aria-busy"),
        placeholder: Boolean(shell.querySelector(".message-positioning-placeholder")),
        transitionCovered: document.documentElement.classList.contains(
          "is-conversation-view-transition",
        ),
        snapshotCovered: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
        messageCount: list.querySelectorAll("[data-message-id]").length,
        distanceBottom: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop),
      };
      samples.push(sample);
      settledFrames = sample.busy === "false" && sample.messageCount > 0 &&
          !sample.transitionCovered && !sample.snapshotCovered
        ? settledFrames + 1
        : 0;
      if (settledFrames >= 8) break;
    }
    return samples;
  });
  const expectOnlyBottomFrames = (frames: Awaited<ReturnType<typeof sampleChenSwitch>>) => {
    const positioned = frames.filter(
      (frame) => frame.busy === "false" && frame.messageCount > 0,
    );
    expect(positioned.length, JSON.stringify(frames)).toBeGreaterThan(0);
    expect(Math.max(...positioned.map((frame) => Math.abs(frame.distanceBottom))))
      .toBeLessThanOrEqual(1);
    expect(frames.some((frame) => frame.snapshotCovered), JSON.stringify(frames)).toBe(true);
  };

  expectOnlyBottomFrames(await sampleChenSwitch());
  await expect(page.locator('[data-message-id="c-2"]')).toBeVisible();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expectOnlyBottomFrames(await sampleChenSwitch());
});

test("conversation selection, header, and rows commit to one target", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const samples = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-chat-id="chat-chen"]')?.click();
    const frames: Array<{
      activeChatId?: string;
      title?: string;
      snapshot: boolean;
      sourceRowsInTarget: number;
    }> = [];
    let settledFrames = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-row[aria-current="true"]',
      )?.dataset.chatId;
      if (activeChatId !== "chat-chen") continue;
      const snapshot = document.querySelector<HTMLElement>(
        "[data-conversation-switch-snapshot]",
      );
      const list = document.querySelector<HTMLElement>(".message-list");
      frames.push({
        activeChatId,
        title: document.querySelector<HTMLElement>(".conversation-title strong")?.textContent ??
          undefined,
        snapshot: Boolean(snapshot),
        sourceRowsInTarget: list
          ? [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
            .filter((row) => row.dataset.messageId?.startsWith("p-")).length
          : 0,
      });
      settledFrames = !snapshot && list?.getAttribute("aria-busy") === "false"
        ? settledFrames + 1
        : 0;
      if (settledFrames >= 6) break;
    }
    return frames;
  });

  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every((sample) => sample.activeChatId === "chat-chen"), JSON.stringify(samples))
    .toBe(true);
  expect(samples.every((sample) => sample.title === "陈默"), JSON.stringify(samples)).toBe(true);
  expect(samples.some((sample) => sample.snapshot), JSON.stringify(samples)).toBe(true);
  expect(samples.some((sample) => sample.sourceRowsInTarget > 0), JSON.stringify(samples)).toBe(false);

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-chat-id="chat-product"]')?.click();
    globalThis.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
});

test("stalled background history never leaves source messages over the destination chat", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-chat-id="chat-chen"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-2"]')).toBeVisible();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { histories: Map<string, unknown> };
        setState: (partial: { histories: Map<string, unknown> }) => void;
      };
    };
    const histories = new Map(storeModule.telegramStore.getState().histories);
    histories.set("chat-chen", { loading: true, hasMore: true, initialized: true });
    storeModule.telegramStore.setState({ histories });
  }, "/src/store/telegramStore.ts");

  await page.locator('[data-chat-id="chat-chen"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默");
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0, {
    timeout: 1_000,
  });
  await expect.poll(() => page.locator('.message-list [data-message-id^="c-"]').count())
    .toBeGreaterThan(0);

  const messageIds = await page.locator(".message-list [data-message-id]")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.messageId ?? ""));
  expect(messageIds.length).toBeGreaterThan(0);
  expect(messageIds.some((id) => id.startsWith("p-")), JSON.stringify(messageIds)).toBe(false);
  expect(messageIds.some((id) => id.startsWith("c-")), JSON.stringify(messageIds)).toBe(true);
});

test("initial history completion remounts the list at the latest message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const fullHistory = state.messages.get("chat-product") ?? [];
    (window as typeof window & { __notgramFullHistory?: unknown[] }).__notgramFullHistory = fullHistory;
    const messages = new Map(state.messages);
    messages.set("chat-product", fullHistory.slice(-1));
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: true, hasMore: true, initialized: false });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".message-list [data-message-id]")).toHaveCount(1);

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set(
      "chat-product",
      (window as typeof window & { __notgramFullHistory?: unknown[] }).__notgramFullHistory ?? [],
    );
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: true, initialized: true });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.locator(".message-list [data-message-id]").count())
    .toBeGreaterThan(3);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
});

test("warm conversation switches reuse messages and reveal content promptly", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');

  await mia.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const messageCounts = async () => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, unknown[]> };
      };
    };
    const state = storeModule.telegramStore.getState();
    return {
      product: state.messages.get("chat-product")?.length ?? 0,
      mia: state.messages.get("chat-mia")?.length ?? 0,
    };
  }, "/src/store/telegramStore.ts");
  const beforeCounts = await messageCounts();

  const timing = await page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('[data-chat-id="chat-mia"]')!;
    const startedAt = performance.now();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    let headerMs: number | undefined;
    let firstMessageMs: number | undefined;
    let contentMs: number | undefined;
    let placeholderFrames = 0;
    let snapshotFrames = 0;
    let emptySnapshotFrames = 0;
    let emptyFramesAfterHeader = 0;
    while (performance.now() - startedAt < 2_000) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (
        headerMs === undefined &&
        document.querySelector(".conversation-title strong")?.textContent === "Mia Chen"
      ) {
        headerMs = performance.now() - startedAt;
      }
      const list = document.querySelector(".message-list");
      const messageCount = list?.querySelectorAll("[data-message-id]").length ?? 0;
      const placeholderVisible = Boolean(document.querySelector(".message-positioning-placeholder"));
      const snapshot = document.querySelector<HTMLElement>(
        "[data-conversation-switch-snapshot]",
      );
      const snapshotVisible = Boolean(snapshot);
      if (placeholderVisible) placeholderFrames += 1;
      if (snapshotVisible) {
        snapshotFrames += 1;
        if (
          Number(snapshot?.dataset.snapshotMessageCount ?? 0) === 0 ||
          Number(snapshot?.dataset.snapshotVisibleMessageCount ?? 0) === 0
        ) {
          emptySnapshotFrames += 1;
        }
      }
      if (
        headerMs !== undefined && messageCount === 0 &&
        !placeholderVisible && !snapshotVisible
      ) {
        emptyFramesAfterHeader += 1;
      }
      if (headerMs !== undefined && firstMessageMs === undefined && messageCount > 0) {
        firstMessageMs = performance.now() - startedAt;
      }
      if (
        firstMessageMs !== undefined &&
        list?.getAttribute("aria-busy") === "false" &&
        !snapshotVisible
      ) {
        contentMs = performance.now() - startedAt;
        break;
      }
    }
    return {
      headerMs,
      firstMessageMs,
      contentMs,
      placeholderFrames,
      snapshotFrames,
      emptySnapshotFrames,
      emptyFramesAfterHeader,
    };
  });

  expect(timing.headerMs).toBeDefined();
  expect(timing.headerMs!).toBeLessThan(100);
  expect(timing.firstMessageMs).toBeDefined();
  expect(timing.firstMessageMs!).toBeLessThan(100);
  expect(timing.contentMs).toBeDefined();
  expect(timing.contentMs!).toBeLessThan(300);
  expect(timing.placeholderFrames).toBe(0);
  expect(timing.snapshotFrames).toBeGreaterThan(0);
  expect(timing.emptySnapshotFrames).toBe(0);
  expect(timing.emptyFramesAfterHeader).toBe(0);

  await product.click();
  await mia.click();
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await messageCounts()).toEqual(beforeCounts);
});

test("warm conversation switching coalesces message-list geometry checks", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');

  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const result = await page.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    if (!descriptor?.get) throw new Error("Element.scrollHeight getter is unavailable");
    let scrollHeightReads = 0;
    let readsThisFrame = 0;
    let maxReadsPerFrame = 0;
    Object.defineProperty(Element.prototype, "scrollHeight", {
      ...descriptor,
      get() {
        if (this instanceof HTMLElement && this.classList.contains("message-list")) {
          scrollHeightReads += 1;
          readsThisFrame += 1;
        }
        return descriptor.get!.call(this);
      },
    });

    try {
      document.querySelector<HTMLElement>('[data-chat-id="chat-product"]')?.click();
      let stableFrames = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        maxReadsPerFrame = Math.max(maxReadsPerFrame, readsThisFrame);
        readsThisFrame = 0;
        const settled = document.querySelector(".conversation-title strong")?.textContent === "产品讨论" &&
          document.querySelector(".message-list")?.getAttribute("aria-busy") === "false" &&
          !document.querySelector("[data-conversation-switch-snapshot]");
        stableFrames = settled ? stableFrames + 1 : 0;
        if (stableFrames >= 2) break;
      }
      return {
        scrollHeightReads,
        maxReadsPerFrame,
        mountedMessages: document.querySelectorAll(".message-list [data-message-id]").length,
        settled: stableFrames >= 2,
      };
    } finally {
      Object.defineProperty(Element.prototype, "scrollHeight", descriptor);
    }
  });

  expect(result.settled, JSON.stringify(result)).toBe(true);
  expect(result.mountedMessages).toBeGreaterThan(3);
  expect(result.scrollHeightReads).toBeGreaterThan(0);
  expect(result.maxReadsPerFrame, JSON.stringify(result)).toBeLessThanOrEqual(12);
});

test("idle bottom following remains motionless after geometry settles", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const samples = await messageList.evaluate(async (element) => {
    const frames: Array<{
      scrollTop: number;
      distanceBottom: number;
      latestGap: number;
    }> = [];
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const messages = element.querySelectorAll<HTMLElement>("[data-message-id]");
      const latest = messages.item(messages.length - 1);
      frames.push({
        scrollTop: element.scrollTop,
        distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
        latestGap: latest
          ? element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom
          : 0,
      });
    }
    return frames;
  });
  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  expect(
    Math.max(...samples.map(({ distanceBottom }) => Math.abs(distanceBottom))),
    JSON.stringify(samples),
  )
    .toBeLessThanOrEqual(1);
  expect(span(samples.map(({ scrollTop }) => scrollTop))).toBeLessThanOrEqual(0.5);
  expect(span(samples.map(({ latestGap }) => latestGap))).toBeLessThanOrEqual(1);
});

test("rapid alternating conversation clicks commit every latest intent without a cooldown", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');
  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const observations = await page.evaluate(() => {
    const sequence = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0 ? "chat-mia" : "chat-product");
    return sequence.map((chatId) => {
      document.querySelector<HTMLElement>(`[data-chat-id="${chatId}"]`)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }),
      );
      return {
        expected: chatId,
        active: document.querySelector<HTMLElement>('.chat-row[aria-current="true"]')?.dataset.chatId,
        transitionCovered: document.documentElement.classList.contains(
          "is-conversation-view-transition",
        ),
      };
    });
  });

  expect(observations.map(({ active }) => active))
    .toEqual(observations.map(({ expected }) => expected));
  expect(observations.some(({ transitionCovered }) => transitionCovered)).toBe(false);
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
});

test("outgoing messages stay inside the conversation at narrow widths and interface zoom", async ({ page }) => {
  for (const scenario of [
    { width: 464, zoom: "1" },
    { width: 580, zoom: "1.25" },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 620 });
    await page.goto("/");
    await page.locator('[data-chat-id="chat-product"]').click();
    await expect(page.locator(".message-row.is-outgoing").last()).toBeVisible();
    await page.locator("html").evaluate((element, zoom) => { element.style.zoom = zoom; }, scenario.zoom);

    const layout = await page.locator(".message-list").evaluate((list) => {
      const content = list.querySelector<HTMLElement>(".message-list-content");
      const outgoing = [...list.querySelectorAll<HTMLElement>(".message-row.is-outgoing")];
      const listBounds = list.getBoundingClientRect();
      const contentBounds = content?.getBoundingClientRect();
      const scale = listBounds.width / (list as HTMLElement).offsetWidth;
      const paddingRight = Number.parseFloat(getComputedStyle(list).paddingRight) * scale;
      const contentRightLimit = listBounds.left
        + ((list as HTMLElement).clientWidth * scale)
        - paddingRight;
      return {
        contentRight: contentBounds?.right ?? Number.POSITIVE_INFINITY,
        contentRightLimit,
        listRight: listBounds.right,
        overflowX: getComputedStyle(list).overflowX,
        outgoingRightEdges: outgoing.map((row) => {
          const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
          const bubble = row.querySelector<HTMLElement>(".message-bubble");
          return {
            shell: shell?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
            bubble: bubble?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
          };
        }),
      };
    });

    expect(layout.overflowX).toBe("hidden");
    expect(layout.contentRight).toBeLessThanOrEqual(layout.contentRightLimit + 1);
    expect(layout.contentRight).toBeLessThan(layout.listRight);
    for (const edge of layout.outgoingRightEdges) {
      expect(edge.shell).toBeLessThanOrEqual(layout.contentRight + 1);
      expect(edge.bubble).toBeLessThanOrEqual(layout.contentRight + 1);
    }
  }
});

test("incoming virtual blocks preserve the sender avatar column", async ({ page }) => {
  await page.setViewportSize({ width: 525, height: 812 });
  await page.goto("/");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toBeVisible();
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", Array.from({ length: 6 }, (_, index) => ({
      id: `virtual-incoming-${index + 1}`,
      chatId: "chat-product",
      senderId: "u-mia",
      outgoing: false,
      sentAt: new Date(Date.UTC(2026, 7, 4, 0, 0, index)).toISOString(),
      delivery: "read",
      content: { kind: "text", text: `连续来信 ${index + 1}` },
    })));
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: false });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator('[data-message-id="virtual-incoming-6"]')).toBeVisible();
  const incomingGroups = page.locator(".message-group.is-incoming");
  await expect(incomingGroups).toHaveCount(2);
  const alignment = await incomingGroups.evaluateAll((groups) => {
    const content = groups[0]?.closest(".message-list-content");
    const contentLeft = content?.getBoundingClientRect().left ?? Number.NEGATIVE_INFINITY;
    return groups.map((group) => ({
      avatarSlots: group.querySelectorAll(".message-group-avatar").length,
      avatars: group.querySelectorAll(".message-group-avatar .avatar").length,
      avatarPosition: group.querySelector<HTMLElement>(".message-sender-avatar")
        ? getComputedStyle(group.querySelector<HTMLElement>(".message-sender-avatar")!).position
        : null,
      stackOffset: Math.round(
        (group.querySelector<HTMLElement>(".message-group-stack")?.getBoundingClientRect().left
          ?? Number.POSITIVE_INFINITY) - contentLeft,
      ),
    }));
  });
  expect(alignment).toEqual([
    { avatarSlots: 1, avatars: 0, avatarPosition: null, stackOffset: 42 },
    { avatarSlots: 1, avatars: 1, avatarPosition: "sticky", stackOffset: 42 },
  ]);
  const visibleAvatar = incomingGroups.nth(1).locator(".message-group-avatar .avatar");
  await expect(visibleAvatar).toHaveCSS("position", "relative");
  await expect(visibleAvatar).toHaveCSS("overflow", "hidden");
  await expect(visibleAvatar).toHaveCSS("border-radius", "50%");
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
    .toContainText("已清理 6.0 MB，共 9 个文件；已保护 1 个正在使用的文件");
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("40.5 MB");

  const autoSection = page.locator("section", {
    has: page.getByRole("heading", { name: "自动下载", exact: true }),
  });
  await expect(autoSection.getByRole("switch", { name: "图片、贴纸与动画" })).toBeChecked();
  await expect(autoSection.getByRole("switch", { name: "视频与视频消息" })).not.toBeChecked();
  await expect(autoSection.getByLabel("单个文件上限")).toHaveValue("10");

  await cacheSection.getByRole("button", { name: "清理全部缓存" }).click();
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("0 B");
  await expect(cacheSection.locator(".cache-cleanup-result"))
    .toContainText("已清理 40.5 MB，共 9 个文件；已保护 1 个正在使用的文件");
  expect(await horizontalOverflow(page)).toBe(false);

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await cacheSection.scrollIntoViewIfNeeded();
  await expect(cacheSection.locator(".cache-category-row")).toHaveCount(5);
  expect(await horizontalOverflow(page)).toBe(false);
});

const chooseMessageMenuItem = async (page: Page, name: string) => {
  const menu = page.getByRole("menu", { name: "消息操作" });
  const item = menu.getByRole("menuitem", { name, exact: true });
  await expect(item).toBeVisible();
  for (let step = 0; step < 12; step += 1) {
    if (await item.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
};

test("background syncing does not show a composer status banner", async ({ page }) => {
  await page.goto("/?connection=syncing");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect(page.locator(".composer-connection-status")).toHaveCount(0);

  await page.goto("/?connection=waitingForNetwork");
  await expect(page.locator(".composer-connection-status"))
    .toContainText("正在等待网络");
});

test("offline text messages survive a restart in the snapshot model", async ({ page }) => {
  await page.goto("/?connection=waitingForNetwork");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("queued across restart");
  await page.getByRole("button", { name: "发送消息" }).click();

  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 条消息将在联网后发送");
  await expect(page.getByText("queued across restart", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 条消息将在联网后发送");
  await expect(page.getByText("queued across restart", { exact: true })).toBeVisible();
});

test("offline attachments survive restart and can be cancelled", async ({ page }) => {
  await page.goto("/?connection=waitingForNetwork");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["offline attachment"], "offline-note.txt", {
      type: "text/plain",
      lastModified: 1_775_000_000_000,
    }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await composer.fill("离线附件说明");
  await page.getByRole("button", { name: "发送附件" }).click();

  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 个附件将在联网后上传");
  await expect(page.getByText("offline-note.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消上传 offline-note.txt" })).toBeVisible();

  await page.reload();
  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 个附件将在联网后上传");
  await expect(page.getByText("offline-note.txt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "取消上传 offline-note.txt" }).click();
  await expect(page.getByText("offline-note.txt", { exact: true })).toBeHidden();
  await expect(page.locator(".composer-outbox-status")).toBeHidden();
});

test("creates a public supergroup with initial members and permissions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建群组或频道" }).click();
  const dialog = page.getByRole("dialog", { name: "新建聊天" });
  await expect(dialog).toBeVisible();

  await dialog.getByText("超级群组", { exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("Notgram QA Team");
  await dialog.getByLabel("简介", { exact: true }).fill("桌面客户端验收协作");
  await dialog.getByRole("checkbox", { name: "公开聊天" }).check();
  await dialog.getByLabel("公开用户名", { exact: true }).fill("notgram_qa_team");
  await dialog.getByLabel("成员权限模板").selectOption("restricted");
  await dialog.locator(".new-chat-member-row", { hasText: "Mia Chen" }).getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "创建", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram QA Team");
  await expect(page.locator('.chat-row[data-chat-id^="chat-created-"]')).toContainText("Notgram QA Team");
  await page.locator(".conversation-profile-trigger").click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toContainText("桌面客户端验收协作");
  await expect(profile.locator(".profile-member-row")).toHaveCount(2);
});

test("manages member exceptions, default permissions, slow mode, and audit events", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "管理", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: /管理“产品讨论”/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".management-member-row")).toHaveCount(4);
  await dialog.getByLabel("设置 Mia Chen 的角色").selectOption("restricted");
  await expect(dialog.getByLabel("设置 Mia Chen 的角色")).toHaveValue("restricted");

  await dialog.getByRole("button", { name: "权限" }).click();
  const polls = dialog.getByRole("checkbox", { name: "发送投票" }).first();
  await polls.uncheck();
  await dialog.getByRole("button", { name: "保存默认权限" }).click();
  await dialog.getByLabel("慢速模式间隔").selectOption("30");
  await expect(dialog.getByLabel("慢速模式间隔")).toHaveValue("30");
  await expect(dialog.getByText("成员例外权限", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "审计日志" }).click();
  await expect(dialog.getByText("更新群组默认发送权限", { exact: true })).toBeVisible();
  await expect(dialog.getByText("设置慢速模式：30 秒", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭管理面板" }).click();
  await expect(dialog).toBeHidden();
});

test("creates and governs invite links and join requests", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  await page.getByRole("dialog", { name: "资料" }).getByRole("button", { name: "管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /管理“产品讨论”/ });
  await dialog.getByRole("button", { name: "邀请", exact: true }).click();
  await expect(dialog.getByText("主邀请链接", { exact: false })).toBeVisible();
  await dialog.getByLabel("邀请链接名称").fill("QA 临时入口");
  await dialog.getByLabel("邀请链接使用人数").fill("8");
  await dialog.getByLabel("新成员需要管理员批准").check();
  await dialog.getByRole("button", { name: "创建链接" }).click();
  const createdRow = dialog.locator(".invite-link-row", { hasText: "QA 临时入口" });
  await expect(createdRow).toBeVisible();
  await createdRow.getByRole("button", { name: "复制 QA 临时入口" }).click();
  await createdRow.getByRole("button", { name: "编辑" }).click();
  await dialog.getByLabel("邀请链接名称").fill("QA 临时入口（已编辑）");
  await dialog.getByRole("button", { name: "保存链接" }).click();
  await expect(dialog.getByText("QA 临时入口（已编辑）", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "全部批准" }).click();
  await expect(dialog.getByText("暂无待处理申请", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭管理面板" }).click();
});

test("suggests bot commands and sends paginated inline results", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await composer.fill("/");
  const suggestions = page.getByRole("listbox", { name: "机器人命令建议" });
  await expect(suggestions.getByRole("option")).toHaveCount(3);
  const firstSuggestion = suggestions.getByRole("option").first();
  const suggestionLayout = await firstSuggestion.evaluate((element) => {
    const command = element.querySelector<HTMLElement>(".bot-suggestion-command");
    const description = element.querySelector<HTMLElement>(".bot-suggestion-description");
    return {
      width: element.getBoundingClientRect().width,
      commandBottom: command?.getBoundingClientRect().bottom ?? 0,
      descriptionTop: description?.getBoundingClientRect().top ?? 0,
    };
  });
  expect(suggestionLayout.width).toBeGreaterThan(320);
  expect(suggestionLayout.commandBottom).toBeLessThanOrEqual(suggestionLayout.descriptionTop + 1);
  await composer.fill("/he");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveValue("/help@notgram_bot ");
  await composer.fill("/st");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await suggestions.getByRole("option").click();
  await expect(composer).toHaveValue("/start@notgram_bot ");
  await composer.fill("/start@notgram_bot campaign");
  await composer.press("Enter");
  await expect(page.getByText("/start campaign", { exact: true })).toBeVisible();

  await composer.fill("@notgram_bot release");
  const inline = page.getByRole("region", { name: "Inline 查询结果" });
  await expect(inline.getByRole("button").filter({ hasText: "快速摘要" })).toBeVisible();
  await inline.getByRole("button").filter({ hasText: "快速摘要" }).click();
  await expect(page.getByText("@notgram_bot: release", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Release Notes/ }).first().click();
  await composer.fill("/he");
  await composer.fill("/");
  await expect(suggestions.getByRole("option")).toHaveCount(3);
});

test("renders and activates TDLib inline bot keyboards", async ({ page }) => {
  await page.goto("/");
  const row = await revealVirtualMessage(page, "p-bot-keyboard");
  const keyboard = row.locator(".message-inline-keyboard");
  await expect(keyboard).toBeVisible();
  await expect(keyboard.locator(".message-inline-keyboard-row")).toHaveCount(2);
  await expect(keyboard.locator(".message-inline-keyboard-row").nth(0).getByRole("button"))
    .toHaveCount(8);
  await expect(keyboard.locator(".message-inline-keyboard-row").nth(1).getByRole("button"))
    .toHaveCount(3);
  await keyboard.getByRole("button", { name: "下一页" }).click();
  await expect(keyboard.getByRole("status")).toHaveText("机器人已处理操作");
});

test("long text uses configurable line folding and expands from its start", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /收藏夹/ }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /聊天设置/ }).click();
  await settings.getByRole("spinbutton", { name: "折叠阈值" }).fill("110");
  await settings.getByRole("spinbutton", { name: "收缩行数" }).fill("60");
  await expect(settings.getByRole("spinbutton", { name: "折叠阈值" })).toHaveValue("110");
  await expect(settings.getByRole("spinbutton", { name: "收缩行数" })).toHaveValue("60");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();

  await openConversationMessageSearch(page);
  const messageSearch = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(page.getByRole("group", { name: "搜索范围：收藏夹" })).toBeVisible();
  await messageSearch.fill("长消息内容第 120 行");
  await page.locator('.chat-search-results-panel [data-search-message-id="p-long-text"]').click();
  const row = page.locator('[data-message-id="p-long-text"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/is-outgoing/);
  const flow = row.locator(".message-text-flow");
  await expect(flow).toHaveClass(/is-text-collapsed/);
  await expect.poll(async () => Number(await flow.getAttribute("data-message-line-count")))
    .toBeGreaterThan(110);
  const collapsed = await flow.locator(".message-rich-text").evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    scrollHeight: element.scrollHeight,
  }));
  expect(Math.abs(collapsed.height - collapsed.lineHeight * 60)).toBeLessThanOrEqual(1);
  expect(collapsed.scrollHeight).toBeGreaterThan(collapsed.height);

  await row.getByRole("button", { name: "展开全文" }).click();
  await expect(flow).not.toHaveClass(/is-text-collapsed/);
  await expect(row.getByRole("button", { name: "展开全文" })).toHaveCount(0);
  await expect.poll(() => row.evaluate((element) => {
    const list = element.closest<HTMLElement>(".message-list");
    return list ? Math.abs(element.getBoundingClientRect().top - list.getBoundingClientRect().top) : 999;
  })).toBeLessThanOrEqual(1);
});

test("blocks users and reports chats or selected messages", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "举报", exact: true }).click();
  const report = page.getByRole("dialog", { name: /举报“产品讨论”/ });
  await expect(report.getByRole("radiogroup", { name: "举报原因" })).toBeVisible();
  await expect(report.getByRole("radio")).toHaveText([
    "垃圾信息或诈骗",
    "暴力或危险内容",
    "色情或成人内容",
    "儿童伤害",
    "侵犯知识产权",
    "与标注地点无关",
    "虚假账号或冒充他人",
    "毒品或违禁药物",
    "泄露个人信息",
    "其他原因",
  ]);
  await report.getByRole("radio", { name: "垃圾信息" }).click();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report).toBeHidden();
  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  await profile.getByRole("button", { name: "屏蔽", exact: true }).click();
  await expect(profile.getByRole("button", { name: "解除屏蔽", exact: true })).toBeVisible();
  await profile.getByRole("button", { name: "解除屏蔽", exact: true }).click();
  await profile.getByRole("button", { name: "关闭资料" }).click();

  const message = page.locator('[data-message-id="p-5"] .message-bubble-shell');
  await message.scrollIntoViewIfNeeded();
  await message.focus();
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "举报");
  const messageReport = page.getByRole("dialog", { name: /举报“产品讨论”/ });
  const reportLayout = await messageReport.evaluate((dialog) => {
    const body = dialog.querySelector<HTMLElement>(".report-dialog-body")!;
    return {
      dialogFits: dialog.scrollHeight <= dialog.clientHeight + 1,
      bodyFits: body.scrollHeight <= body.clientHeight + 1,
      bodyOverflow: getComputedStyle(body).overflowY,
    };
  });
  expect(reportLayout).toEqual({ dialogFits: true, bodyFits: true, bodyOverflow: "visible" });
  await messageReport.getByRole("button", { name: "提交举报" }).click();
  await expect(messageReport).toBeHidden();
});

test("manages device sessions and Telegram privacy rules", async ({ page }) => {
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

test("keyboard navigation closes modals and completes message workflows", async ({ page }) => {
  await page.goto("/");

  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await settingsButton.focus();
  await page.keyboard.press("Enter");
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  const settingsClose = settingsDialog.getByRole("button", { name: "关闭", exact: true });
  await expect(settingsClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(settingsDialog.locator("button:not([disabled]), input:not([disabled])").last())
    .toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settingsClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settingsDialog).toBeHidden();
  await expect(settingsButton).toBeFocused();

  const focusEditableMessage = async () => {
    const editableMessage = await revealVirtualMessage(page, "p-2");
    const trigger = editableMessage.locator(".message-bubble-shell");
    await trigger.focus();
    await expect(trigger).toBeFocused();
    return trigger;
  };
  let actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(actionMenu).toBeHidden();
  await expect(actionTrigger).toBeFocused();

  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "编辑");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();
  await composer.fill("keyboard edited message");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message-list").getByText("keyboard edited message", { exact: true }))
    .toBeVisible();
  await expect(composer).toHaveValue("");

  actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "回复");
  await expect(composer).toBeFocused();
  await composer.fill("keyboard reply");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message-list").getByText("keyboard reply", { exact: true }))
    .toBeVisible();
  await expect(composer).toHaveValue("");

  actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "转发");
  const forwardButton = page.getByRole("button", { name: "转发", exact: true });
  await expect(forwardButton).toBeFocused();
  await page.keyboard.press("Enter");
  const forwardDialog = page.getByRole("dialog", { name: /转发 1 条消息/ });
  await expect(forwardDialog.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(forwardDialog.locator(".forward-target-row").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(forwardDialog).toBeHidden();

  actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  const reactionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(reactionMenu.getByRole("button", { name: /^回应/ })).toHaveCount(0);
  await expect(reactionMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(reactionMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(reactionMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await page.keyboard.press("Escape");
  await expect(reactionMenu).toBeHidden();
  await expect(actionTrigger).toBeFocused();
});

test("search paginates, filters the current conversation by member, and opens exact messages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await page.keyboard.press("Control+K");

  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(search).toBeFocused();
  await search.fill("产品讨论历史消息");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(30);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.locator("[data-search-message-id]")).toHaveCount(36);

  await search.fill("产品讨论历史消息 36");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(1);

  await page.getByRole("tab", { name: "媒体" }).click();
  await search.fill("预览");
  const target = page.locator('[data-search-message-id="p-5"]');
  await expect(target).toContainText("新的媒体预览样式");
  await target.click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
  const locatedMessage = page.locator('[data-message-id="p-5"]');
  await expect(locatedMessage).toHaveClass(/is-notification-target/);
  await expect.poll(() => locatedMessage.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  })).toBeLessThan(2);

  await page.evaluate(async (storePath) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { searchChatMessages: (input: unknown) => Promise<void> };
        setState: (state: { searchChatMessages: (input: unknown) => Promise<void> }) => void;
      };
    };
    const originalSearch = storeModule.telegramStore.getState().searchChatMessages;
    const counters = globalThis as typeof globalThis & { __notgramChatSearchCalls?: number };
    counters.__notgramChatSearchCalls = 0;
    storeModule.telegramStore.setState({
      searchChatMessages: async (input) => {
        counters.__notgramChatSearchCalls = (counters.__notgramChatSearchCalls ?? 0) + 1;
        await originalSearch(input);
      },
    });
  }, "/src/store/telegramStore.ts");

  await page.keyboard.press("Control+F");
  await expect(search).toBeFocused();
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeVisible();
  await expect(page.locator(".conversation-search-panel")).toHaveCount(0);
  await search.fill("产品讨论历史消息");
  const scopedResults = page.locator(".chat-search-results-panel [data-search-message-id]");
  await expect(scopedResults).toHaveCount(30);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramChatSearchCalls?: number }
  ).__notgramChatSearchCalls)).toBe(1);
  await expect(page.getByRole("log", { name: "消息列表" })).toBeVisible();
  await page.locator(".chat-search-results-panel").getByRole("button", { name: "加载更多" }).click();
  await expect(scopedResults).toHaveCount(36);

  const newestSearchResult = page.locator('.chat-search-results-panel [data-search-message-id="p-old-36"]');
  await expect(newestSearchResult).toContainText("产品讨论历史消息 36");
  await newestSearchResult.click();
  await expect(page.locator(".chat-search-results-panel")).toBeHidden();
  const searchSourceMessage = page.locator('[data-message-id="p-old-36"]');
  await expect(searchSourceMessage).toHaveClass(/is-notification-target/);
  await expect(searchSourceMessage).toBeInViewport();

  await page.keyboard.press("Control+F");
  await expect(search).toBeFocused();
  await expect(page.getByLabel("消息类型")).toHaveCount(0);
  await expect(page.getByLabel("消息日期")).toHaveCount(0);
  await search.fill("产品讨论历史消息");
  const memberFilter = page.locator(".chat-search-member-trigger");
  await expect(memberFilter).toHaveAccessibleName("成员筛选：所有成员");
  await memberFilter.click();
  const memberDialog = page.getByRole("dialog", { name: "选择成员" });
  await expect(memberDialog).toBeVisible();
  const memberSearch = memberDialog.getByRole("searchbox", { name: "搜索成员" });
  await expect(memberSearch).toBeFocused();
  await memberSearch.fill("Jules");
  await expect(memberDialog.getByRole("button", { name: "Jules", exact: true })).toBeVisible();
  await expect(memberDialog.getByRole("button", { name: "我", exact: true })).toHaveCount(0);
  await memberDialog.getByRole("button", { name: "Jules", exact: true }).click();
  await expect(memberFilter).toHaveAccessibleName("成员筛选：Jules");
  await expect(memberDialog).toBeHidden();
  await expect.poll(() => scopedResults.count()).toBeGreaterThan(0);
  await search.press("Escape");
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeHidden();
  await expect(search).toHaveValue("");

  const senderAvatar = page.locator(".message-sender-avatar").last();
  await expect(senderAvatar).toBeVisible();
  await senderAvatar.click({ button: "right" });
  const senderMenu = page.getByRole("menu", { name: "成员操作" });
  await expect(senderMenu.getByRole("menuitem", { name: /^搜索 .* 的消息$/ })).toBeVisible();
  await senderMenu.getByRole("menuitem", { name: /^搜索 .* 的消息$/ }).click();
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeVisible();
  await expect(page.locator(".chat-search-member-trigger")).not.toHaveAccessibleName("成员筛选：所有成员");
  await page.getByRole("button", { name: "移除会话搜索范围" }).click();

  await page.keyboard.press("Control+K");
  await search.fill("Mia Chen");
  await page.locator(".global-chat-result", { hasText: "Mia Chen" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await search.fill("预览");
  await expect(page.locator('[data-search-message-id="p-5"]')).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
});

test("conversation navigation records only links opened inside a conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "后退" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "前进" })).toHaveCount(0);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");

  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  const forwardedMessage = page.locator('[data-message-id="p-channel-reply"]');
  await forwardedMessage.getByRole("button", { name: "打开频道原消息：Release editor" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 4,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
});

test("chat profiles expose members and shared media with focus restoration", async ({ page }) => {
  await page.goto("/");
  const profileTrigger = page.getByRole("button", { name: "查看 产品讨论 资料" });
  await profileTrigger.click();

  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("heading", { name: "产品讨论" })).toBeVisible();
  await expect(profile.getByText("产品、设计与开发协作群。", { exact: true })).toBeVisible();
  await expect(profile.locator(".profile-member-row")).toHaveCount(4);
  const popupBounds = await profile.boundingBox();
  expect(popupBounds).not.toBeNull();
  expect(popupBounds!.height).toBeLessThan(720);
  expect(Math.abs((popupBounds!.x + popupBounds!.width / 2) - 640)).toBeLessThan(2);

  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  await expect(profile.getByText("@mia_design", { exact: true })).toBeVisible();
  await expect(profile.getByText("u-mia", { exact: true })).toBeVisible();
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await profileTrigger.click();
  await expect(profile.locator(".profile-state")).toHaveCount(0);

  await profile.getByRole("button", { name: "共享媒体" }).click();
  await expect(profile.locator(".shared-media-item")).not.toHaveCount(0);
  await profile.locator(".shared-media-open").first().click();
  await expect(profile).toBeHidden();
  await expect(page.locator(".conversation")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await profileTrigger.click();
  await expect(profile).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(profileTrigger).toBeFocused();
});

test("shared media supports server categories, filters, forwarding, and batch deletion", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "共享媒体" }).click();
  await profile.getByRole("tab", { name: "文件" }).click();
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toBeVisible();
  await expect(profile.getByText("research-notes.zip", { exact: true })).toBeVisible();

  const search = profile.getByRole("searchbox", { name: "搜索共享媒体" });
  await search.fill("research");
  await profile.locator(".shared-media-search").getByRole("button", { name: "搜索" }).click();
  await expect(profile.getByText("research-notes.zip", { exact: true })).toBeVisible();
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toHaveCount(0);
  await search.fill("");
  await profile.locator(".shared-media-search").getByRole("button", { name: "搜索" }).click();

  await profile.getByLabel("共享媒体开始日期").fill("2026-08-02");
  await expect(profile.getByText("没有匹配的内容", { exact: true })).toBeVisible();
  await profile.getByLabel("共享媒体开始日期").fill("");
  await profile.getByLabel("选择 p-3").check();
  const toolbar = profile.getByRole("toolbar", { name: "共享媒体批量操作" });
  await toolbar.getByLabel("共享媒体转发目标").selectOption("chat-mia");
  await toolbar.getByRole("button", { name: "转发" }).click();
  await expect(toolbar).toBeHidden();

  await profile.getByLabel("选择 p-3").check();
  const deleteSelected = toolbar.getByRole("button", { name: "删除", exact: true });
  await expect(deleteSelected).toBeEnabled();
  await deleteSelected.click();
  const deleteDialog = page.getByRole("dialog", { name: "删除 1 条消息" });
  await expect(deleteDialog.getByRole("button", { name: /为所有人删除/ })).toHaveCount(0);
  await deleteDialog.getByRole("button", { name: "仅对我删除" }).click();
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("message deletion keeps safety actions separate and exposes only allowed scopes", async ({ page }) => {
  await page.goto("/");

  const incoming = await revealVirtualMessage(page, "p-4");
  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  let menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "举报" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "删除" }).click();

  let dialog = page.getByRole("dialog", { name: "删除消息" });
  await expect(dialog).toContainText("我把交互稿更新到最新版本了");
  await expect(dialog.getByRole("button", { name: "仅对我删除" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /为所有人删除/ })).toHaveCount(0);
  await expect(dialog.getByText("Fuck Off", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消" }).click();

  const outgoing = await revealVirtualMessage(page, "p-2");
  await outgoing.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await menu.getByRole("menuitem", { name: "删除" }).click();

  dialog = page.getByRole("dialog", { name: "删除消息" });
  await expect(dialog.getByRole("button", { name: /仅对我删除/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "为所有人删除" })).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();

  await page.setViewportSize({ width: 390, height: 700 });
  await page.locator('[data-chat-id="chat-product"]').click();
  const mobileIncoming = await revealVirtualMessage(page, "p-4");
  await mobileIncoming.locator(".message-bubble-shell").click({ button: "right" });
  await page.getByRole("menu", { name: "消息操作" }).getByRole("menuitem", { name: "删除" }).click();
  dialog = page.getByRole("dialog", { name: "删除消息" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(16);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(374);
  expect(bounds!.y).toBeGreaterThanOrEqual(16);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(684);
  expect(await horizontalOverflow(page)).toBe(false);
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
  await assertDarkHover(page.locator(".chat-row").first());
  await assertDarkHover(page.locator(".conversation-profile-trigger"));

  const profile = page.getByRole("dialog", { name: "资料" });
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  await expect(profile).toBeVisible();
  await expect(profile).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(profile).toHaveCSS("border-color", "rgb(70, 80, 90)");
  await assertDarkHover(profile.locator(".profile-member-identity").first());

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

test("channel posts expose views, forwards, and author metadata without a sync forward label", async ({ page }) => {
  await page.goto("/");
  const linked = page.locator('[data-message-id="p-channel-reply"]');
  await expect(linked).toBeVisible();
  await expect(linked.locator(".message-forward-label")).toHaveCount(0);
  await expect(linked.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(linked.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(linked.locator(".message-channel-author")).toHaveText("Release editor");

  await page.locator('[data-chat-id="chat-release"]').click();
  const post = page.locator('[data-message-id="release-post-1"]');
  await expect(post).toBeVisible();
  await expect(post.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(post.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(post.locator(".message-channel-author")).toHaveText("Release editor");
});

test("reply previews jump to their source and channel senders keep their identity", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const channelMessage = page.locator('[data-message-id="p-channel-reply"]');
  await expect(channelMessage).toBeVisible();
  await expect(channelMessage.locator(".message-sender")).toHaveText("Release Notes");
  await expect(channelMessage.locator(".message-forward-label")).toHaveCount(0);
  await expect(channelMessage.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(channelMessage.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(channelMessage.locator(".message-channel-author")).toHaveText("Release editor");
  await expect(page.locator('.message-group:has([data-message-id="p-channel-reply"]) .message-group-avatar .avatar')).toContainText("R");
  await expect(channelMessage.locator(".message-reply-preview")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const [replyBounds, bubbleBounds] = await Promise.all([
    channelMessage.locator(".message-reply-preview").boundingBox(),
    channelMessage.locator(".message-bubble").boundingBox(),
  ]);
  expect(Math.abs(
    replyBounds!.x + replyBounds!.width - (bubbleBounds!.x + bubbleBounds!.width - 10),
  )).toBeLessThanOrEqual(1);
  await expect(channelMessage.getByRole("button", { name: "前往频道原消息" })).toHaveCount(0);

  await page.evaluate(() => {
    type JumpSample = {
      scrollTop: number;
      placeholder: boolean;
      snapshot: boolean;
    };
    const state = { samples: [] as JumpSample[], running: false };
    const globalState = globalThis as typeof globalThis & {
      __notgramJumpTrace?: typeof state;
    };
    globalState.__notgramJumpTrace = state;
    document.querySelector('[data-message-id="p-channel-reply"] .message-reply-preview')
      ?.addEventListener("pointerdown", () => {
        if (state.running) return;
        state.running = true;
        const startedAt = performance.now();
        const sample = () => {
          const list = document.querySelector<HTMLElement>(".message-list");
          state.samples.push({
            scrollTop: list?.scrollTop ?? -1,
            placeholder: Boolean(document.querySelector(".message-positioning-placeholder")),
            snapshot: Boolean(document.querySelector(
              "[data-conversation-switch-snapshot], [data-conversation-motion-snapshot]",
            )),
          });
          if (performance.now() - startedAt < 700) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true });
  });
  await channelMessage.locator(".message-reply-preview").click();
  const target = page.locator('[data-message-id="p-old-8"]');
  await expect(target).toHaveClass(/is-notification-target/);
  await expect.poll(() => target.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  })).toBeLessThan(2);
  await page.waitForTimeout(720);
  const jumpReport = await page.evaluate(() => {
    type JumpSample = { scrollTop: number; placeholder: boolean; snapshot: boolean };
    const globalState = globalThis as typeof globalThis & {
      __notgramJumpTrace?: { samples: JumpSample[] };
    };
    const samples = globalState.__notgramJumpTrace?.samples ?? [];
    let direction = 0;
    let visibleReversals = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].snapshot) continue;
      const delta = samples[index].scrollTop - samples[index - 1].scrollTop;
      if (Math.abs(delta) < 0.5) continue;
      const nextDirection = Math.sign(delta);
      if (direction && direction !== nextDirection) visibleReversals += 1;
      direction = nextDirection;
    }
    return {
      visibleReversals,
      placeholderFrames: samples.filter((sample) => sample.placeholder).length,
    };
  });
  expect(jumpReport.visibleReversals).toBe(0);
  expect(jumpReport.placeholderFrames).toBe(0);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  await expect(target.locator(".message-bubble")).toHaveCSS("outline-style", "none");

  await openConversationMessageSearch(page);
  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await search.fill("Release Notes channel posted this reply");
  await page.locator('.chat-search-results-panel [data-search-message-id="p-channel-reply"]').click();
  await page.locator('[data-message-id="p-channel-reply"] .message-sender').click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Release Notes" })).toBeVisible();
  await profile.getByRole("button", { name: "关闭资料" }).click();

});

test("Telegram links navigate internally and incompatible routes stay in Notgram", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const initialPageCount = context.pages().length;

  await page.locator('[data-message-id="p-markdown"]').getByRole("link", { name: "链接" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  expect(context.pages()).toHaveLength(initialPageCount);

  await page.locator('[data-chat-id="chat-product"]').click();
  const themeLink = page.locator('[data-message-id="p-rich-entities"]').getByRole("link", { name: "link" });
  await expect(themeLink).toBeVisible();
  await themeLink.click();

  await expect(page.getByRole("alert")).toContainText("Telegram 主题链接与 Notgram 不兼容");
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  expect(context.pages()).toHaveLength(initialPageCount);
});

test("TDLib mentions open user and bot profiles without leaving the conversation", async ({ page, context }) => {
  await page.goto("/");
  const initialPageCount = context.pages().length;
  const row = await revealVirtualMessage(page, "p-rich-entities");

  const userMention = row.getByRole("link", { name: "@mia_design" });
  await expect(userMention).toHaveAttribute("href", "https://t.me/mia_design");
  await userMention.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
  await profile.getByRole("button", { name: "关闭资料" }).click();

  const botRow = await revealVirtualMessage(page, "p-rich-entities");
  await botRow.getByRole("link", { name: "@notgram_bot" }).click();
  await expect(profile.getByRole("heading", { name: "Notgram Bot" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  expect(context.pages()).toHaveLength(initialPageCount);
});

test("chat list hides its scrollbar and the conversation title has no hover highlight", async ({ page }) => {
  await page.goto("/");
  const chatList = page.locator(".chat-list");
  await expect(chatList).toHaveCSS("scrollbar-width", "none");

  const title = page.locator(".conversation-profile-trigger");
  const backgroundBeforeHover = await title.evaluate((element) => getComputedStyle(element).backgroundColor);
  await title.hover();
  await expect(title).toHaveCSS("background-color", backgroundBeforeHover);
});

test("distant message jumps use a directional exit and entrance transition", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const source = page.locator('[data-message-id="p-channel-reply"]');
  await source.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveCount(0);
  await page.evaluate(() => {
    const originalAnimate = Element.prototype.animate;
    const records: Array<{ duration: number; firstOpacity?: number; lastOpacity?: number }> = [];
    (globalThis as typeof globalThis & { __notgramJumpAnimations?: typeof records })
      .__notgramJumpAnimations = records;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains("message-list-content") && Array.isArray(keyframes)) {
        const timing = typeof options === "number" ? { duration: options } : options;
        records.push({
          duration: Number(timing?.duration ?? 0),
          firstOpacity: Number(keyframes[0]?.opacity),
          lastOpacity: Number(keyframes.at(-1)?.opacity),
        });
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });

  await source.locator(".message-reply-preview").click();
  const target = page.locator('[data-message-id="p-old-8"]');
  await expect(target).toHaveClass(/is-notification-target/);
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramJumpAnimations?: unknown[] }
  ).__notgramJumpAnimations?.length ?? 0)).toBe(2);
  const animations = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __notgramJumpAnimations?: Array<{ duration: number; firstOpacity?: number; lastOpacity?: number }>;
    }
  ).__notgramJumpAnimations ?? []);
  expect(animations).toEqual([
    expect.objectContaining({ duration: 110, firstOpacity: 1, lastOpacity: 0.22 }),
    expect.objectContaining({ duration: 210, firstOpacity: 0.22, lastOpacity: 1 }),
  ]);
  await expect.poll(() => target.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return list
      ? Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2)
      : Number.POSITIVE_INFINITY;
  })).toBeLessThan(2);
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
});

test("forward source labels open the original message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const forwardedMessage = page.locator('[data-message-id="p-channel-reply"]');
  const sourceButton = forwardedMessage.getByRole("button", { name: "打开频道原消息：Release editor" });
  await expect(sourceButton).toBeVisible();
  await sourceButton.click();

  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");
  const originalMessage = page.locator('[data-message-id="release-post-1"]');
  await expect(originalMessage).toBeVisible();
  await expect(originalMessage).toHaveClass(/is-notification-target/);
});

test("text message time releases reserved inline space when it wraps", async ({ page }) => {
  await page.goto("/");
  const shortMessage = page.locator('[data-message-id="p-rich-entities"]');
  await expect(shortMessage.locator('.message-rich-text[data-rich-text="entities"]')).toBeVisible();
  const shortGeometry = await shortMessage.evaluate((element) => {
    const text = element.querySelector<HTMLElement>(".message-rich-text");
    const meta = element.querySelector<HTMLElement>(".message-meta");
    const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const stack = element.closest<HTMLElement>(".message-group-stack");
    if (!text || !meta || !shell || !bubble || !stack) return undefined;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lastLine = [...range.getClientRects()].at(-1);
    const metaBounds = meta.getBoundingClientRect();
    return {
      lastLineTop: lastLine?.top,
      lastLineBottom: lastLine?.bottom,
      lastLineRight: lastLine?.right,
      metaTop: metaBounds.top,
      metaBottom: metaBounds.bottom,
      metaLeft: metaBounds.left,
      metaRight: metaBounds.right,
      bubbleRight: bubble.getBoundingClientRect().right,
      shellWidth: shell.getBoundingClientRect().width,
      stackWidth: stack.getBoundingClientRect().width,
    };
  });
  expect(shortGeometry).toBeTruthy();
  expect(shortGeometry!.metaBottom - shortGeometry!.lastLineBottom!).toBeGreaterThanOrEqual(2);
  expect(shortGeometry!.metaBottom - shortGeometry!.lastLineBottom!).toBeLessThanOrEqual(3);
  expect(shortGeometry!.metaLeft).toBeGreaterThan(shortGeometry!.lastLineRight!);
  expect(Math.abs(shortGeometry!.metaRight - (shortGeometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
  expect(shortGeometry!.shellWidth).toBeLessThanOrEqual(Math.min(shortGeometry!.stackWidth * 0.74, 720) + 1);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) => (
      message.id === "p-rich-entities"
        ? {
            ...message,
            senderId: "self",
            outgoing: true,
            editedAt: "2026-08-01T09:49:00+08:00",
            delivery: "read",
            content: {
              kind: "text",
              text: "而且现在服务端已有自动重试的能力了，加一个异常匹配的事情",
            },
          }
        : message
    )));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const longMessage = shortMessage;
  await longMessage.evaluate((element) => {
    const group = element.closest<HTMLElement>(".message-group");
    if (group) group.style.width = "648px";
  });
  await expect(longMessage.locator(".message-bubble")).toHaveClass(/has-wrapped-meta/);
  await expect(longMessage.locator(".message-bubble")).toHaveCSS("padding-bottom", "2px");
  await expect(longMessage.locator(".message-meta")).toHaveCSS("float", "none");
  const releasedGeometry = await longMessage.locator(".message-bubble-shell").evaluate((shell) => {
    const text = shell.querySelector<HTMLElement>(".message-rich-text");
    const meta = shell.querySelector<HTMLElement>(".message-meta");
    const bubble = shell.querySelector<HTMLElement>(".message-bubble");
    const flow = shell.querySelector<HTMLElement>(".message-text-flow");
    if (!text || !meta || !bubble || !flow) return undefined;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lastLine = [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1);
    if (!lastLine) return undefined;
    const flowBounds = flow.getBoundingClientRect();
    const flowStyle = getComputedStyle(flow);
    const metaBounds = meta.getBoundingClientRect();
    return {
      availableInlineSpace: flowBounds.right - Number.parseFloat(flowStyle.paddingRight) - lastLine.right,
      textWidth: lastLine.width,
      metaWidth: metaBounds.width,
      metaRight: metaBounds.right,
      bubbleWidth: bubble.getBoundingClientRect().width,
      bubbleRight: bubble.getBoundingClientRect().right,
      metaTop: metaBounds.top,
      lastLineBottom: lastLine.bottom,
      lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
    };
  });
  expect(releasedGeometry).toBeTruthy();
  expect(Math.abs(releasedGeometry!.bubbleWidth - releasedGeometry!.textWidth - 20)).toBeLessThanOrEqual(1);
  expect(releasedGeometry!.availableInlineSpace).toBeLessThan(releasedGeometry!.metaWidth + 8);
  expect(Math.abs(releasedGeometry!.metaRight - (releasedGeometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
  const wrappedGap = releasedGeometry!.metaTop - releasedGeometry!.lastLineBottom;
  expect(wrappedGap).toBeGreaterThanOrEqual(1);
  expect(wrappedGap).toBeLessThan(releasedGeometry!.lineHeight * 0.4);

  await longMessage.evaluate((element) => {
    const group = element.closest<HTMLElement>(".message-group");
    if (group) group.style.width = "900px";
  });
  await expect(longMessage.locator(".message-text-flow")).not.toHaveClass(/is-meta-wrapped/);
  await expect(longMessage.locator(".message-meta")).toHaveCSS("float", "right");
});

test("collapsed long text keeps metadata on its own right-aligned row", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /收藏夹/ }).click();
  const row = page.locator('[data-message-id="p-long-text"]');
  await expect(row).toBeVisible();
  await page.evaluate(async (storePath) => {
    const { preferencesStore } = await import(storePath);
    preferencesStore.setState({ messageCollapseThresholdLines: 20, messageCollapsedLines: 10 });
  }, "/src/store/preferencesStore.ts");

  const flow = row.locator(".message-text-flow");
  await expect(flow).toHaveClass(/is-text-collapsible/);
  await expect(flow).toHaveClass(/is-meta-wrapped/);
  await expect(flow.locator(".message-meta")).toHaveCSS("float", "none");
  const geometry = await row.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const meta = element.querySelector<HTMLElement>(".message-meta");
    if (!bubble || !meta) return undefined;
    return {
      metaRight: meta.getBoundingClientRect().right,
      bubbleRight: bubble.getBoundingClientRect().right,
    };
  });
  expect(geometry).toBeTruthy();
  expect(Math.abs(geometry!.metaRight - (geometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
});

test("media cards preserve media width while giving captions a stable reading width", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Mia Chen/ }).first().click();

  const geometryFor = async (messageId: string) => {
    const row = page.locator(`[data-message-id="${messageId}"]`);
    await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
    await expect.poll(() => row.locator(".photo-preview img").evaluate((image) => {
      const media = image as HTMLImageElement;
      return media.complete && media.naturalWidth > 0 && media.naturalHeight > 0;
    })).toBe(true);
    return row.evaluate((element) => {
      const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
      const preview = element.querySelector<HTMLElement>(".photo-preview");
      const image = element.querySelector<HTMLImageElement>(".photo-preview img");
      const caption = element.querySelector<HTMLElement>(".photo-caption");
      const meta = element.querySelector<HTMLElement>(".message-meta");
      if (!shell || !preview || !image || !caption || !meta) return undefined;
      const shellBounds = shell.getBoundingClientRect();
      const previewBounds = preview.getBoundingClientRect();
      const scale = Math.min(
        previewBounds.width / image.naturalWidth,
        previewBounds.height / image.naturalHeight,
      );
      const range = document.createRange();
      range.selectNodeContents(caption);
      const captionLastLine = [...range.getClientRects()].at(-1);
      const metaBounds = meta.getBoundingClientRect();
      return {
        shellWidth: shellBounds.width,
        previewWidth: previewBounds.width,
        previewHeight: previewBounds.height,
        captionHeight: caption.getBoundingClientRect().height,
        captionLastLineBottom: captionLastLine?.bottom,
        captionLastLineRight: captionLastLine?.right,
        metaTop: metaBounds.top,
        metaBottom: metaBounds.bottom,
        metaLeft: metaBounds.left,
        metaRight: metaBounds.right,
        captionFlowHeight: element.querySelector<HTMLElement>(".photo-caption-flow")?.getBoundingClientRect().height,
        horizontalLetterbox: (previewBounds.width - image.naturalWidth * scale) / 2,
        verticalLetterbox: (previewBounds.height - image.naturalHeight * scale) / 2,
        objectFit: getComputedStyle(image).objectFit,
      };
    });
  };

  const tall = await geometryFor("m-tall-caption");
  expect(tall).toBeDefined();
  expect(tall?.shellWidth).toBeCloseTo(320, 0);
  expect(Math.abs((tall?.shellWidth ?? 0) - (tall?.previewWidth ?? 1))).toBeLessThanOrEqual(1);
  expect(tall?.captionHeight).toBeLessThan(50);
  expect(tall?.horizontalLetterbox).toBeGreaterThan(50);
  expect(tall?.verticalLetterbox).toBeLessThanOrEqual(1);
  expect(tall?.objectFit).toBe("contain");

  const wide = await geometryFor("m-wide-caption");
  expect(wide).toBeDefined();
  expect(wide?.shellWidth).toBeCloseTo(390, 0);
  expect(Math.abs((wide?.shellWidth ?? 0) - (wide?.previewWidth ?? 1))).toBeLessThanOrEqual(1);
  expect(wide?.horizontalLetterbox).toBeLessThanOrEqual(1);
  expect(wide?.verticalLetterbox).toBeLessThanOrEqual(1);
  expect(wide?.objectFit).toBe("contain");
  expect(wide?.captionLastLineBottom).toBeDefined();
  expect(wide?.captionLastLineRight).toBeDefined();
  expect(Math.abs(wide!.metaBottom! - wide!.captionLastLineBottom!)).toBeLessThan(5);
  expect(wide!.metaLeft!).toBeGreaterThan(wide!.captionLastLineRight!);
  expect(wide!.captionFlowHeight!).toBeLessThan(32);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const chatMessages = state.messages.get("chat-mia") ?? [];
    const source = chatMessages.find((message) => message.id === "m-tall-caption");
    if (!source) throw new Error("Missing portrait media fixture");
    const messages = new Map(state.messages);
    messages.set("chat-mia", [
      ...chatMessages,
      {
        ...source,
        id: "m-tall-caption-outgoing",
        senderId: "self",
        outgoing: true,
        sentAt: "2026-08-01T09:27:00+08:00",
        editedAt: "2026-08-01T09:28:00+08:00",
        content: {
          ...(source.content as Record<string, unknown>),
          caption: "媒体说明".repeat(15),
        },
      },
    ]);
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const outgoingTall = await geometryFor("m-tall-caption-outgoing");
  expect(outgoingTall).toBeDefined();
  expect(Math.abs(outgoingTall!.shellWidth - tall!.shellWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(outgoingTall!.previewHeight - tall!.previewHeight)).toBeLessThanOrEqual(1);
  const outgoingCaption = page.locator('[data-message-id="m-tall-caption-outgoing"] .photo-caption-flow');
  await expect(outgoingCaption).toHaveClass(/is-meta-wrapped/);
  await expect(outgoingCaption.locator(".message-meta")).toHaveCSS("float", "none");

  await page.setViewportSize({ width: 360, height: 760 });
  const narrowTall = await geometryFor("m-tall-caption");
  expect(narrowTall).toBeDefined();
  expect(narrowTall!.previewWidth).toBeLessThan(320);
  expect(narrowTall!.previewWidth / narrowTall!.previewHeight).toBeCloseTo(320 / 420, 2);
});

test("pasted images preview, respect Telegram's album limit, and send as one album", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    for (let index = 1; index <= 11; index += 1) {
      data.items.add(new File([bytes], `paste-${index}.png`, { type: "image/png" }));
    }
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });

  const preview = page.getByRole("region", { name: "待发送附件" });
  await expect(preview.locator(".composer-attachment-item")).toHaveCount(10);
  await expect(preview.getByRole("alert")).toHaveText("一次最多发送 10 个附件");
  await expect(preview.getByRole("radio", { name: "媒体" })).toBeChecked();
  await expect(preview.getByRole("radio", { name: "原文件" })).not.toBeChecked();
  await expect(preview.getByRole("checkbox", { name: "剧透" })).toBeEnabled();
  await expect(preview.getByRole("checkbox", { name: "说明置顶" })).toBeEnabled();
  for (let index = 10; index >= 3; index -= 1) {
    await preview.getByRole("button", { name: `移除 paste-${index}.png` }).click();
  }
  await composer.fill("粘贴图片说明");
  await composer.press("Enter");
  await expect(preview).toBeHidden();
  await expect(composer).toHaveValue("");
  const sentAlbum = page.locator(".media-album", { hasText: "粘贴图片说明" });
  await expect(sentAlbum.locator(".media-album-grid img")).toHaveCount(2);
  await expect(sentAlbum.locator(".media-album-caption")).toHaveText("粘贴图片说明");
  await expect(composer).toBeFocused();

  await composer.fill("短说明不应收窄图片");
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    data.items.add(new File([bytes], "outgoing-caption.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await composer.press("Enter");
  const sentPhoto = page.locator('.message-row.is-outgoing', { hasText: "短说明不应收窄图片" }).last();
  await expect.poll(() => sentPhoto.locator(".photo-preview").evaluate(
    (element) => element.getBoundingClientRect().width,
  )).toBeGreaterThan(380);
  await expect(composer).toBeFocused();

  await composer.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["pasted document"], "pasted-notes.txt", { type: "text/plain" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await expect(preview.locator(".composer-file-preview")).toBeVisible();
  await expect(preview).toContainText("pasted-notes.txt");
  await composer.press("Enter");
  await expect(page.locator(".file-message", { hasText: "pasted-notes.txt" })).toBeVisible();
});

test("poll messages support voting, results, and revoking an answer", async ({ page }) => {
  await page.goto("/");
  const poll = page.getByRole("region", { name: "投票" });
  await expect(poll).toBeVisible();
  await expect(poll.getByText("下一轮优先验证哪一项？")).toBeVisible();
  const firstOption = poll.getByRole("button", { name: /原生媒体发送/ });
  await firstOption.click();
  await expect(firstOption).toHaveAttribute("aria-pressed", "true");
  await expect(poll.getByText("11 票")).toBeVisible();
  await expect(firstOption).toContainText("64%");
  await poll.getByRole("button", { name: "撤回投票" }).click();
  await expect(poll.getByText("10 票")).toBeVisible();
  await expect(firstOption).toHaveAttribute("aria-pressed", "false");
});

test("audio messages continue to the next item in the same conversation", async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as {
      __notgramAudioContext?: { state: string };
      __notgramAudioLifecycle: string[];
    };
    scope.__notgramAudioLifecycle = [];
    class TestAudioContext {
      state = "suspended";
      destination = {};

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 128,
          connect: () => undefined,
          getByteFrequencyData: (values: Uint8Array) => values.fill(0),
        };
      }

      createMediaElementSource() {
        return { connect: () => undefined };
      }

      resume() {
        scope.__notgramAudioLifecycle.push("resume");
        this.state = "running";
        return Promise.resolve();
      }

      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: class extends TestAudioContext {
        constructor() {
          super();
          scope.__notgramAudioContext = this;
        }
      },
    });
  });
  await page.goto("/");
  await expect(page.locator('[data-message-id="p-audio"] audio')).toHaveCount(0);
  const audioEngine = page.locator(".persistent-audio-engine");
  await expect(audioEngine).toHaveCount(1);
  await expect(audioEngine).toHaveAttribute("crossorigin", "anonymous");
  await page.evaluate(() => {
    const scope = window as unknown as {
      __notgramAudioLifecycle: string[];
      __notgramAudioPlayCalls: string[];
    };
    scope.__notgramAudioPlayCalls = [];
    HTMLMediaElement.prototype.play = function play() {
      const playbackId = this.dataset.playbackId;
      if (playbackId) {
        scope.__notgramAudioLifecycle.push("play");
        scope.__notgramAudioPlayCalls.push(playbackId);
      }
      return Promise.resolve();
    };
  });
  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioPlayCalls: string[] }
  ).__notgramAudioPlayCalls)).toContain("chat-product:p-audio");
  await expect(audioEngine).toHaveAttribute("src", /mock-video\.mp4/);
  await expect(audioEngine).toHaveJSProperty("muted", false);
  await expect(audioEngine).toHaveJSProperty("volume", 1);
  expect(await page.evaluate(() => (
    window as unknown as { __notgramAudioLifecycle: string[] }
  ).__notgramAudioLifecycle.slice(0, 2))).toEqual(["resume", "play"]);
  await page.evaluate(() => {
    const scope = window as unknown as {
      __notgramAudioContext?: { state: string };
    };
    if (scope.__notgramAudioContext) scope.__notgramAudioContext.state = "suspended";
    document.querySelector<HTMLAudioElement>(".persistent-audio-engine")
      ?.dispatchEvent(new Event("playing"));
  });
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioLifecycle: string[] }
  ).__notgramAudioLifecycle.filter((event) => event === "resume").length)).toBe(2);
  await audioEngine.evaluate((audio) => audio.dispatchEvent(new Event("ended")));
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioPlayCalls: string[] }
  ).__notgramAudioPlayCalls)).toContain("chat-product:p-audio-next");
});

test("audio controls remember volume and keep the collapsible player inside the conversation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });

  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  const audioEngine = page.locator(".persistent-audio-engine");
  const controller = page.getByRole("complementary", { name: "正在播放 产品语音.m4a" });
  await expect(controller).toBeVisible();
  const expandedBounds = await controller.boundingBox();

  const volume = controller.getByRole("slider", { name: "音量" });
  await volume.fill("0.35");
  await expect(audioEngine).toHaveJSProperty("volume", 0.35);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("notgram.audio.volume")))
    .toBe("0.35");
  await controller.getByRole("button", { name: "静音" }).click();
  await expect(audioEngine).toHaveJSProperty("muted", true);
  await expect(controller.getByRole("button", { name: "取消静音" })).toBeVisible();
  await volume.fill("0.55");
  await expect(audioEngine).toHaveJSProperty("muted", false);
  await expect(audioEngine).toHaveJSProperty("volume", 0.55);

  const conversation = page.locator(".conversation");
  await expect(controller.getByRole("button", { name: /拖动播放器/ })).toHaveCount(0);
  const controllerBounds = await controller.boundingBox();
  expect(controllerBounds).not.toBeNull();
  await page.mouse.move(controllerBounds!.x + 12, controllerBounds!.y + controllerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, 0, { steps: 3 });
  await page.mouse.up();

  const topLeft = await controller.boundingBox();
  const conversationBounds = await conversation.boundingBox();
  expect(topLeft).not.toBeNull();
  expect(conversationBounds).not.toBeNull();
  expect(topLeft!.x).toBeGreaterThanOrEqual(conversationBounds!.x + 11);
  expect(topLeft!.y).toBeGreaterThanOrEqual(conversationBounds!.y + 11);

  const movedControllerBounds = await controller.boundingBox();
  await page.mouse.move(
    movedControllerBounds!.x + 12,
    movedControllerBounds!.y + movedControllerBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(2_000, 2_000, { steps: 3 });
  await page.mouse.up();
  const bottomRight = await controller.boundingBox();
  expect(bottomRight!.x + bottomRight!.width)
    .toBeLessThanOrEqual(conversationBounds!.x + conversationBounds!.width - 11);
  expect(bottomRight!.y + bottomRight!.height)
    .toBeLessThanOrEqual(conversationBounds!.y + conversationBounds!.height - 11);

  const movedPlay = controller.getByRole("button", { name: "暂停" });
  const movedPlayBounds = await movedPlay.boundingBox();
  await page.mouse.move(
    movedPlayBounds!.x + movedPlayBounds!.width / 2,
    movedPlayBounds!.y + movedPlayBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    movedPlayBounds!.x - 80,
    movedPlayBounds!.y - 60,
    { steps: 3 },
  );
  await page.mouse.up();
  await expect(movedPlay).toBeVisible();

  await controller.getByRole("button", { name: "缩小播放器" }).click();
  await expect(controller).toHaveClass(/is-compact/);
  await expect(controller.locator(".audio-floating-progress")).toHaveCount(0);
  await expect(controller.locator(".audio-spectrum")).toHaveCount(0);
  await expect(controller.getByRole("button", { name: "暂停" })).toBeVisible();
  await expect(controller.getByRole("button", { name: "展开播放器" })).toBeVisible();
  const compactBounds = await controller.boundingBox();
  expect(compactBounds!.width).toBeLessThan(expandedBounds!.width);
});

test("audio message controls remain inside their bubble at narrow conversation widths", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  const audio = page.getByRole("group", { name: "产品语音.m4a" });
  const bubble = audio.locator("xpath=ancestor::*[contains(@class, 'message-bubble')][1]");
  await expect(audio).toBeVisible();
  const geometry = await audio.evaluate((element) => {
    const bubbleElement = element.closest<HTMLElement>(".message-bubble");
    const player = element.getBoundingClientRect();
    const parent = bubbleElement?.getBoundingClientRect();
    return { player, parent };
  });
  expect(geometry.parent).toBeTruthy();
  expect(geometry.player.left).toBeGreaterThanOrEqual(geometry.parent!.left - 0.5);
  expect(geometry.player.right).toBeLessThanOrEqual(geometry.parent!.right + 0.5);
  expect(geometry.player.top).toBeGreaterThanOrEqual(geometry.parent!.top - 0.5);
  expect(geometry.player.bottom).toBeLessThanOrEqual(geometry.parent!.bottom + 0.5);
  expect(geometry.player.width).toBeLessThanOrEqual(geometry.parent!.width);
  await expect(bubble).toHaveCount(1);
});

test("download manager lists only explicit downloads and supports batch management", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+j");
  const dialog = page.getByRole("dialog", { name: "下载" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("暂无下载")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭下载管理" }).click();

  await page.evaluate(async (storePath) => {
    type TestMessage = { id: string; content: { kind: string; [key: string]: unknown }; [key: string]: unknown };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: {
          messages: Map<string, TestMessage[]>;
          downloadFile: (fileId: number, fileName: string) => Promise<void>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
      message.id === "p-file-downloading" && message.content.kind === "file"
        ? {
            ...message,
            content: {
              ...message.content,
              isDownloading: false,
              isDownloaded: false,
              progress: undefined,
              downloadedSize: undefined,
            },
          }
        : message
    ));
    storeModule.telegramStore.setState({
      messages,
      downloadFile: async () => new Promise<void>(() => undefined),
    });
  }, "/src/store/telegramStore.ts");

  const fileMessage = await revealVirtualMessage(page, "p-file-downloading");
  await expect(fileMessage.getByRole("button", { name: "下载 research-notes.zip" })).toHaveCount(1);
  await fileMessage.getByRole("button", { name: "下载 research-notes.zip" }).click();
  await page.evaluate(async (storePath) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
      message.id === "p-file-downloading"
        ? {
            ...message,
            content: {
              ...(message.content as Record<string, unknown>),
              isDownloading: true,
              progress: 0,
            },
          }
        : message
    ));
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  await page.keyboard.press("Control+j");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("research-notes.zip", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "research-notes.zip 下载进度" })).toHaveAttribute("aria-valuenow", "0");
  await page.setViewportSize({ width: 375, height: 667 });
  await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("checkbox", { name: "选择 research-notes.zip" }).check();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog.getByText("已取消", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "移除", exact: true }).click();
  await expect(dialog.getByText("暂无下载")).toBeVisible();
});

test("stale cached photos request recovery and render the refreshed local source", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (storePath) => {
    type TestMessage = { id: string; content: { kind: string; [key: string]: unknown }; [key: string]: unknown };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: {
          messages?: Map<string, TestMessage[]>;
          recoverFile?: (fileId: number) => Promise<boolean>;
        }) => void;
      };
    };
    const updatePhoto = (localPath: string) => {
      const state = storeModule.telegramStore.getState();
      const messages = new Map(state.messages);
      messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
        message.id === "p-5" && message.content.kind === "media"
          ? {
              ...message,
              content: {
                ...message.content,
                fileId: 510,
                localPath,
                isDownloaded: true,
                isDownloading: false,
              },
            }
          : message
      ));
      storeModule.telegramStore.setState({ messages });
    };
    (window as unknown as { __notgramRecoveredFiles: number[] }).__notgramRecoveredFiles = [];
    storeModule.telegramStore.setState({
      recoverFile: async (fileId: number) => {
        (window as unknown as { __notgramRecoveredFiles: number[] }).__notgramRecoveredFiles.push(fileId);
        updatePhoto("/mock-video-poster.jpg");
        return true;
      },
    });
    updatePhoto("/missing-cleared-cache-photo.jpg");
  }, "/src/store/telegramStore.ts");

  const photoMessage = await revealVirtualMessage(page, "p-5");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramRecoveredFiles: number[] }
  ).__notgramRecoveredFiles)).toContain(510);
  await expect(photoMessage.locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
});

test("unloaded media uses a blurred glass preview instead of exposing thumbnail pixels", async ({ page }) => {
  await page.goto("/");
  const preview = page.locator('[data-message-id="p-5"] .photo-preview');
  await expect(preview).toHaveClass(/is-preview-only/);
  await expect(preview.locator("img")).toHaveCSS("filter", /blur\(18px\)/);
  await expect(page.locator('[data-message-id="p-video"] .photo-preview')).not.toHaveClass(/is-preview-only/);
});

test("single-clicking a photo opens a dedicated fullscreen viewer with wheel zoom and dragging", async ({ page }) => {
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.locator('[data-message-id="p-5"] .photo-open').click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");

  await expect(page.getByRole("dialog", { name: "图片查看器：界面预览.jpg" })).toHaveCount(0);
  await expect(popup.getByRole("dialog", { name: "图片查看器：界面预览.jpg" })).toBeVisible();
  const viewer = popup.locator(".media-viewer");
  const viewerBounds = await popup.locator(".media-viewer-backdrop").boundingBox();
  const viewport = popup.viewportSize();
  expect(viewerBounds).toEqual({ x: 0, y: 0, width: viewport?.width, height: viewport?.height });
  await expect(popup.locator(".media-viewer-backdrop")).toHaveCSS(
    "background-color",
    "rgba(20, 26, 30, 0.48)",
  );
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  const thumbnails = viewer.getByRole("navigation", { name: "会话图片预览" });
  await expect(thumbnails.getByRole("button")).toHaveCount(2);
  await expect(thumbnails.locator("img")).toHaveCount(2);
  await expect(thumbnails.locator("img").first()).toHaveAttribute("loading", "eager");
  await expect.poll(() => thumbnails.locator("img").evaluateAll((images) =>
    images.every((image) => {
      const imageElement = image as HTMLImageElement;
      return imageElement.complete && imageElement.naturalWidth > 0;
    }),
  )).toBe(true);
  await expect(thumbnails.getByRole("button", { name: "查看 界面预览.jpg" }))
    .toHaveAttribute("aria-current", "true");

  const stage = popup.locator(".media-viewer-stage");
  await stage.hover();
  await popup.keyboard.down("Control");
  await popup.mouse.wheel(0, -240);
  await popup.keyboard.up("Control");
  await expect(viewer.locator(".media-viewer-zoom")).toHaveText("150%");
  const stageBounds = await stage.boundingBox();
  await popup.mouse.move(stageBounds!.x + stageBounds!.width / 2, stageBounds!.y + stageBounds!.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(stageBounds!.x + stageBounds!.width / 2 + 48, stageBounds!.y + stageBounds!.height / 2 + 32);
  await popup.mouse.up();
  await expect(popup.locator(".media-viewer-image")).toHaveAttribute("style", /translate\(48px, 32px\) scale\(1\.5\)/);
  await popup.keyboard.press("ArrowLeft");
  await expect(viewer.locator(".media-viewer-title strong")).toHaveText("纵向图片.jpg");
  await thumbnails.getByRole("button", { name: "查看 界面预览.jpg" }).click();
  await expect(viewer.locator(".media-viewer-title strong")).toHaveText("界面预览.jpg");

  const closed = popup.waitForEvent("close");
  const finalStageBounds = await stage.boundingBox();
  await popup.mouse.click(finalStageBounds!.x + 8, finalStageBounds!.y + 8);
  await closed;
  await expect(page.locator(".conversation")).toBeVisible();
});

test("chat switching and ordinary message interactions keep typing focus in the composer", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(composer).toBeFocused();
  await page.locator('[data-message-id="m-3"] .message-rich-text').click();
  await expect(composer).toBeFocused();

  await openConversationMessageSearch(page);
  await expect(page.getByRole("searchbox", { name: "搜索会话和消息" })).toBeFocused();
  await expect(page.getByRole("group", { name: "搜索范围：Mia Chen" })).toBeVisible();
});

test("selecting message text is not interrupted by composer autofocus", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();

  const composer = page.getByRole("textbox", { name: "消息内容" });
  const messageText = page.locator('[data-message-id="m-3"] .message-rich-text');
  await expect(composer).toBeFocused();
  await expect(messageText).toBeVisible();
  await messageText.scrollIntoViewIfNeeded();
  const drag = await messageText.evaluate((surface) => {
    const text = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) return undefined;
    const pointAt = (offset: number) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const bounds = range.getBoundingClientRect();
      return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 };
    };
    return {
      start: pointAt(0),
      end: pointAt(Math.min(8, (text.textContent?.length ?? 1) - 1)),
    };
  });
  expect(drag).toBeTruthy();
  await page.mouse.move(drag!.start.x, drag!.start.y);
  await page.mouse.down();
  await page.mouse.move(drag!.end.x, drag!.end.y, { steps: 12 });
  await page.mouse.up();

  const selectedText = await page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
  expect(selectedText.length).toBeGreaterThan(0);
  await expect(composer).not.toBeFocused();

  // Conversation state changes must not replace the selected native text nodes.
  await page.evaluate(async (storePath) => {
    const { preferencesStore } = await import(storePath);
    const notificationSound = preferencesStore.getState().notificationSound;
    preferencesStore.setState({ notificationSound: !notificationSound });
  }, "/src/store/preferencesStore.ts");
  await page.waitForTimeout(2_000);
  await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
    .toBe(selectedText);

  const dragPoints = await messageText.evaluate((surface) => {
    const otherSurface = [...document.querySelectorAll<HTMLElement>(".message-rich-text")]
      .find((candidate) => candidate !== surface && candidate.textContent?.trim());
    const sourceNode = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
    const otherNode = otherSurface
      ? document.createTreeWalker(otherSurface, NodeFilter.SHOW_TEXT).nextNode()
      : null;
    if (!sourceNode || !otherNode) return undefined;
    const selection = globalThis.getSelection();
    selection?.setBaseAndExtent(sourceNode, Math.min(4, sourceNode.textContent?.length ?? 0), otherNode, 0);
    document.dispatchEvent(new Event("selectionchange"));
    return true;
  });
  expect(dragPoints).toBe(true);
  const boundaryResult = await page.evaluate(() => {
    const selection = globalThis.getSelection();
    const owner = (node: Node | null) => node instanceof Element
      ? node.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
      : node?.parentElement?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    return {
      text: selection?.toString() ?? "",
      anchorMessageId: owner(selection?.anchorNode ?? null),
      focusMessageId: owner(selection?.focusNode ?? null),
    };
  });
  expect(boundaryResult?.text.length).toBeGreaterThan(0);
  expect(boundaryResult?.anchorMessageId).toBe("m-3");
  expect(boundaryResult?.focusMessageId).toBe("m-3");

  await page.locator(".message-list").click({ position: { x: 8, y: 8 } });
  await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
    .toBe("");
  await expect(page.locator(".conversation")).not.toHaveClass(/is-message-text-selecting/);
});

test("primary clicks outside selected message text clear the native selection", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();

  const messageText = page.locator('[data-message-id="m-3"] .message-rich-text');
  await expect(messageText).toBeVisible();
  const selectText = async () => {
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await expect(messageText).toHaveAttribute("data-rich-text", "markdown");
    await messageText.scrollIntoViewIfNeeded();
    const drag = await messageText.evaluate((surface) => {
      const text = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) return undefined;
      const pointAt = (offset: number) => {
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 };
      };
      return {
        start: pointAt(0),
        end: pointAt(Math.min(8, (text.textContent?.length ?? 1) - 1)),
      };
    });
    expect(drag).toBeTruthy();
    await page.mouse.move(drag!.start.x, drag!.start.y);
    await page.mouse.down();
    await page.mouse.move(drag!.end.x, drag!.end.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
      .not.toBe("");
  };
  const expectSelectionCleared = async () => {
    await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
      .toBe("");
    await expect(page.locator(".conversation")).not.toHaveClass(/is-message-text-selecting/);
  };

  await selectText();
  await page.locator(".message-list").click({ position: { x: 8, y: 8 } });
  await expectSelectionCleared();

  await selectText();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expectSelectionCleared();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(messageText).toBeVisible();
  await selectText();
  await page.getByRole("textbox", { name: "消息内容" }).click();
  await expectSelectionCleared();
});

test("replying from selected message text sends only the partial quote", async ({ page }) => {
  await page.goto("/");
  await revealVirtualMessage(page, "p-2");

  const source = page.locator('[data-message-id="p-2"]');
  const messageText = source.locator(".message-rich-text");
  const selectedText = "消息区再留一点呼吸感";
  await messageText.evaluate((surface, quote) => {
    const fullText = surface.textContent ?? "";
    const start = fullText.indexOf(quote);
    if (start < 0) throw new Error("quote fixture was not found");
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const pointAt = (offset: number) => {
      let consumed = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (offset <= consumed + length) return { node, offset: offset - consumed };
        consumed += length;
        node = walker.nextNode();
      }
      throw new Error("selection point was not found");
    };
    const begin = pointAt(start);
    walker.currentNode = surface;
    const end = pointAt(start + quote.length);
    const range = document.createRange();
    range.setStart(begin.node, begin.offset);
    range.setEnd(end.node, end.offset);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, selectedText);
  const quoteBounds = await messageText.boundingBox();
  expect(quoteBounds).toBeTruthy();
  await page.mouse.click(
    quoteBounds!.x + quoteBounds!.width / 2,
    quoteBounds!.y + quoteBounds!.height / 2,
    { button: "right" },
  );
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem").first()).toHaveText("回复");
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying small")).toHaveText(selectedText);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: { getState: () => { drafts: Map<string, { replyQuote?: unknown }> } };
    };
    return module.telegramStore.getState().drafts.get("chat-product")?.replyQuote;
  }, "/src/store/telegramStore.ts")).toEqual({ text: selectedText, position: 4 });

  // A native TDLib draft echo can temporarily omit the quote while it is
  // being normalized. The locally selected quote must remain authoritative.
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: { getState: () => { updateChatDraft: (chatId: string, text: string, replyToMessageId?: string) => void } };
    };
    module.telegramStore.getState().updateChatDraft("chat-product", "", "p-2");
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".composer-context.is-replying small")).toHaveText(selectedText);

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("只回复选中的这部分");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", { hasText: "只回复选中的这部分" }).last();
  await expect(sent.locator(".message-reply-preview small")).toHaveText(selectedText);
});

test("partial replies map rendered Markdown back to an exact source quote", async ({ page }) => {
  await page.goto("/");
  await revealVirtualMessage(page, "p-markdown");

  const source = page.locator('[data-message-id="p-markdown"]');
  const messageText = source.locator(".message-rich-text");
  const renderedQuote = "Markdown 粗体、斜体";
  await expect(messageText).toContainText(renderedQuote);
  await messageText.evaluate((surface, quote) => {
    const fullText = surface.textContent ?? "";
    const start = fullText.indexOf(quote);
    if (start < 0) throw new Error("Markdown quote fixture was not found");
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const pointAt = (offset: number) => {
      let consumed = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (offset <= consumed + length) return { node, offset: offset - consumed };
        consumed += length;
        node = walker.nextNode();
      }
      throw new Error("Markdown selection point was not found");
    };
    const begin = pointAt(start);
    walker.currentNode = surface;
    const end = pointAt(start + quote.length);
    const range = document.createRange();
    range.setStart(begin.node, begin.offset);
    range.setEnd(end.node, end.offset);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, renderedQuote);
  await messageText.locator("strong").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");

  const sourceQuote = "Markdown 粗体**、*斜体";
  await expect(page.locator(".composer-context.is-replying small")).toHaveText(sourceQuote);
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { drafts: Map<string, { replyQuote?: unknown }> } };
    };
    return module.telegramStore.getState().drafts.get("chat-product")?.replyQuote;
  }, "/src/store/telegramStore.ts")).toEqual({ text: sourceQuote, position: 2 });

  await page.getByRole("textbox", { name: "消息内容" }).fill("回复 Markdown 选区");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", { hasText: "回复 Markdown 选区" }).last();
  await expect(sent.locator(".message-reply-preview small")).toHaveText(sourceQuote);
});

test("reply context resizes the latest viewport without moving a detached anchor", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const latest = page.locator('[data-message-id="p-video"]');
  await latest.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  const readLatestGap = () => latest.evaluate((element) => {
    const replyContext = document.querySelector<HTMLElement>(".composer-context.is-replying");
    return replyContext
      ? replyContext.getBoundingClientRect().top - element.getBoundingClientRect().bottom
      : Number.NEGATIVE_INFINITY;
  });
  await expect.poll(readLatestGap).toBeGreaterThanOrEqual(11);
  const latestGap = await readLatestGap();
  expect(latestGap).toBeLessThanOrEqual(13);

  await page.getByRole("button", { name: "取消回复", exact: true }).click();
  await scrollAwayFromBottom(page);
  const anchorBeforeReply = await visibleMessageAnchor(page);
  const detachedReplyTargetId = await messageList.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return row.querySelector(".message-bubble-shell") &&
          rowBounds.top >= bounds.top + 40 && rowBounds.bottom <= bounds.bottom - 40;
      })?.dataset.messageId;
  });
  expect(detachedReplyTargetId).toBeTruthy();
  await page.evaluate(async ({ modulePath, messageId }) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, unknown> };
        setState: (partial: { drafts: Map<string, unknown> }) => void;
      };
    };
    const drafts = new Map(storeModule.telegramStore.getState().drafts);
    drafts.set("chat-product", {
      chatId: "chat-product",
      text: "",
      replyToMessageId: messageId,
      updatedAt: new Date().toISOString(),
      pending: false,
    });
    storeModule.telegramStore.setState({ drafts });
  }, {
    modulePath: "/src/store/telegramStore.ts",
    messageId: detachedReplyTargetId!,
  });
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  const anchorAfterReply = await visibleMessageAnchor(page);
  expect(anchorAfterReply.id).toBe(anchorBeforeReply.id);
  expect(Math.abs(anchorAfterReply.offset - anchorBeforeReply.offset)).toBeLessThanOrEqual(1);
});

test("reply context survives concurrent message updates and is sent", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await revealVirtualMessage(page, "p-2");
  const source = page.locator('[data-message-id="p-2"]');
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, unknown[]> };
        setState: (state: { messages: Map<string, unknown[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    module.telegramStore.setState({ messages: new Map(state.messages) });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await composer.fill("消息刷新后仍保留引用");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(
    ".message-row.is-outgoing",
    { hasText: "消息刷新后仍保留引用" },
  ).last();
  await expect(sent).toBeVisible();
  await expect(sent.locator(".message-reply-preview")).toBeVisible();
});

test("canceling a draft reply removes the persisted reply target", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await revealVirtualMessage(page, "p-2");
  const source = page.locator('[data-message-id="p-2"]');
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await composer.fill("取消回复后仍是普通草稿");
  await page.waitForTimeout(850);
  await page.getByRole("button", { name: "取消回复", exact: true }).click();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          drafts: Map<string, { text: string; replyToMessageId?: string }>;
        };
      };
    };
    return module.telegramStore.getState().drafts.get("chat-product");
  }, "/src/store/telegramStore.ts")).toMatchObject({
    text: "取消回复后仍是普通草稿",
    replyToMessageId: undefined,
  });

  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);
  await expect(composer).toHaveValue("取消回复后仍是普通草稿");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(
    '.message-row.is-outgoing',
    { hasText: "取消回复后仍是普通草稿" },
  ).last();
  await expect(sent).toBeVisible();
  await expect(sent.locator(".message-reply-preview")).toHaveCount(0);
});

test("user profiles expose account identifiers and data-center information", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Mia Chen/ }).first().click();
  await page.getByRole("button", { name: "查看 Mia Chen 资料" }).click();

  const profile = page.getByRole("dialog", { name: "资料" });
  const identity = profile.locator(".profile-identity-card");
  await expect(identity).toBeVisible();
  await expect(identity.getByText("@mia_design", { exact: true })).toBeVisible();
  await expect(identity.getByText("u-mia", { exact: true })).toBeVisible();
  await expect(identity.getByText("DC5, Singapore, SG", { exact: true })).toBeVisible();
});

test("contacts are hidden from the navigation rail", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "联系人", exact: true })).toHaveCount(0);
  await expect(page.locator(".contacts-view")).toHaveCount(0);
});

test("mobile chat switching has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".chat-row").first().click();

  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".mobile-back")).toBeVisible();
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("minimum window remains operable at Windows 125, 150, and 200 percent scaling", async ({ browser }) => {
  for (const deviceScaleFactor of [1.25, 1.5, 2]) {
    const context = await browser.newContext({
      viewport: { width: 680, height: 560 },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator(".chat-row").first().click();

    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".mobile-back")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
    expect(await page.evaluate(() => devicePixelRatio)).toBe(deviceScaleFactor);
    expect(await horizontalOverflow(page)).toBe(false);
    await context.close();
  }
});

test("muted chats use a neutral unread badge", async ({ page }) => {
  await page.goto("/");
  const mutedRow = page.getByRole("button", { name: /Release Notes/ });
  const regularRow = page.getByRole("button", { name: /Mia Chen/ });
  const mutedBadge = mutedRow.locator(".unread-count");
  const regularBadge = regularRow.locator(".unread-count");

  await expect(mutedBadge).toHaveClass(/is-muted/);
  await expect(mutedBadge).toHaveCSS("background-color", "rgb(167, 178, 183)");
  await expect(regularBadge).not.toHaveCSS("background-color", "rgb(167, 178, 183)");
  await expect(page.locator(".chat-row .lucide-volume-x")).toHaveCount(0);
});

test("mention and reply unread counts use theme-specific attention colors", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator('[data-chat-id="chat-forum"] .unread-count');

  await expect(badge).toHaveText("4");
  await expect(badge).toHaveClass(/has-attention/);
  await expect(badge).toHaveAttribute("aria-label", "4 条未读消息，其中包含提及或回复");
  await expect(badge).toHaveCSS("background-color", "rgb(190, 98, 88)");
  await expect(badge).toHaveCSS("color", "rgb(255, 255, 255)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await expect(badge).toHaveCSS("background-color", "rgb(242, 184, 75)");
  await expect(badge).toHaveCSS("color", "rgb(35, 23, 0)");
});

test("chat settings move unread counters onto avatars and persist the choice", async ({ page }) => {
  await page.goto("/");
  const releaseRow = page.locator('.chat-row[data-chat-id="chat-release"]');
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
    '.chat-row[data-chat-id="chat-release"] .chat-avatar-wrap .unread-count-avatar',
  )).toHaveText("8");
});

test("media transfers expose their exact circular progress", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const chatMessages = [...(messages.get("chat-product") ?? [])];
    const index = chatMessages.findIndex((message) => message.id === "p-video");
    if (index < 0) return;
    const message = chatMessages[index];
    chatMessages[index] = {
      ...message,
      content: {
        ...(message.content as Record<string, unknown>),
        isDownloaded: false,
        isDownloading: true,
        progress: 0.37,
      },
    };
    messages.set("chat-product", chatMessages);
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const progress = page.locator('[data-message-id="p-video"] [role="progressbar"]');
  await expect(progress).toHaveAttribute("aria-valuenow", "37");
  const ring = progress.locator(".media-progress-ring-value");
  const dashOffset = Number(await ring.getAttribute("stroke-dashoffset"));
  expect(dashOffset).toBeGreaterThan(47);
  expect(dashOffset).toBeLessThan(48);
});

test("video downloads share real progress and a usable file name across both views", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:managed-downloads:v1", JSON.stringify([{
      accountId: "default",
      fileId: 93,
      fileName: "视频",
      requestedAt: "2026-08-13T12:00:00.000Z",
    }]));
  });
  await page.goto("/");
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: {
          messages: Map<string, Array<Record<string, unknown>>>;
          downloadFile: (fileId: number, fileName: string) => Promise<void>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const chatMessages = [...(messages.get("chat-product") ?? [])];
    const index = chatMessages.findIndex((message) => message.id === "p-video");
    if (index < 0) return;
    chatMessages[index] = {
      ...chatMessages[index],
      content: {
        ...(chatMessages[index].content as Record<string, unknown>),
        fileName: "视频_93.mp4",
        size: 10_000_000,
        downloadedSize: 2_500_000,
        isDownloaded: false,
        isDownloading: true,
        progress: 0.25,
      },
    };
    messages.set("chat-product", chatMessages);
    storeModule.telegramStore.setState({
      messages,
      downloadFile: async () => new Promise<void>(() => undefined),
    });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator('[data-message-id="p-video"] [role="progressbar"]'))
    .toHaveAttribute("aria-valuenow", "25");
  await page.keyboard.press("Control+j");
  const dialog = page.getByRole("dialog", { name: "下载" });
  await expect(dialog.getByText("视频_93.mp4", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "视频_93.mp4 下载进度" }))
    .toHaveAttribute("aria-valuenow", "25");
});

test("pinned chats can be dragged into a fixed order", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');

  const source = await product.boundingBox();
  const target = await mia.boundingBox();
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  await page.mouse.move(source!.x + 30, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + 30, source!.y + source!.height / 2 + 12, { steps: 3 });
  await expect(product).toHaveClass(/is-dragging/);
  await page.mouse.move(target!.x + 30, target!.y + target!.height - 5, { steps: 8 });
  await expect(mia).toHaveClass(/drop-after/);
  await page.mouse.up();

  await expect(page.locator(".chat-row").first()).toContainText("Mia Chen");
  await expect(page.locator(".chat-row").nth(1)).toContainText("产品讨论");
});

test("Markdown and TDLib rich text render as structured message content", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const markdownRow = await revealVirtualMessage(page, "p-markdown");
  const markdown = markdownRow.locator(".message-rich-text");
  await expect(markdown).toHaveAttribute("data-rich-text", "markdown");
  await expect(markdown.locator("strong")).toHaveText("Markdown 粗体");
  await expect(markdown.locator("em")).toHaveText("斜体");
  await expect(markdown.locator("del")).toHaveText("删除线");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown.locator("code")).toHaveText("code");
  const markdownLink = markdown.locator('a[href="https://t.me/mia_design"]');
  await expect(markdownLink).toHaveText("链接");

  const entities = (await revealVirtualMessage(page, "p-rich-entities"))
    .locator(".message-rich-text");
  await expect(entities).toHaveAttribute("data-rich-text", "entities");
  await expect(entities.locator("strong")).toHaveText("bold");
  await expect(entities.locator('a[href="https://t.me/addtheme/NotgramTheme"]')).toHaveText("link");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.locator('[data-message-id="p-video"] .photo-caption strong'))
    .toHaveText("昨晚");

  const richMessage = (await revealVirtualMessage(page, "p-rich-message"))
    .locator(".rich-message-content");
  await expect(richMessage).toHaveAttribute("data-rich-text", "rich-message");
  await expect(richMessage.locator("h1")).toHaveText("今日小贴士");
  await expect(richMessage.locator("li")).toHaveCount(3);
  await expect(richMessage.locator("li").first().locator("strong"))
    .toHaveText("优先处理最重要的一件事");
  await expect(richMessage.locator("blockquote")).toHaveCount(2);
  await expect(richMessage.locator("code").first()).toHaveText("5,709 tokens");
  await expect(richMessage.locator(".katex")).toContainText("E");
  await expect(richMessage.locator("table caption")).toHaveText("Status");
  await expect(richMessage.locator("table th")).toHaveText("Metric");
  await expect(richMessage.locator("table td")).toHaveText("Ready");
  const anchorLink = richMessage.locator('a[href^="#rich-message-p-rich-message-anchor-"]');
  await expect(anchorLink).toHaveText("jump");
  const anchorHref = await anchorLink.getAttribute("href");
  expect(anchorHref).toBeTruthy();
  await expect(richMessage.locator(anchorHref!)).toHaveCount(1);
  await richMessage.locator("details summary").click();
  await expect(richMessage.locator("details")).toContainText("Advanced details");
  await expect(richMessage.locator('.rich-media-photo img[alt="Bot chart"]')).toBeVisible();

  const globalSearch = page.getByPlaceholder("搜索会话和消息");
  await globalSearch.fill("热搜");
  await page.locator(".global-message-result").filter({ hasText: "热搜" }).first().click();
  const botQuoteRow = page.locator('[data-message-id="archive-bot-quote"]');
  const botQuote = botQuoteRow.locator(".rich-blockquote");
  await botQuoteRow.scrollIntoViewIfNeeded();
  await expect(botQuote).toHaveCount(1);
  await expect(botQuote.locator("a")).toHaveCount(10);
  const quoteGeometry = await botQuote.evaluate((element) => {
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineTops = [...range.getClientRects()].reduce<number[]>((tops, rect) => {
      if (!tops.some((top) => Math.abs(top - rect.top) < 1)) tops.push(rect.top);
      return tops;
    }, []);
    return { lineCount: lineTops.length, height: element.getBoundingClientRect().height, lineHeight };
  });
  expect(quoteGeometry.lineCount).toBeLessThanOrEqual(3);
  expect(quoteGeometry.height).toBeLessThanOrEqual(quoteGeometry.lineHeight * 3.2);
  const senderRow = botQuoteRow.locator(".message-sender-row");
  await expect(senderRow.locator(".message-sender-label")).toHaveText("热点机器人");
  await expect(senderRow).not.toContainText("管理员");
  const senderGeometry = await senderRow.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".message-sender-label")!;
    const bubble = element.closest<HTMLElement>(".message-bubble")!;
    return {
      rightGap: bubble.getBoundingClientRect().right - label.getBoundingClientRect().right,
      topGap: label.getBoundingClientRect().top - bubble.getBoundingClientRect().top,
      fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
    };
  });
  expect(senderGeometry.rightGap).toBeCloseTo(10, 0);
  expect(senderGeometry.topGap).toBeGreaterThanOrEqual(6);
  expect(senderGeometry.topGap).toBeLessThanOrEqual(10);
  expect(senderGeometry.fontSize).toBeGreaterThanOrEqual(11);
});

test("image documents use the photo media renderer", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async ({ mapperPath, storePath }) => {
    const [{ mapTdMessage }, { telegramStore }] = await Promise.all([
      import(mapperPath),
      import(storePath),
    ]);
    const mapped = mapTdMessage({
      "@type": "message",
      id: "p-image-document",
      chat_id: "chat-product",
      sender_id: { "@type": "messageSenderUser", user_id: "u-mia" },
      is_outgoing: false,
      date: Math.floor(Date.now() / 1_000) + 30,
      content: {
        "@type": "messageDocument",
        document: {
          file_name: "design-export.png",
          mime_type: "image/png",
          minithumbnail: {
            width: 1,
            height: 1,
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
          document: {
            "@type": "file",
            id: 181,
            size: 2048,
            local: {
              can_be_downloaded: true,
              is_downloading_active: false,
              is_downloading_completed: false,
            },
            remote: {},
          },
        },
        caption: {
          "@type": "formattedText",
          text: "Image sent as a file",
          entities: [],
        },
      },
    });
    if (!mapped) throw new Error("Image document did not map to a message");
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const messages = new Map<string, Array<Record<string, unknown>>>(state.messages);
    messages.set("chat-product", [
      ...(messages.get("chat-product") ?? []),
      mapped as Record<string, unknown>,
    ]);
    telegramStore.setState({ messages });
  }, {
    mapperPath: "/src/telegram/tdlibMapper.ts",
    storePath: "/src/store/telegramStore.ts",
  });

  const row = page.locator('[data-message-id="p-image-document"]');
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('[data-media-type="photo"]')).toBeVisible();
  await expect(row.locator(".file-message")).toHaveCount(0);
  await expect(row.locator(".photo-caption")).toContainText("Image sent as a file");
  await expect(row.locator('img[alt="Image sent as a file"]')).toBeVisible();
});

test("video uses synchronized transparent playback windows and owns the playback spacebar", async ({ page }) => {
  await page.setViewportSize({ width: 1_100, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const row = page.locator('[data-message-id="p-video"]');
  const player = row.locator(".video-player");
  const video = player.locator("video");

  await expect(player).toBeVisible();
  await expect(video).toHaveAttribute("poster", /mock-video-poster\.jpg/);
  await expect(video).not.toHaveAttribute("controls", "");
  await expect(player.getByRole("slider", { name: "播放进度" })).toBeVisible();
  await expect(player.getByRole("button", { name: "打开声音" })).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.2);

  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect(video).toHaveAttribute("src", /mock-video\.mp4/);
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await settingsButton.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await expect.poll(() => settingsButton.evaluate((element) => document.activeElement !== element))
    .toBe(true);

  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.focus();
  await page.keyboard.press("Space");
  await expect(composer).toHaveValue(" ");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await composer.fill("");

  const messageList = page.locator(".message-list");
  await messageList.evaluate((list, messageId) => {
    const playerElement = list.querySelector<HTMLElement>(`[data-message-id="${messageId}"] .video-player`);
    if (!playerElement) return;
    const listBounds = list.getBoundingClientRect();
    const playerBounds = playerElement.getBoundingClientRect();
    list.scrollTop += playerBounds.top - listBounds.top + playerBounds.height * 0.6;
  }, "p-video");
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await row.scrollIntoViewIfNeeded();
  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await row.click({ button: "right" });
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(actionMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(actionMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await expect(actionMenu.getByRole("menuitem", { name: "以小窗播放" })).toBeVisible();
  await expect(actionMenu.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await actionMenu.getByRole("menuitem", { name: "以小窗播放" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const popupPlayer = popup.locator(".video-window");
  const popupVideo = popupPlayer.locator("video");
  await expect(popupPlayer).toHaveClass(/is-windowed/);
  await expect(popupVideo).toHaveAttribute("src", /mock-video\.mp4/);
  await expect(player).toBeVisible();
  await expect(player).not.toHaveClass(/is-floating/);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  const windowedControls = popup.locator(".video-windowed-controls");
  await popup.mouse.move(120, 80);
  await expect.poll(() => windowedControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("1");
  await popup.getByRole("slider", { name: "音量" }).fill("0.35");
  await popup.waitForTimeout(1_100);
  await expect.poll(() => windowedControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("0");
  const popupBounds = await popupPlayer.boundingBox();
  await popup.mouse.click(40, popupBounds!.height / 2);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await popup.keyboard.press("f");
  await expect(popupPlayer).toHaveClass(/is-fullscreen/);
  await popupVideo.evaluate((element) => {
    element.style.width = "70%";
    element.style.margin = "0 auto";
  });
  await expect.poll(() => popupVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await popup.mouse.move(550, 360);
  const controls = popup.locator(".video-fullscreen-controls");
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  await expect(popup.getByRole("button", { name: "下载视频" })).toBeVisible();
  const controlsBounds = await controls.boundingBox();
  expect(Math.round(controlsBounds!.width)).toBe(550);
  expect(Math.round(controlsBounds!.height)).toBe(80);
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => popupPlayer.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(20, 26, 30, 0.48)");

  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("0");
  const popupClosed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await popupClosed;
  await expect(player).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);

  const fullscreenPopupPromise = page.waitForEvent("popup");
  const inlineBounds = await player.boundingBox();
  await player.dblclick({ position: { x: inlineBounds!.width / 2, y: inlineBounds!.height / 2 } });
  const fullscreenPopup = await fullscreenPopupPromise;
  await fullscreenPopup.waitForLoadState("domcontentloaded");
  const fullscreenVideo = fullscreenPopup.locator("video");
  await expect(fullscreenPopup.locator(".video-window")).toHaveClass(/is-fullscreen/);
  await expect.poll(() => fullscreenVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false);
  await expect.poll(() => fullscreenVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  const secondFullscreenControls = fullscreenPopup.locator(".video-fullscreen-controls");
  await fullscreenPopup.locator(".video-window").hover({ position: { x: 100, y: 100 } });
  await expect.poll(() => secondFullscreenControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("1");
  const fullscreenClosed = fullscreenPopup.waitForEvent("close");
  await fullscreenPopup.keyboard.down("Escape");
  await fullscreenClosed;
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const restoredVideo = page.locator('[data-message-id="p-video"] video');
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
});

test("photo albums preserve order, captions, clipping, and tile geometry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const squareRow = page.locator('[data-message-id="p-5"]');
  const tallRow = page.locator('[data-message-id="p-tall"]');
  const album = page.locator('[data-media-album-id="mock-album-product"]');
  await expect(album).toBeVisible();
  await expect(squareRow).toBeVisible();
  await expect(tallRow).toBeVisible();
  await expect(album.locator(".message-row")).toHaveCount(2);
  expect(await album.locator(".message-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.messageId),
  )).toEqual(["p-tall", "p-5"]);
  await expect(album.locator(".media-album-caption")).toHaveText([
    "纵向图片应该按实际比例收窄，外壳不能留下额外空白。",
    "新的媒体预览样式",
  ]);
  await expect(tallRow).toHaveClass(/group-first/);
  await expect(squareRow).toHaveClass(/group-last/);
  await expect(album.locator(".media-album-grid")).toHaveCSS("gap", "2px");
  await expect(album.locator(".media-album-grid")).toHaveCSS("background-color", "rgb(211, 221, 223)");
  const albumTime = squareRow.locator(".message-meta");
  await expect(albumTime).toHaveCSS("opacity", "0");
  await page.locator(".message-list").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
  });
  await squareRow.scrollIntoViewIfNeeded();
  const photoBounds = await squareRow.locator(".photo-open").boundingBox();
  expect(photoBounds).not.toBeNull();
  await page.mouse.move(photoBounds!.x + photoBounds!.width / 2, photoBounds!.y + photoBounds!.height / 2);
  await expect(albumTime).toHaveCSS("opacity", "1");
  await expect.poll(() => tallRow.locator("img").evaluate((image) => {
    const media = image as HTMLImageElement;
    return `${media.naturalWidth}x${media.naturalHeight}`;
  })).toBe("900x1800");

  for (const viewport of [
    { width: 1220, height: 780 },
    { width: 680, height: 620 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    for (const row of [tallRow, squareRow]) {
      await row.evaluate((element) => {
        element.scrollIntoView({ block: "center", behavior: "auto" });
      });
      await expect.poll(() => row.locator("img").evaluate((image) => {
        const media = image as HTMLImageElement;
        return media.complete && media.naturalWidth > 0 && media.naturalHeight > 0;
      })).toBe(true);
      const geometry = await row.evaluate((element) => {
        const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
        const bubble = element.querySelector<HTMLElement>(".message-bubble");
        const preview = element.querySelector<HTMLElement>(".photo-preview");
        const image = element.querySelector<HTMLImageElement>(".photo-preview img");
        const stack = element.closest<HTMLElement>(".message-group-stack");
        if (!shell || !bubble || !preview || !image || !stack) return undefined;
        const shellBounds = shell.getBoundingClientRect();
        const bubbleBounds = bubble.getBoundingClientRect();
        const previewBounds = preview.getBoundingClientRect();
        const imageBounds = image.getBoundingClientRect();
        const stackBounds = stack.getBoundingClientRect();
        return {
          shellWidth: shellBounds.width,
          previewWidth: previewBounds.width,
          previewHeight: previewBounds.height,
          shellInsideStack: shellBounds.left >= stackBounds.left - 1 &&
            shellBounds.right <= stackBounds.right + 1,
          bubbleGap: Math.abs(shellBounds.width - bubbleBounds.width),
          imageHorizontalGap: Math.max(
            Math.abs(imageBounds.left - previewBounds.left),
            Math.abs(imageBounds.right - previewBounds.right),
          ),
          imageVerticalGap: Math.max(
            Math.abs(imageBounds.top - previewBounds.top),
            Math.abs(imageBounds.bottom - previewBounds.bottom),
          ),
          objectFit: getComputedStyle(image).objectFit,
          borderRadius: getComputedStyle(bubble).borderRadius,
          overflow: getComputedStyle(bubble).overflow,
        };
      });
      expect(geometry).toBeDefined();
      expect(geometry?.shellInsideStack).toBe(true);
      expect(geometry?.bubbleGap).toBeLessThanOrEqual(1);
      expect(geometry?.imageHorizontalGap).toBeLessThanOrEqual(1);
      expect(geometry?.imageVerticalGap).toBeLessThanOrEqual(1);
      expect(geometry?.objectFit).toBe("cover");
      expect(geometry?.borderRadius).toBe("0px");
      expect(geometry?.overflow).toBe("hidden");
    }
    const albumGeometry = await album.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const stack = element.closest<HTMLElement>(".message-group-stack")?.getBoundingClientRect();
      return {
        insideStack: stack !== undefined &&
          bounds.left >= stack.left - 1 && bounds.right <= stack.right + 1,
        borderRadius: getComputedStyle(element).borderRadius,
        overflow: getComputedStyle(element).overflow,
      };
    });
    expect(albumGeometry).toEqual({ insideStack: true, borderRadius: "8px", overflow: "hidden" });
    expect(await horizontalOverflow(page)).toBe(false);
  }

  const tallTile = await tallRow.locator(".message-bubble-shell").evaluate((shell) => ({
    width: shell.getBoundingClientRect().width,
    height: shell.getBoundingClientRect().height,
  }));
  await tallRow.locator("img").evaluate((image) => {
    image.dispatchEvent(new Event("error", { bubbles: false }));
  });
  await expect(tallRow.locator(".photo-placeholder")).toBeVisible();
  const failedState = await tallRow.evaluate((element) => {
    const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const preview = element.querySelector<HTMLElement>(".photo-preview");
    return {
      shellWidth: shell?.getBoundingClientRect().width,
      shellHeight: shell?.getBoundingClientRect().height,
      previewWidth: preview?.getBoundingClientRect().width,
      borderRadius: bubble ? getComputedStyle(bubble).borderRadius : "",
      overflow: bubble ? getComputedStyle(bubble).overflow : "",
    };
  });
  expect(Math.abs((failedState.shellWidth ?? 0) - (failedState.previewWidth ?? 1)))
    .toBeLessThanOrEqual(1);
  expect(failedState.shellWidth).toBeCloseTo(tallTile.width, 0);
  expect(failedState.shellHeight).toBeCloseTo(tallTile.height, 0);
  expect(failedState.borderRadius).toBe("0px");
  expect(failedState.overflow).toBe("hidden");
});

test("mixed media albums justify every row across the bubble", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (storePath) => {
    type TestMessage = {
      id: string;
      renderKey?: string;
      mediaAlbumId?: string;
      sentAt: string;
      content: { kind: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: { messages: Map<string, TestMessage[]> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const source = (messages.get("chat-product") ?? []).find((message) => message.id === "p-5");
    if (!source || source.content.kind !== "media") throw new Error("Album source is unavailable");
    const dimensions = [
      [900, 1_600],
      [1_600, 900],
      [1_000, 1_000],
      [1_400, 1_000],
      [800, 1_200],
      [1_000, 1_000],
      [1_600, 900],
    ];
    const album = dimensions.map(([width, height], index) => ({
      ...source,
      id: `album-fill-${index}`,
      renderKey: `album-fill-${index}`,
      mediaAlbumId: "album-fill-regression",
      sentAt: `2026-08-13T17:00:${String(index).padStart(2, "0")}+08:00`,
      content: {
        ...source.content,
        width,
        height,
        caption: undefined,
        captionEntities: undefined,
        isDownloading: false,
        progress: undefined,
      },
    }));
    messages.set("chat-product", [...(messages.get("chat-product") ?? []), ...album]);
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const album = page.locator('[data-media-album-id="album-fill-regression"]');
  await page.keyboard.press("End");
  await expect(album).toBeVisible();
  await album.scrollIntoViewIfNeeded();
  await expect(album.locator(".media-album-tile")).toHaveCount(7);
  const geometry = await album.evaluate((element) => {
    const albumBounds = element.getBoundingClientRect();
    const gridBounds = element.querySelector<HTMLElement>(".media-album-grid")?.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>(".media-album-row")].map((row) => {
      const rowBounds = row.getBoundingClientRect();
      const tiles = [...row.querySelectorAll<HTMLElement>(".media-album-tile")];
      return {
        count: tiles.length,
        leftGap: Math.abs((tiles[0]?.getBoundingClientRect().left ?? 0) - rowBounds.left),
        rightGap: Math.abs((tiles.at(-1)?.getBoundingClientRect().right ?? 0) - rowBounds.right),
        tilesHaveArea: tiles.every((tile) => {
          const bounds = tile.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        }),
      };
    });
    return {
      albumWidth: albumBounds.width,
      gridWidth: gridBounds?.width ?? 0,
      rows,
    };
  });
  expect(Math.abs(geometry.albumWidth - geometry.gridWidth)).toBeLessThanOrEqual(1);
  expect(geometry.rows.reduce((total, row) => total + row.count, 0)).toBe(7);
  expect(geometry.rows.every((row) =>
    row.count >= 2 && row.count <= 3 &&
    row.leftGap <= 1 && row.rightGap <= 1 && row.tilesHaveArea,
  )).toBe(true);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("saved and direct messages align to the conversation edges", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /收藏夹/ }).click();
  const savedMessage = page.locator('[data-message-id="s-2"]');
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveClass(/is-outgoing/);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="m-1"]')).toBeVisible();
  await expect(page.locator('[data-message-id="m-2"]')).toBeVisible();
  await expect(page.locator(".message-group-avatar")).toHaveCount(0);
  const alignment = await page.locator(".message-list").evaluate((list) => {
    const content = list.querySelector<HTMLElement>(".message-list-content");
    const incoming = list.querySelector<HTMLElement>('[data-message-id="m-1"] .message-bubble-shell');
    const outgoing = list.querySelector<HTMLElement>('[data-message-id="m-2"] .message-bubble-shell');
    if (!content || !incoming || !outgoing) return undefined;
    const contentBounds = content.getBoundingClientRect();
    const incomingBounds = incoming.getBoundingClientRect();
    const outgoingBounds = outgoing.getBoundingClientRect();
    const style = getComputedStyle(list);
    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      incomingOffset: incomingBounds.left - contentBounds.left,
      outgoingOffset: contentBounds.right - outgoingBounds.right,
    };
  });
  expect(alignment).toEqual({
    paddingLeft: "10px",
    paddingRight: "10px",
    incomingOffset: 0,
    outgoingOffset: 0,
  });
});

test("group service messages render as centered notices", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const notice = await revealVirtualMessage(page, "p-service");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/is-service/);
  await expect(notice.locator(".message-bubble")).toHaveText("Mia Chen 加入了群聊");
  const member = notice.getByRole("button", { name: "查看 Mia Chen 资料" });
  await expect(member).toBeVisible();
  await expect(notice.locator(".message-meta")).toHaveCount(0);
  const centerDelta = await notice.evaluate((row) => {
    const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
    if (!shell) return Number.POSITIVE_INFINITY;
    const rowBounds = row.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    return Math.abs(
      (rowBounds.left + rowBounds.right) / 2 - (shellBounds.left + shellBounds.right) / 2,
    );
  });
  expect(centerDelta).toBeLessThanOrEqual(1);
  await member.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
});

test("date separators are centered and only upward user scrolling exposes the visible day", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const separatorMessage = await revealVirtualMessage(page, "p-service");
  const separator = page.locator(".message-day").filter({ hasText: "8月1日" }).first();
  await expect(separator).toBeVisible();
  const spacing = await separator.evaluate((label) => {
    const next = document.querySelector<HTMLElement>('[data-message-id="p-service"]');
    const labelBounds = label.getBoundingClientRect();
    const previous = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .filter((row) => row.dataset.messageId !== "p-service")
      .filter((row) => row.getBoundingClientRect().bottom <= labelBounds.top + 1)
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0];
    if (!previous || !next) return undefined;
    return {
      before: labelBounds.top - previous.getBoundingClientRect().bottom,
      after: next.getBoundingClientRect().top - labelBounds.bottom,
    };
  });
  expect(spacing).toBeTruthy();
  expect(Math.abs(spacing!.before - spacing!.after)).toBeLessThanOrEqual(1);

  const indicator = page.locator(".conversation-date-indicator");
  const messageList = page.locator(".message-list");
  await messageList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("textbox", { name: "消息内容" }).fill("日期标签不应被输入触发");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "表情、贴纸与 GIF" })).toBeVisible();
  await expect(indicator).toHaveCount(0);
  await page.getByRole("button", { name: "关闭表情面板" }).click();

  await separatorMessage.evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "auto" });
  });
  await messageList.hover();
  await page.mouse.wheel(0, -120);
  await expect(indicator).toHaveText("7月30日");
  await expect(indicator).toHaveClass(/is-visible/);

  await expect(indicator).not.toHaveClass(/is-visible/, { timeout: 2_000 });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
  await messageList.hover();
  await page.mouse.wheel(0, -160);
  await expect(indicator).toHaveText("8月1日");
  await expect(indicator).toHaveClass(/is-visible/);
  await expect(indicator).toHaveCSS("pointer-events", "none");

  await messageList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(indicator).not.toHaveClass(/is-visible/);
});

test("developer tooling is absent from settings and message actions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const notice = await revealVirtualMessage(page, "p-unknown");
  await expect(notice).toContainText("收到新类型消息（messageFutureType）");
  await expect(notice.getByRole("button")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await expect(page.getByText("开发者选项", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "开发者模式" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  const regularMessage = await revealVirtualMessage(page, "p-2");
  await regularMessage.locator(".message-bubble-shell").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "复制原始消息" })).toHaveCount(0);
});

const messageViewportOffset = (page: Page, messageId: string) =>
  page.locator(`[data-message-id="${messageId}"]`).evaluate((element) => {
    const list = element.closest<HTMLElement>(".message-list");
    if (!list) return Number.POSITIVE_INFINITY;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });

test("message jumps return through prior reading positions before returning to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const source = await revealVirtualMessage(page, "p-channel-reply");
  const originalSourceOffset = await messageViewportOffset(page, "p-channel-reply");

  await source.locator(".message-reply-preview").click();
  const firstTarget = page.locator('[data-message-id="p-old-8"]');
  await expect(firstTarget).toHaveClass(/is-notification-target/);
  await expect.poll(() => firstTarget.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return list
      ? Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2)
      : Number.POSITIVE_INFINITY;
  })).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();
  const firstTargetOffset = await messageViewportOffset(page, "p-old-8");

  await page.locator(".pinned-message-preview").click();
  await expect(page.locator('[data-message-id="p-4"]')).toBeVisible();
  const returnButton = page.getByRole("button", { name: "返回跳转前位置，可回退 2 次" });
  await expect(returnButton).toBeVisible();

  await returnButton.click();
  await expect(firstTarget).toBeAttached();
  await expect.poll(async () => Math.abs(
    await messageViewportOffset(page, "p-old-8") - firstTargetOffset,
  )).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" }).click();
  await expect(source).toBeAttached();
  await expect.poll(async () => Math.abs(
    await messageViewportOffset(page, "p-channel-reply") - originalSourceOffset,
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^跳到最新消息/ })).toBeVisible();
});

test("returning from a reply jump to the latest message clears navigation state", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(messageList.locator("[data-message-id]")).not.toHaveCount(0);

  const targetMessageId = await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    const target = current.at(-Math.min(12, Math.max(2, current.length)));
    if (!latest || !target || target === latest || typeof target.id !== "string") return undefined;
    current.push({
      ...latest,
      id: "p-latest-reply-jump",
      renderKey: undefined,
      senderId: "u-mia",
      outgoing: false,
      sentAt: new Date(Date.now() + 10_000).toISOString(),
      replyTo: {
        kind: "message",
        chatId: "chat-product",
        messageId: target.id,
        content: target.content,
      },
      content: { kind: "text", text: "最新消息引用了前文" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
    return target.id;
  }, "/src/store/telegramStore.ts");
  expect(targetMessageId).toBeTruthy();

  const latestReply = page.locator('[data-message-id="p-latest-reply-jump"]');
  await expect(latestReply).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await latestReply.locator(".message-reply-preview").click();

  const target = messageList.locator(`[data-message-id="${targetMessageId}"]`);
  await expect(target).toHaveClass(/is-notification-target/);
  const returnButton = page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" });
  await expect(returnButton).toBeVisible();
  const returnTrace = await returnButton.evaluate((button) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const samples: number[] = [];
    const started = performance.now();
    const record = () => {
      if (list) samples.push(list.scrollTop);
      if (performance.now() - started < 900) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    (button as HTMLElement).click();
    return new Promise<number[]>((resolve) => globalThis.setTimeout(() => resolve(samples), 950));
  });

  const upwardRebounds = returnTrace.slice(1).filter((scrollTop, index) =>
    scrollTop < returnTrace[index] - 1
  );
  expect(upwardRebounds, JSON.stringify(returnTrace)).toHaveLength(0);

  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("manual bottom navigation and conversation switches clear reply jump history", async ({ page }) => {
  await page.goto("/");
  const source = await revealVirtualMessage(page, "p-channel-reply");
  await source.locator(".message-reply-preview").click();
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();

  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);

  await page.locator(".pinned-message-preview").click();
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  for (const text of ["滚动定位测试一", "滚动定位测试二"]) {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  }
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.getByText("滚动定位测试二", { exact: true })).toBeVisible();
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await page.getByRole("textbox", { name: "消息内容" }).fill("底部自动跟随测试");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await page.locator(".message-list").hover();
  for (let attempt = 0; attempt < 5; attempt += 1) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(180);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("local reading anchor wins over an older unread cursor after switching conversations", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          chats: Map<string, Record<string, unknown>>;
          messages: Map<string, Array<Record<string, unknown>>>;
        };
        setState: (partial: {
          chats: Map<string, Record<string, unknown>>;
          messages: Map<string, Array<Record<string, unknown>>>;
        }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const chats = new Map(state.chats);
    const messages = new Map(state.messages);
    const product = chats.get("chat-product");
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!product || !latest) return;
    chats.set("chat-product", {
      ...product,
      unreadCount: 3,
      lastReadInboxMessageId: current[1]?.id ?? current[0]?.id,
    });
    current.push({
      ...latest,
      id: "p-anchor-regression-live",
      renderKey: undefined,
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 3_000).toISOString(),
      content: { kind: "text", text: "切换期间到达、但不应改变阅读锚点的新消息" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ chats, messages });
  }, "/src/store/telegramStore.ts");

  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /跳到最新消息/ })).toBeVisible();
});

test("window resizing and new messages preserve the user's follow intent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  await expect(page.getByRole("button", { name: "跳到最新消息", exact: true })).toBeVisible();
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    current.push({
      ...latest,
      id: "p-live-resize",
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 1_000).toISOString(),
      content: { kind: "text", text: "缩放期间的锚点消息" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  for (const width of [1180, 1320, 1210, 1280]) {
    await page.setViewportSize({ width, height: 760 });
  }
  await page.waitForTimeout(160);

  const afterResize = await visibleMessageAnchor(page);
  expect(afterResize.id).toBe(savedAnchor.id);
  expect(Math.abs(afterResize.offset - savedAnchor.offset)).toBeLessThanOrEqual(2);
  const jumpButton = page.getByRole("button", { name: "跳到最新消息，1 条新消息" });
  await expect(jumpButton).toBeVisible();

  await jumpButton.click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.getByRole("textbox", { name: "消息内容" }).fill("缩放期间自动跟随");
  await page.getByRole("button", { name: "发送消息" }).click();
  for (const width of [1240, 1340, 1260, 1280]) {
    await page.setViewportSize({ width, height: 760 });
  }
  await page.waitForTimeout(160);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("mention and reply notifications jump newest-first and are consumed once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, Array<Record<string, unknown>>>;
          unreadAttentionMessageIds: Map<string, string[]>;
        };
        setState: (partial: {
          messages: Map<string, Array<Record<string, unknown>>>;
          unreadAttentionMessageIds: Map<string, string[]>;
        }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const timestamp = Date.now() + 5_000;
    current.push(
      {
        ...latest,
        id: "p-attention-1",
        renderKey: undefined,
        senderId: "u-mia",
        outgoing: false,
        sentAt: new Date(timestamp).toISOString(),
        containsUnreadMention: true,
        content: { kind: "text", text: "第一条提及" },
      },
      {
        ...latest,
        id: "p-attention-2",
        renderKey: undefined,
        senderId: "u-chen",
        outgoing: false,
        sentAt: new Date(timestamp + 1_000).toISOString(),
        containsUnreadMention: false,
        replyTo: {
          kind: "message",
          messageId: "p-attention-own-target",
          outgoing: true,
          senderName: "我",
          text: "被引用的消息",
          content: { kind: "text", text: "被引用的消息" },
        },
        content: { kind: "text", text: "第二条引用回复" },
      },
    );
    messages.set("chat-product", current);
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-product", ["p-attention-1", "p-attention-2"]);
    module.telegramStore.setState({ messages, unreadAttentionMessageIds });
  }, "/src/store/telegramStore.ts");

  const attentionButton = page.locator(".jump-to-attention");
  const latestButton = page.locator(".jump-to-latest");
  await expect(attentionButton).toHaveAccessibleName("跳到提及或引用，2 条待查看");
  await expect(attentionButton.locator("span")).toHaveText("2");
  await expect(latestButton).toBeVisible();
  const buttonLayout = await page.locator(".conversation").evaluate((element) => {
    const attention = element.querySelector<HTMLElement>(".jump-to-attention")?.getBoundingClientRect();
    const latest = element.querySelector<HTMLElement>(".jump-to-latest")?.getBoundingClientRect();
    return { attentionBottom: attention?.bottom ?? 0, latestTop: latest?.top ?? 0 };
  });
  expect(buttonLayout.attentionBottom).toBeLessThan(buttonLayout.latestTop);

  await attentionButton.click();
  await expect(page.locator('[data-message-id="p-attention-2"]')).toHaveClass(/is-notification-target/);
  await expect(attentionButton).toHaveCount(0);
});

test("visible attention is consumed only while focus is inside the conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const latestId = await page.locator(".message-list [data-message-id]").last()
    .getAttribute("data-message-id");
  expect(latestId).toBeTruthy();
  await page.locator('[data-chat-id="chat-product"]').focus();
  await page.evaluate(async ({ modulePath, messageId }) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { unreadAttentionMessageIds: Map<string, string[]> };
        setState: (partial: { unreadAttentionMessageIds: Map<string, string[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-product", [messageId]);
    module.telegramStore.setState({ unreadAttentionMessageIds });
  }, { modulePath: "/src/store/telegramStore.ts", messageId: latestId! });

  await expect(page.locator(".jump-to-attention")).toBeVisible();
  await page.getByRole("textbox", { name: "消息内容" }).focus();
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { unreadAttentionMessageIds: Map<string, string[]> };
      };
    };
    return module.telegramStore.getState().unreadAttentionMessageIds
      .get("chat-product")?.length ?? 0;
  }, "/src/store/telegramStore.ts")).toBe(0);
  await expect(page.locator(".jump-to-attention")).toHaveCount(0);
});

test("attention button occupies the lower slot and animates when latest appears", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-chat-id="chat-product"]').focus();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, Array<{ id: string }>>;
          unreadAttentionMessageIds: Map<string, string[]>;
        };
        setState: (partial: { unreadAttentionMessageIds: Map<string, string[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const firstId = state.messages.get("chat-product")?.[0]?.id;
    if (!firstId) return;
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-product", [firstId]);
    module.telegramStore.setState({ unreadAttentionMessageIds });
  }, "/src/store/telegramStore.ts");

  const attentionButton = page.locator(".jump-to-attention");
  await expect(attentionButton).toBeVisible();
  await expect(attentionButton).not.toHaveClass(/is-stacked/);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  await expect.poll(() => page.locator(".message-list-shell").evaluate((shell) => {
    const attention = shell.querySelector<HTMLElement>(".jump-to-attention")!;
    return shell.getBoundingClientRect().bottom - attention.getBoundingClientRect().bottom;
  })).toBeLessThanOrEqual(20);

  await scrollAwayFromBottom(page);
  await expect(page.locator(".jump-to-latest")).toBeVisible();
  await expect(attentionButton).toHaveClass(/is-stacked/);
  await expect.poll(() => page.locator(".conversation").evaluate((conversation) => {
    const attention = conversation.querySelector<HTMLElement>(".jump-to-attention")!;
    const latest = conversation.querySelector<HTMLElement>(".jump-to-latest")!;
    return latest.getBoundingClientRect().top - attention.getBoundingClientRect().bottom;
  })).toBeGreaterThan(0);
  await expect(attentionButton).not.toHaveCSS("transition-duration", "0s");
});

test("large emoji and sticker replies keep compact transparent geometry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await picker.getByRole("button", { name: /发送贴纸/ }).first().click();
  await expect(page.locator('[data-media-type="sticker"]').last()).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    const stickerTemplate = [...current].reverse().find((message) => {
      const content = message.content as { kind?: string; mediaType?: string } | undefined;
      return content?.kind === "media" && content.mediaType === "sticker";
    });
    if (!latest || !stickerTemplate) return;
    const timestamp = Date.now() + 10_000;
    const replyTarget = {
      ...latest,
      id: "p-sticker-reply-target",
      renderKey: undefined,
      senderId: "me",
      outgoing: true,
      sentAt: new Date(timestamp).toISOString(),
      replyTo: undefined,
      content: { kind: "text", text: "被引用的文本消息" },
    };
    current.push(
      replyTarget,
      {
        ...latest,
        id: "p-large-emoji",
        renderKey: undefined,
        senderId: "u-emoji",
        outgoing: false,
        sentAt: new Date(timestamp + 1_000).toISOString(),
        replyTo: undefined,
        content: { kind: "text", text: "😀" },
      },
      {
        ...stickerTemplate,
        id: "p-sticker-group-first",
        renderKey: undefined,
        senderId: "u-sticker",
        senderTag: "Administrator",
        outgoing: false,
        sentAt: new Date(timestamp + 2_000).toISOString(),
        replyTo: undefined,
      },
      {
        ...latest,
        id: "p-sticker-group-last",
        renderKey: undefined,
        senderId: "u-sticker",
        outgoing: false,
        sentAt: new Date(timestamp + 3_000).toISOString(),
        replyTo: undefined,
        content: { kind: "text", text: "同组的下一条消息" },
      },
      {
        ...stickerTemplate,
        id: "p-sticker-with-reply",
        renderKey: undefined,
        senderId: "u-reply-sticker",
        outgoing: false,
        sentAt: new Date(timestamp + 4_000).toISOString(),
        replyTo: {
          kind: "message",
          messageId: replyTarget.id,
          outgoing: true,
          senderName: "我",
          text: "被引用的文本消息",
          content: replyTarget.content,
        },
      },
    );
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const emoji = page.locator('[data-message-id="p-large-emoji"]');
  await emoji.scrollIntoViewIfNeeded();
  const emojiGeometry = await emoji.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const flow = element.querySelector<HTMLElement>(".message-text-flow.is-large-emoji");
    const richText = element.querySelector<HTMLElement>(".message-rich-text");
    return {
      bubbleHeight: bubble?.getBoundingClientRect().height ?? 0,
      flowHeight: flow?.getBoundingClientRect().height ?? 0,
      richTextHeight: richText?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(emojiGeometry.richTextHeight).toBeGreaterThan(30);
  expect(emojiGeometry.flowHeight).toBeLessThanOrEqual(52);
  expect(emojiGeometry.bubbleHeight).toBeLessThanOrEqual(68);

  const firstSticker = page.locator('[data-message-id="p-sticker-group-first"]');
  await firstSticker.scrollIntoViewIfNeeded();
  await expect(firstSticker).toHaveClass(/group-first/);
  await expect(firstSticker.locator(".message-sender-row")).toHaveCount(0);
  const firstStickerStyle = await firstSticker.locator(".message-bubble").evaluate((element) => ({
    backgroundColor: getComputedStyle(element).backgroundColor,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
  expect(firstStickerStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(firstStickerStyle.boxShadow).toBe("none");

  const repliedSticker = page.locator('[data-message-id="p-sticker-with-reply"]');
  await repliedSticker.scrollIntoViewIfNeeded();
  const repliedStickerStyle = await repliedSticker.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const preview = element.querySelector<HTMLElement>(".message-reply-preview");
    const media = element.querySelector<HTMLElement>('[data-media-type="sticker"]');
    const previewBounds = preview?.getBoundingClientRect();
    const mediaBounds = media?.getBoundingClientRect();
    return {
      bubbleBackground: bubble ? getComputedStyle(bubble).backgroundColor : "",
      previewBackground: preview ? getComputedStyle(preview).backgroundColor : "",
      verticalGap: previewBounds && mediaBounds ? mediaBounds.top - previewBounds.bottom : -1,
    };
  });
  expect(repliedStickerStyle.bubbleBackground).toBe("rgba(0, 0, 0, 0)");
  expect(repliedStickerStyle.previewBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(repliedStickerStyle.verticalGap).toBeGreaterThanOrEqual(0);
  expect(repliedStickerStyle.verticalGap).toBeLessThanOrEqual(4);
});

test("a chat left at the latest position returns to the latest message", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    current.push({
      ...latest,
      id: "p-return-latest",
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "返回时仍在最新位置" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.getByText("返回时仍在最新位置", { exact: true })).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("clicking the selected conversation repeatedly converges to its latest message", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await product.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await product.click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const messageList = page.locator(".message-list");
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await expect.poll(async () => {
      const metrics = await messageListMetrics(page);
      return metrics.scrollHeight - metrics.clientHeight;
    }).toBeGreaterThan(200);
    await messageList.hover();
    await page.mouse.wheel(0, -900);
    await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
      .toBeGreaterThan(100);
    const listNode = await messageList.elementHandle();
    if (!listNode) throw new Error("Message list is not mounted");
    await product.click();
    expect(await page.evaluate(
      (node) => node === document.querySelector(".message-list"),
      listNode,
    )).toBe(true);
    await listNode.dispose();
    await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
    await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  }
});

test("loading older messages preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row").first()).toBeAttached();

  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      MockTelegramTransport: {
        prototype: {
          loadChatHistory: (...args: unknown[]) => Promise<unknown>;
        };
      };
    };
    const prototype = module.MockTelegramTransport.prototype;
    const original = prototype.loadChatHistory;
    let release: (() => void) | undefined;
    prototype.loadChatHistory = async function (...args: unknown[]) {
      await new Promise<void>((resolve) => { release = resolve; });
      return original.apply(this, args);
    };
    Object.assign(globalThis, {
      __notgramReleaseHistoryLoad: () => release?.(),
    });
  }, "/src/telegram/mockTransport.ts");
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 40;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const before = await list.evaluate((element) => {
    const listBounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
      });
    return {
      id: row?.dataset.messageId,
      offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    };
  });

  expect(before.id).toBeTruthy();
  await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramReleaseHistoryLoad: () => void }
  ).__notgramReleaseHistoryLoad());
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<{ id: string }>> };
      };
    };
    return storeModule.telegramStore.getState().messages.get("chat-product")
      ?.some((message) => message.id === "p-old-1") ?? false;
  }, "/src/store/telegramStore.ts")).toBe(true);
  const loadedIds = await page.locator(".message-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.messageId),
  );
  expect(new Set(loadedIds).size).toBe(loadedIds.length);
  await expect.poll(() => page.locator(
    `.message-row[data-message-id="${before.id}"]`,
  ).evaluate((row, expectedOffset) => Math.abs(
    row.getBoundingClientRect().top -
    (row.closest(".message-list")?.getBoundingClientRect().top ?? 0) -
    expectedOffset,
  ), before.offset)).toBeLessThanOrEqual(2);
});

test("chat organization menu confirms pin, mute, and archive changes", async ({ page }) => {
  await page.goto("/");
  const moreButton = page.getByRole("button", { name: "更多操作" });
  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');

  await moreButton.click();
  const menu = page.getByRole("menu", { name: "会话操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "取消置顶" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(moreButton).toBeFocused();

  await moreButton.click();
  await openConversationMessageSearch(page);
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "移除会话搜索范围" }).click();

  await moreButton.click();
  await expect(menu.getByRole("menuitem", { name: "取消置顶" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(productRow).toHaveAttribute("data-pinned", "false");

  await moreButton.click();
  await menu.getByRole("menuitem", { name: "置顶会话" }).click();
  await expect(productRow).toHaveAttribute("data-pinned", "true");

  await moreButton.click();
  await menu.getByRole("menuitem", { name: "静音通知" }).click();
  await expect(productRow).toHaveClass(/is-muted/);

  await moreButton.click();
  await expect(menu.getByRole("menuitem", { name: "取消静音" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "归档会话" }).click();
  await expect(productRow).toHaveCount(0);
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await moreButton.click();
  await menu.getByRole("menuitem", { name: "移出归档" }).click();
  await expect(productRow).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 700 });
  await productRow.click();
  await moreButton.click();
  await expect(menu).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("messages support pin lists, notification scope, and auto-delete settings", async ({ page }) => {
  await page.goto("/");
  const target = await revealVirtualMessage(page, "p-1");
  await target.locator(".message-bubble-shell").click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("menuitem", { name: "置顶消息" })).toBeVisible();
  await messageMenu.getByRole("menuitem", { name: "置顶消息" }).click();
  const pinDialog = page.getByRole("dialog", { name: "置顶消息" });
  await expect(pinDialog).toBeVisible();
  await pinDialog.getByLabel("静音置顶通知").check();
  await pinDialog.getByRole("button", { name: /^置顶/ }).click();
  await expect(pinDialog).toBeHidden();
  await expect(target.locator('[aria-label="已置顶"]')).toBeVisible();

  const pinnedBanner = page.locator(".pinned-message-banner");
  await expect(pinnedBanner).toBeVisible();
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");
  const pinnedBannerLayout = await pinnedBanner.evaluate((element) => {
    const shell = element.parentElement!;
    const list = shell.querySelector<HTMLElement>(".message-list")!;
    const bannerBounds = element.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    const listBounds = list.getBoundingClientRect();
    return {
      bannerTop: bannerBounds.top,
      bannerBottom: bannerBounds.bottom,
      shellTop: shellBounds.top,
      shellScrollTop: shell.scrollTop,
      listTop: listBounds.top,
    };
  });
  expect(pinnedBannerLayout.bannerTop).toBeCloseTo(pinnedBannerLayout.shellTop, 0);
  expect(pinnedBannerLayout.listTop).toBeCloseTo(pinnedBannerLayout.bannerBottom, 0);
  expect(pinnedBannerLayout.shellScrollTop).toBe(0);
  const normalTargetOffset = await target.evaluate((element) => {
    const list = element.closest(".message-list")!;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });

  await pinnedBanner.getByRole("button", { name: "查看全部置顶消息" }).click();
  const pinnedList = page.getByRole("log", { name: "置顶消息列表" });
  await expect(page.getByRole("button", { name: "返回会话" })).toBeVisible();
  await expect(pinnedList.locator(".message-row")).toHaveCount(2);
  await expect(pinnedList).toContainText("早上好，左侧会话列表的密度已经调整好了。");
  await expect(pinnedList).toContainText("我把交互稿更新到最新版本了");
  await expect(pinnedList).not.toContainText("看到了。消息区再留一点呼吸感");
  const locateButton = pinnedList.getByRole("button", { name: /跳转到消息原位置：早上好/ });
  const locateGeometry = await locateButton.evaluate((button) => {
    const shell = button.closest<HTMLElement>(".message-bubble-shell")!;
    const buttonBounds = button.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    return {
      width: buttonBounds.width,
      height: buttonBounds.height,
      rightOffset: buttonBounds.right - shellBounds.right,
      topOffset: buttonBounds.top - shellBounds.top,
    };
  });
  expect(locateGeometry).toEqual({ width: 28, height: 28, rightOffset: -5, topOffset: 5 });
  expect(await horizontalOverflow(page)).toBe(false);

  await page.getByRole("button", { name: "返回会话" }).click();
  const normalList = page.getByRole("log", { name: "消息列表" });
  await expect(normalList).toBeVisible();
  await expect.poll(async () => target.evaluate((element) => {
    const list = element.closest(".message-list")!;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  })).toBeCloseTo(normalTargetOffset, 0);

  await pinnedBanner.getByRole("button", { name: "查看全部置顶消息" }).click();
  await locateButton.click();
  await expect(normalList).toBeVisible();
  await expect(target).toHaveClass(/is-notification-target/);

  const pinnedP4 = await revealVirtualMessage(page, "p-4");
  await pinnedP4.locator(".message-bubble-shell").click({ button: "right" });
  await page.getByRole("menu", { name: "消息操作" })
    .getByRole("menuitem", { name: "取消置顶" }).click();
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");

  await page.getByRole("button", { name: "更多操作" }).click();
  const chatMenu = page.getByRole("menu", { name: "会话操作" });

  await chatMenu.getByRole("menuitem", { name: "自动删除消息" }).click();
  const autoDeleteDialog = page.getByRole("dialog", { name: "自动删除消息" });
  await autoDeleteDialog.getByLabel("自动删除时长").selectOption("604800");
  await autoDeleteDialog.getByRole("button", { name: "保存" }).click();
  await expect(autoDeleteDialog).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const module = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => { chats: Map<string, { messageAutoDeleteTime?: number }> };
      };
    };
    return module.telegramStore.getState().chats.get("chat-product")?.messageAutoDeleteTime;
  })).toBe(604800);

  await page.getByRole("button", { name: "更多操作" }).click();
  await chatMenu.getByRole("menuitem", { name: "自动删除消息" }).click();
  await autoDeleteDialog.getByLabel("自动删除时长").selectOption("custom");
  await autoDeleteDialog.getByLabel("自定义天数").fill("12");
  await autoDeleteDialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const module = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => { chats: Map<string, { messageAutoDeleteTime?: number }> };
      };
    };
    return module.telegramStore.getState().chats.get("chat-product")?.messageAutoDeleteTime;
  })).toBe(1_036_800);
});

test("pinned banner advances through earlier pins as source messages enter the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto("/");
  await page.addStyleTag({ content: ".message-row { min-height: 96px; }" });
  await page.evaluate(async () => {
    const module = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => {
          pinMessage: (
            messageId: string,
            disableNotification: boolean,
            onlyForSelf: boolean,
          ) => Promise<boolean>;
        };
      };
    };
    const state = module.telegramStore.getState();
    await state.pinMessage("p-old-1", true, false);
    await state.pinMessage("p-1", true, false);
  });

  const pinnedBanner = page.locator(".pinned-message-banner");
  const pinnedPreview = pinnedBanner.locator(".pinned-message-preview");
  await expect(pinnedBanner).toContainText("我把交互稿更新到最新版本了");

  await pinnedPreview.click();
  const latestPinnedSource = page.locator('[data-message-id="p-4"]');
  await expect(latestPinnedSource).toBeVisible();
  await expect(latestPinnedSource).not.toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");

  await pinnedPreview.click();
  const middlePinnedSource = page.locator('[data-message-id="p-1"]');
  await expect(middlePinnedSource).toBeVisible();
  await expect(middlePinnedSource).not.toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("产品讨论历史消息 1");

  await pinnedPreview.click();
  const earliestPinnedSource = page.locator('[data-message-id="p-old-1"]');
  await expect(earliestPinnedSource).toBeVisible();
  await expect(earliestPinnedSource).not.toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("产品讨论历史消息 1");

  const messageList = page.getByRole("log", { name: "消息列表", exact: true });
  await expect.poll(() => earliestPinnedSource.evaluate((element) => {
    const list = element.closest<HTMLElement>(".message-list")!;
    const listBounds = list.getBoundingClientRect();
    const targetBounds = element.getBoundingClientRect();
    return targetBounds.bottom > listBounds.top + 1 && targetBounds.top < listBounds.bottom - 1;
  })).toBe(true);
  const scrollTopBeforeNoop = await messageList.evaluate((element) => element.scrollTop);
  await pinnedPreview.click();
  await page.waitForTimeout(350);
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTopBeforeNoop, 0);
  await expect(earliestPinnedSource).not.toHaveClass(/is-notification-target/);
});

test("native context menu rows fill a consistently rounded popup frame", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
    const createPanel = (className: string, label: string) => {
      const panel = document.createElement("div");
      panel.className = `${className} context-menu-panel`;
      for (let index = 0; index < 5; index += 1) {
        const group = document.createElement("div");
        group.className = "native-context-menu-group";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${label}-${index}`;
        group.append(button);
        panel.append(group);
      }
      return panel;
    };
    const collapsedStage = document.createElement("div");
    collapsedStage.className = "native-context-menu-stage";
    collapsedStage.dataset.nativeMenuFixture = "collapsed";
    collapsedStage.style.cssText = "position:fixed;left:0;top:0;width:170px;height:236px;z-index:9999;--native-context-primary-width:146px";
    collapsedStage.append(createPanel("native-context-menu", "action"));
    document.body.append(collapsedStage);

    const expandedStage = document.createElement("div");
    expandedStage.className = "native-context-menu-stage";
    expandedStage.dataset.nativeMenuFixture = "expanded";
    expandedStage.style.cssText = "position:fixed;left:180px;top:0;width:308px;height:236px;z-index:9999;--native-context-primary-width:146px;--native-context-submenu-width:132px;--native-context-submenu-x:164px;--native-context-submenu-y:0px";
    expandedStage.append(createPanel("native-context-menu", "primary"));
    expandedStage.append(createPanel("native-context-menu-children", "child"));
    document.body.append(expandedStage);
  });

  const collapsedStage = page.locator('[data-native-menu-fixture="collapsed"]');
  const panel = collapsedStage.locator(".native-context-menu");
  const buttons = panel.locator("button");
  const metrics = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const stageBounds = element.parentElement!.getBoundingClientRect();
    const rows = [...element.querySelectorAll("button")].map((button) =>
      button.getBoundingClientRect());
    return {
      borderRadius: style.borderRadius,
      gap: style.rowGap,
      overflow: style.overflow,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      firstInset: rows[0].top - bounds.top,
      lastInset: bounds.bottom - rows.at(-1)!.bottom,
      rowGaps: rows.slice(1).map((row, index) => row.top - rows[index].bottom),
      rightGutter: stageBounds.right - bounds.right,
      width: bounds.width,
      shadow: style.boxShadow,
    };
  });
  const expandedRightGutter = await page
    .locator('[data-native-menu-fixture="expanded"] .native-context-menu-children')
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.parentElement!.getBoundingClientRect().right - bounds.right;
    });

  await expect(buttons).toHaveCount(5);
  expect(metrics.padding).toEqual(["0px", "0px", "0px", "0px"]);
  expect(metrics.gap).toBe("0px");
  expect(metrics.overflow).toBe("hidden");
  expect(metrics.borderRadius).toBe("8px");
  expect(metrics.firstInset).toBeCloseTo(1, 1);
  expect(metrics.lastInset).toBeCloseTo(1, 1);
  expect(metrics.rowGaps.every((gap) => Math.abs(gap) < 0.1)).toBe(true);
  expect(metrics.rightGutter).toBe(12);
  expect(metrics.width).toBe(146);
  expect(expandedRightGutter).toBe(12);
  expect(metrics.shadow).toContain("2px 6px");
});

test("chat context menu manages folders, pinning, and group exit", async ({ page }) => {
  await page.goto("/");
  const miaRow = page.locator('.chat-row[data-chat-id="chat-mia"]');

  await miaRow.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "会话操作：Mia Chen" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").nth(0)).toHaveText("取消置顶");
  await expect(menu.getByRole("menuitem").nth(1)).toHaveText("分组");
  await expect(menu.getByRole("menuitem", { name: "退出群组" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await page.getByRole("menuitemcheckbox", { name: "添加到工作" }).click();

  await page.getByRole("button", { name: "工作", exact: true }).click();
  await expect(miaRow).toBeVisible();
  await miaRow.click({ button: "right" });
  menu = page.getByRole("menu", { name: "会话操作：Mia Chen" });
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await page.getByRole("menuitemcheckbox", { name: "从工作" }).click();
  await expect(miaRow).toHaveCount(0);

  await page.getByRole("button", { name: "全部聊天", exact: true }).click();
  await miaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：Mia Chen" })
    .getByRole("menuitem", { name: "取消置顶", exact: true }).click();
  await expect(miaRow).toHaveAttribute("data-pinned", "false");
  await miaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：Mia Chen" })
    .getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(miaRow).toHaveAttribute("data-pinned", "true");

  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');
  await productRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：产品讨论" })
    .getByRole("menuitem", { name: "退出群组" }).click();
  const confirm = page.getByRole("dialog", { name: "退出“产品讨论”？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "退出群组" }).click();
  await expect(productRow).toHaveCount(0);
  await expect(page.locator(".conversation-title strong")).not.toHaveText("产品讨论");
});

test("nested context menus keep the primary anchor stable and leave transparent areas clickable", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-folder-submenu { height: min(360px, calc(100vh - 16px)); }",
  });

  const releaseRow = page.locator('.chat-row[data-chat-id="chat-release"]');
  await releaseRow.scrollIntoViewIfNeeded();
  const releaseBounds = await releaseRow.boundingBox();
  expect(releaseBounds).not.toBeNull();
  await releaseRow.click({
    button: "right",
    position: {
      x: Math.min(340, (releaseBounds?.width ?? 360) - 12),
      y: (releaseBounds?.height ?? 74) - 8,
    },
  });

  let menu = page.getByRole("menu", { name: "会话操作：Release Notes" });
  let primary = menu.locator("[data-context-menu-primary]");
  const before = await primary.boundingBox();
  expect(before).not.toBeNull();
  await menu.getByRole("menuitem", { name: "分组" }).click();
  const submenu = page.getByRole("menu", { name: "选择分组" });
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveCSS("overflow-y", "hidden");
  const after = await primary.boundingBox();
  const submenuBounds = await submenu.boundingBox();
  expect(after).not.toBeNull();
  expect(submenuBounds).not.toBeNull();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
  expect((submenuBounds?.y ?? -1)).toBeGreaterThanOrEqual(8);
  expect((submenuBounds?.y ?? 0) + (submenuBounds?.height ?? 0)).toBeLessThanOrEqual(412);
  await expect(menu).toHaveAttribute("data-context-submenu-side", "left");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.addStyleTag({
    content: ".chat-folder-submenu { height: 360px; }",
  });
  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');
  await productRow.click({ button: "right", position: { x: 50, y: 24 } });
  menu = page.getByRole("menu", { name: "会话操作：产品讨论" });
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await expect(page.getByRole("menu", { name: "选择分组" })).toBeVisible();
  await expect(menu).toHaveAttribute("data-context-submenu-side", "right");

  const chenName = page.locator('.chat-row[data-chat-id="chat-chen"] strong');
  await chenName.click({ timeout: 1_000 });
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默", { timeout: 1_000 });
  await expect(menu).toBeHidden();
});

test("sidebar context menus close when content outside them scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-row { min-height: 92px; }",
  });

  const chatList = page.locator(".chat-list");
  const scrollChatList = async () => {
    const metrics = await chatList.evaluate((element) => ({
      before: element.scrollTop,
      maximum: element.scrollHeight - element.clientHeight,
      height: element.clientHeight,
    }));
    expect(metrics.maximum).toBeGreaterThan(0);
    await chatList.hover({ position: { x: 20, y: metrics.height - 10 } });
    await page.mouse.wheel(0, metrics.before < metrics.maximum ? 80 : -80);
    await expect.poll(() => chatList.evaluate((element) => element.scrollTop))
      .not.toBe(metrics.before);
  };

  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');
  await productRow.scrollIntoViewIfNeeded();
  await productRow.click({ button: "right" });
  let menu = page.locator(".context-menu-surface");
  await expect(menu).toBeVisible();
  await scrollChatList();
  await expect(menu).toBeHidden();

  const workFolder = page.getByRole("button", { name: "工作", exact: true });
  await workFolder.click({ button: "right" });
  menu = page.locator(".context-menu-surface");
  await expect(menu).toBeVisible();
  await scrollChatList();
  await expect(menu).toBeHidden();

  await productRow.scrollIntoViewIfNeeded();
  await productRow.click({ button: "right" });
  menu = page.locator(".context-menu-surface");
  await menu.getByRole("menuitem", { name: "分组" }).click();
  const submenu = menu.locator(".chat-folder-submenu");
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveCSS("overflow-y", "hidden");
  expect(await submenu.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
    .toBe(true);
  await expect(menu).toBeVisible();

  await scrollChatList();
  await expect(menu).toBeHidden();
});

test("message context menu closes when the conversation scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");

  const messageList = page.locator(".message-list");
  const visibleBubble = (await revealVirtualMessage(page, "p-2")).locator(".message-bubble-shell");
  await visibleBubble.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu).toBeVisible();

  const movement = await messageList.evaluate((element) => ({
    before: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
    height: element.clientHeight,
  }));
  expect(movement.maximum).toBeGreaterThan(0);
  await messageList.hover({ position: { x: 18, y: movement.height - 12 } });
  await page.mouse.wheel(0, movement.before > 0 ? -80 : 80);
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .not.toBe(movement.before);
  await expect(menu).toBeHidden();
});

test("folder context menu edits, marks read, and deletes a custom folder", async ({ page }) => {
  await page.goto("/");
  const workButton = page.getByRole("button", { name: "工作", exact: true });
  await workButton.click();
  await expect(page.locator('.chat-row[data-chat-id="chat-release"] .unread-count')).toHaveText("8");

  await workButton.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "分组操作：工作" });
  await expect(menu.getByRole("menuitem", { name: "编辑文件夹" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "标记为已读" }).click();
  await expect(page.locator(".chat-list .unread-count")).toHaveCount(0);

  await workButton.click({ button: "right" });
  menu = page.getByRole("menu", { name: "分组操作：工作" });
  await menu.getByRole("menuitem", { name: "编辑文件夹" }).click();
  const manager = page.getByRole("dialog", { name: "聊天文件夹" });
  await expect(manager.getByLabel("名称")).toHaveValue("工作");
  await manager.getByRole("button", { name: "关闭" }).click();

  await workButton.click({ button: "right" });
  await page.getByRole("menu", { name: "分组操作：工作" })
    .getByRole("menuitem", { name: "删除" }).click();
  const confirm = page.getByRole("dialog", { name: "删除“工作”？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await expect(workButton).toHaveCount(0);
});

test("folder manager creates, edits, and deletes confirmed server folders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "管理文件夹" }).click();
  const dialog = page.getByRole("dialog", { name: "聊天文件夹" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "关闭" })).toBeFocused();

  await dialog.getByRole("button", { name: "新建文件夹" }).click();
  await dialog.getByLabel("名称").fill("客户");
  await dialog.getByRole("checkbox", { name: "Mia Chen" }).check();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("button", { name: "客户", exact: true })).toBeVisible();

  await dialog.getByLabel("名称").fill("客户团队");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("button", { name: "客户团队", exact: true })).toBeVisible();

  await dialog.getByRole("checkbox", { name: "产品讨论" }).check();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("checkbox", { name: "产品讨论" })).toBeChecked();

  await page.setViewportSize({ width: 390, height: 700 });
  expect(await horizontalOverflow(page)).toBe(false);

  await dialog.getByRole("button", { name: "删除文件夹" }).click();
  await dialog.getByRole("button", { name: "删除文件夹" }).click();
  await expect(dialog.getByRole("button", { name: "客户团队", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("button", { name: "客户团队", exact: true })).toHaveCount(0);
});
