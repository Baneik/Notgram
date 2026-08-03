import { expect, test, type Page } from "@playwright/test";

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  }));

const messageListMetrics = (page: Page) => page.locator(".message-list").evaluate((element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
  distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
}));

const visibleMessageAnchor = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const listBounds = element.getBoundingClientRect();
  const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((candidate) => candidate.getBoundingClientRect().bottom > listBounds.top + 1);
  return {
    id: row?.dataset.messageId,
    offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    scrollTop: element.scrollTop,
  };
});

const scrollAwayFromBottom = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const maximum = element.scrollHeight - element.clientHeight;
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
  element.scrollTop = Math.max(100, Math.floor(maximum * 0.45));
  element.dispatchEvent(new Event("scroll"));
});

test("webview chrome is suppressed and settings are opened from the Notgram brand", async ({ page }) => {
  await page.goto("/");

  const settingsButton = page.locator(".rail-brand");
  await expect(settingsButton).toHaveRole("button");
  await expect(settingsButton).toHaveAccessibleName("设置");
  await expect(settingsButton).toContainText("Notgram");
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

test("desktop messaging, reactions, and preferences remain usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-row")).not.toHaveCount(0);
  await expect(page.locator(".message-day")).not.toHaveCount(0);

  const visibleBubble = page.locator(".message-bubble-shell").last();
  await visibleBubble.hover();
  await visibleBubble.locator(".reaction-add").click();
  await visibleBubble.locator(".reaction-picker button").first().click();
  await expect(visibleBubble.locator(".message-reactions > button")).toHaveCount(1);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("switch", { name: "紧凑会话密度" }).check();
  await expect(page.locator("html")).toHaveClass(/compact-chat/);
  await page.getByRole("button", { name: /高级设置/ }).click();
  await page.getByRole("button", { name: "重建界面缓存" }).click();
  await expect(page.locator(".settings-dialog .cache-health"))
    .toContainText("缓存状态：刚刚重建");
  await page.getByRole("button", { name: /软件更新/ }).click();
  await expect(page.getByRole("heading", { name: /Notgram 0\.5\.0-rc\.2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(page.getByRole("button", { name: "导出诊断包" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "保留脱敏崩溃报告" })).toBeDisabled();
  await expect(page.getByText("浏览器预览不生成诊断包")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("media cache controls clean selected data and protect active files", async ({ page }) => {
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
  await cacheSection.getByLabel("清理范围").selectOption("30");
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

  const editableMessage = page.locator('[data-message-id="p-2"]');
  let actionTrigger = editableMessage.locator(".message-action-trigger");
  await actionTrigger.focus();
  await page.keyboard.press("Enter");
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(actionMenu).toBeHidden();
  await expect(actionTrigger).toBeFocused();

  await page.keyboard.press("Enter");
  await chooseMessageMenuItem(page, "编辑");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();
  await composer.fill("keyboard edited message");
  await page.keyboard.press("Enter");
  await expect(page.getByText("keyboard edited message", { exact: true })).toBeVisible();

  actionTrigger = editableMessage.locator(".message-action-trigger");
  await actionTrigger.focus();
  await page.keyboard.press("Enter");
  await chooseMessageMenuItem(page, "回复");
  await expect(composer).toBeFocused();
  await composer.fill("keyboard reply");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message-list").getByText("keyboard reply", { exact: true }))
    .toBeVisible();

  actionTrigger = editableMessage.locator(".message-action-trigger");
  await actionTrigger.focus();
  await page.keyboard.press("Enter");
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

  const reactionTrigger = editableMessage.locator(".reaction-add");
  await reactionTrigger.focus();
  await page.keyboard.press("Enter");
  const reactionMenu = page.getByRole("menu", { name: "选择表情回应" });
  await expect(reactionMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(reactionMenu).toBeHidden();
  await expect(reactionTrigger).toBeFocused();
});

test("the unified sidebar search paginates, filters, supports regex, and opens exact messages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await page.keyboard.press("Control+K");

  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(search).toBeFocused();
  await search.fill("产品讨论历史消息");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(30);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.locator("[data-search-message-id]")).toHaveCount(36);

  await search.fill("reg:^产品讨论历史消息 3[0-6]$");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(7);
  await search.fill("reg:[");
  await expect(page.getByRole("alert").getByText("无效的正则表达式")).toBeVisible();

  await page.getByRole("tab", { name: "媒体" }).click();
  await search.fill("预览");
  const target = page.locator('[data-search-message-id="p-5"]');
  await expect(target).toContainText("新的媒体预览样式");
  await target.click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
  const locatedMessage = page.locator('[data-message-id="p-5"]');
  await expect(locatedMessage).toHaveClass(/is-notification-target/);
  const centeredOffset = await locatedMessage.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  });
  expect(centeredOffset).toBeLessThan(2);

  await page.getByRole("button", { name: "搜索消息" }).click();
  const conversationSearch = page.getByRole("searchbox", { name: "搜索当前对话" });
  await conversationSearch.fill("reg:^新的媒体预览样式$");
  await expect(page.locator('[data-message-id="p-5"]')).toBeVisible();
  await conversationSearch.fill("reg:[");
  await expect(page.locator(".messages-empty")).toHaveText("没有匹配的消息");
  await expect(page.getByRole("alert").getByText("无效的正则表达式")).toBeVisible();
  await page.getByRole("button", { name: "关闭消息搜索" }).click();
  await page.getByRole("button", { name: "关闭操作提示" }).click();

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

test("chat profiles expose members and shared media with focus restoration", async ({ page }) => {
  await page.goto("/");
  const profileTrigger = page.getByRole("button", { name: "查看 产品讨论 资料" });
  await profileTrigger.click();

  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("heading", { name: "产品讨论" })).toBeVisible();
  await expect(profile.getByText("产品、设计与开发协作群。", { exact: true })).toBeVisible();
  await expect(profile.locator(".profile-member-row")).toHaveCount(4);

  await profile.getByRole("button", { name: "共享媒体" }).click();
  await expect(profile.locator(".profile-media-list button")).not.toHaveCount(0);
  await profile.locator(".profile-media-list button").first().click();
  await expect(profile).toBeHidden();
  await expect(page.locator(".conversation")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await profileTrigger.click();
  await expect(profile).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(profileTrigger).toBeFocused();
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
  await expect(mutedBadge).toHaveCSS("background-color", "rgb(146, 154, 158)");
  await expect(regularBadge).not.toHaveCSS("background-color", "rgb(146, 154, 158)");
  await expect(page.locator(".chat-row .lucide-volume-x")).toHaveCount(0);
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

  const markdown = page.locator('[data-message-id="p-markdown"] .message-rich-text');
  await expect(markdown).toHaveAttribute("data-rich-text", "markdown");
  await expect(markdown.locator("strong")).toHaveText("Markdown 粗体");
  await expect(markdown.locator("em")).toHaveText("斜体");
  await expect(markdown.locator("del")).toHaveText("删除线");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown.locator("code")).toHaveText("code");
  await expect(markdown.locator('a[href="https://example.com"]')).toHaveText("链接");

  const entities = page.locator('[data-message-id="p-rich-entities"] .message-rich-text');
  await expect(entities).toHaveAttribute("data-rich-text", "entities");
  await expect(entities.locator("strong")).toHaveText("bold");
  await expect(entities.locator('a[href="https://example.com/rich"]')).toHaveText("link");
  await expect(page.locator('[data-message-id="p-video"] .photo-caption strong'))
    .toHaveText("昨晚");

  const richMessage = page.locator('[data-message-id="p-rich-message"] .rich-message-content');
  await expect(richMessage).toHaveAttribute("data-rich-text", "rich-message");
  await expect(richMessage.locator("h1")).toHaveText("今日小贴士");
  await expect(richMessage.locator("li")).toHaveCount(3);
  await expect(richMessage.locator("li").first().locator("strong"))
    .toHaveText("优先处理最重要的一件事");
  await expect(richMessage.locator("blockquote")).toHaveCount(2);
  await expect(richMessage.locator("code").first()).toHaveText("5,709 tokens");
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
  await expect(actionMenu.getByRole("menuitem").first()).toHaveText("以小窗播放");
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
  await expect.poll(() => popupVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await popup.mouse.move(550, 360);
  const controls = popup.locator(".video-fullscreen-controls");
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  const controlsBounds = await controls.boundingBox();
  expect(Math.round(controlsBounds!.width)).toBe(550);
  expect(Math.round(controlsBounds!.height)).toBe(80);
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");

  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("0");
  await popup.keyboard.press("f");
  await expect(popupPlayer).toHaveClass(/is-windowed/);
  await popup.mouse.move(120, 80);
  const popupClosed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: "关闭小窗" }).click();
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
  await fullscreenPopup.getByRole("button", { name: "关闭播放窗口" }).click();
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
    for (const row of [tallRow, squareRow]) {
      await row.scrollIntoViewIfNeeded();
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

test("saved and direct messages align to the conversation edges", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /收藏夹/ }).click();
  const savedMessage = page.locator('[data-message-id="s-2"]');
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveClass(/is-outgoing/);

  await page.getByRole("button", { name: /Mia Chen/ }).click();
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
  const notice = page.locator('[data-message-id="p-service"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/is-service/);
  await expect(notice.locator(".message-bubble")).toHaveText("Mia Chen 加入了群聊");
  await expect(notice.locator(".message-meta, .message-action-trigger")).toHaveCount(0);
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
});

test("developer mode copies the complete raw unknown message", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:1422",
  });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const notice = page.locator('[data-message-id="p-unknown"]');
  await expect(notice).toContainText("收到新类型消息（messageFutureType）");
  await expect(notice.locator(".unknown-message-copy")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await page.getByRole("switch", { name: "开发者模式" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  const copyButton = notice.getByRole("button", { name: "复制 messageFutureType 原始消息" });
  await copyButton.click();
  await expect(copyButton).toContainText("已复制原始消息");
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied).toMatchObject({
    "@type": "message",
    id: "p-unknown",
    content: { "@type": "messageFutureType" },
  });
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);

  const restored = await visibleMessageAnchor(page);
  for (const text of ["滚动定位测试一", "滚动定位测试二"]) {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  }

  const jumpButton = page.getByRole("button", { name: "跳到最新消息，2 条新消息" });
  await expect(jumpButton).toBeVisible();
  const afterMessages = await visibleMessageAnchor(page);
  expect(afterMessages.id).toBe(restored.id);
  expect(Math.abs(afterMessages.offset - restored.offset)).toBeLessThanOrEqual(2);

  await jumpButton.click();
  await expect(jumpButton).toBeHidden();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await page.getByRole("textbox", { name: "消息内容" }).fill("底部自动跟随测试");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await scrollAwayFromBottom(page);
  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await page.getByRole("button", { name: /产品讨论/ }).dblclick();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
});

test("loading older messages preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).toHaveCount(30);

  const list = page.locator(".message-list");
  const before = await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 40;
    const listBounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > listBounds.top + 1);
    const result = {
      id: row?.dataset.messageId,
      offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    };
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return result;
  });

  expect(before.id).toBeTruthy();
  await expect.poll(() => page.locator(".message-row").count()).toBeGreaterThan(30);
  const loadedIds = await page.locator(".message-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.messageId),
  );
  expect(new Set(loadedIds).size).toBe(loadedIds.length);
  const offset = await page.locator(`.message-row[data-message-id="${before.id}"]`).evaluate(
    (row) => row.getBoundingClientRect().top -
      (row.closest(".message-list")?.getBoundingClientRect().top ?? 0),
  );
  expect(Math.abs(offset - before.offset)).toBeLessThanOrEqual(2);
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
  await page.getByRole("button", { name: "搜索消息" }).click();
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "关闭消息搜索" }).click();

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
