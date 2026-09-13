import { expect, test } from "@playwright/test";
import type { ChatProfile } from "../../src/telegram/types";
import { horizontalOverflow, revealVirtualMessage, chooseMessageMenuItem } from "./helpers";

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
  const globalMessageResult = page.locator('[data-search-message-id="p-old-36"]');
  await expect(globalMessageResult.locator(".avatar")).toContainText("产");
  await expect(globalMessageResult.locator("strong")).toHaveText("产品讨论");
  await expect(globalMessageResult.locator(".global-message-result-sender")).toHaveText("林然：");

  await page.getByRole("tab", { name: "媒体" }).click();
  await search.fill("预览");
  const target = page.locator('[data-search-message-id="p-5"]');
  await expect(target).toContainText("新的媒体预览样式");
  await target.click();
  await expect(page.locator(".global-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("预览");
  const locatedMessage = page.locator('[data-message-id="p-5"]');
  await expect(locatedMessage).toHaveClass(/is-notification-target/);
  const targetHighlight = page.locator('[data-highlight-message-id="p-5"]');
  await expect(targetHighlight).toBeVisible();
  await expect.poll(() => targetHighlight.evaluate((highlight) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const row = document.querySelector<HTMLElement>('[data-message-id="p-5"]');
    if (!list || !row) return false;
    const target = row.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    const overlay = highlight.getBoundingClientRect();
    return Math.abs(overlay.left - bounds.left) < 1 &&
      Math.abs(overlay.right - bounds.right) < 1 &&
      overlay.top <= target.top - 3.5 &&
      overlay.bottom >= target.bottom + 3.5;
  })).toBe(true);
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
  await expect(newestSearchResult.locator(".avatar")).toContainText("林");
  await expect(newestSearchResult.locator("strong")).toHaveText("林然");
  await newestSearchResult.click();
  await expect(page.locator(".chat-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("产品讨论历史消息");
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
  await expect(page.locator(".global-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("Mia Chen");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await search.fill("预览");
  await expect(page.locator('[data-search-message-id="p-5"]')).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
});

test("chat profiles expose compact detail pages, rich bios, profile music, and shared media", async ({ page }) => {
  await page.goto("/");
  const profileTrigger = page.getByRole("button", { name: "查看 产品讨论 资料" });
  await profileTrigger.click();

  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("heading", { name: "产品讨论" })).toBeVisible();
  await expect(profile.getByText("产品、设计与开发协作群。", { exact: true })).toBeVisible();
  await expect(profile.locator(".profile-member-row")).toHaveCount(0);
  await profile.getByRole("button", { name: /成员\s*查看群组成员\s*4/ }).click();
  await expect(profile.locator(".profile-member-row")).toHaveCount(4);
  const popupBounds = await profile.boundingBox();
  expect(popupBounds).not.toBeNull();
  expect(popupBounds!.height).toBeLessThanOrEqual(680);
  expect(Math.abs((popupBounds!.x + popupBounds!.width / 2) - 640)).toBeLessThan(2);

  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  await expect(profile.getByText("@mia_design", { exact: true })).toBeVisible();
  await expect(profile.getByText("u-mia", { exact: true })).toBeVisible();
  await expect(profile.getByRole("link", { name: "https://example.com" })).toBeVisible();
  await expect(profile.getByRole("link", { name: "@Mia Chen" })).toBeVisible();
  expect(await profile.locator(".profile-drawer-scroll").evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  const avatarPopupPromise = page.waitForEvent("popup");
  await profile.getByRole("button", { name: "查看 Mia Chen 的头像和历史头像" }).click();
  const avatarPopup = await avatarPopupPromise;
  await avatarPopup.waitForLoadState("domcontentloaded");
  await expect(avatarPopup.getByRole("dialog", { name: /Mia Chen 的当前头像/ })).toBeVisible();
  await expect(avatarPopup.getByRole("navigation", { name: "会话图片预览" }).getByRole("button")).toHaveCount(3);
  await expect(avatarPopup.getByRole("button", { name: "下载图片" })).toBeDisabled();
  await avatarPopup.close();
  await page.evaluate(() => {
    (window as unknown as { __notgramProfileAudioPlayCalls: string[] }).__notgramProfileAudioPlayCalls = [];
    HTMLMediaElement.prototype.play = function play() {
      const playbackId = this.dataset.playbackId;
      if (playbackId) {
        (window as unknown as { __notgramProfileAudioPlayCalls: string[] })
          .__notgramProfileAudioPlayCalls.push(playbackId);
      }
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });
  await profile.getByRole("button", { name: /音乐\s*资料歌单\s*2/ }).click();
  await expect(profile.locator(".profile-playlist-track")).toHaveCount(2);
  await profile.getByRole("button", { name: "播放 夜航界面" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramProfileAudioPlayCalls: string[] }
  ).__notgramProfileAudioPlayCalls)).toContain("profile:user:u-mia:audio:u-mia:audio:1");
  await profile.getByRole("button", { name: "返回资料" }).click();
  await profile.getByRole("button", { name: /共同群组\s*查看你们都加入的群组\s*2/ }).click();
  await expect(profile.locator(".profile-common-group-list > button")).toHaveCount(2);
  await profile.locator(".profile-common-group-list > button").first().click();
  await expect(profile).toBeHidden();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
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

test("unloaded profiles keep their top edge stable and grow only toward the bottom", async ({ page }) => {
  await page.goto("/");
  const loadedProfile: ChatProfile = {
    id: "user:u-delayed-profile",
    kind: "user",
    userId: "u-delayed-profile",
    title: "Delayed Profile",
    avatar: { label: "DP", color: "#4f7c70" },
    statusLabel: "在线",
    username: "delayed_profile",
    dataCenterId: 5,
    dataCenterLocation: "Singapore, SG",
    members: [],
    canViewMembers: false,
    groupInCommonCount: 2,
    groupsInCommon: [],
    profileAudioCount: 0,
    profileAudios: [],
  };
  const profile = page.getByRole("dialog", { name: "资料" });
  const openingMetrics = await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        setState: (partial: {
          profile: {
            target: { kind: "user"; userId: string };
            loading: boolean;
          };
        }) => void;
      };
    };
    module.telegramStore.setState({
      profile: {
        target: { kind: "user", userId: "u-delayed-profile" },
        loading: true,
      },
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const drawer = document.querySelector<HTMLElement>(".profile-drawer")!;
    const scroll = drawer.querySelector<HTMLElement>(".profile-drawer-scroll")!;
    return {
      height: drawer.offsetHeight,
      top: drawer.offsetTop,
      overflowY: getComputedStyle(scroll).overflowY,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    };
  }, "/src/store/telegramStore.ts");

  await expect(profile).toBeVisible();
  await expect(profile).toHaveAttribute("aria-busy", "true");
  const skeleton = profile.locator(".profile-loading-shell");
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveClass(/is-active/);
  const loadingMetrics = await profile.evaluate((element) => ({
    height: (element as HTMLElement).offsetHeight,
    top: (element as HTMLElement).offsetTop,
  }));

  await page.evaluate(async ({ modulePath, value }) => {
    const module = await import(modulePath) as {
      telegramStore: {
        setState: (partial: {
          profile: {
            target: { kind: "user"; userId: string };
            value: ChatProfile;
            loading: boolean;
          };
        }) => void;
      };
    };
    module.telegramStore.setState({
      profile: {
        target: { kind: "user", userId: value.userId! },
        value,
        loading: false,
      },
    });
  }, { modulePath: "/src/store/telegramStore.ts", value: loadedProfile });

  await expect(profile).toHaveAttribute("aria-busy", "false");
  await expect(profile.getByRole("heading", { name: loadedProfile.title })).toBeVisible();
  const loadedMetrics = await profile.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(".profile-drawer-scroll")!;
    return {
      height: (element as HTMLElement).offsetHeight,
      top: (element as HTMLElement).offsetTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    };
  });
  expect(openingMetrics.height).toBeGreaterThan(0);
  expect(openingMetrics.height).toBe(loadingMetrics.height);
  expect(loadedMetrics.height).toBeGreaterThan(loadingMetrics.height);
  expect(new Set([openingMetrics.top, loadingMetrics.top, loadedMetrics.top]).size).toBe(1);
  expect(openingMetrics.overflowY).toBe("hidden");
  expect(openingMetrics.scrollHeight).toBeLessThanOrEqual(openingMetrics.clientHeight);
  expect(loadedMetrics.scrollHeight).toBeLessThanOrEqual(loadedMetrics.clientHeight + 1);
  expect(loadedMetrics.height).toBeLessThan(602);
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

test("message hashtags open and retain scoped search", async ({ page }) => {
  await page.goto("/");
  const message = await revealVirtualMessage(page, "p-rich-entities");
  const hashtag = message.getByRole("link", { name: "#release" });
  await expect(hashtag).toBeVisible();
  await expect(hashtag).toHaveCSS("text-decoration-line", "none");
  await expect(hashtag).toHaveCSS("color", "rgb(55, 109, 153)");
  await expect.poll(() => hashtag.evaluate((link) => getComputedStyle(link, "::after").transform))
    .toBe("matrix(0, 0, 0, 1, 0, 0)");

  await hashtag.hover();
  await expect.poll(() => hashtag.evaluate((link) => getComputedStyle(link, "::after").transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  await hashtag.click();

  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeVisible();
  await expect(search).toHaveValue("#release");
  const result = page.locator('.chat-search-results-panel [data-search-message-id="p-rich-entities"]');
  await expect(result).toBeVisible();
  await expect(result.locator("strong")).toHaveText("Jules");
  await expect(result.locator(".avatar")).toContainText("J");

  await result.click();
  await expect(page.locator(".chat-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("#release");
  await expect(page.locator('[data-message-id="p-rich-entities"]')).toHaveClass(/is-notification-target/);

  await page.getByRole("button", { name: "移除会话搜索范围" }).click();
  await expect(page.locator(".chat-search-results-panel")).toBeHidden();
});

test("Telegram links navigate internally and incompatible routes stay in Notgram", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const initialPageCount = context.pages().length;

  await page.locator('[data-message-id="p-markdown"]').getByRole("link", { name: "链接" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  expect(context.pages()).toHaveLength(initialPageCount);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
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

  const userMention = row.getByRole("link", { name: "Mia Chen", exact: true });
  await expect(userMention).toHaveAttribute("href", "https://t.me/mia_design");
  await userMention.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
  await expect(profile.locator(".profile-status")).toHaveText("管理员");
  await expect(profile.locator(".profile-status")).not.toHaveClass(/is-administrator/);
  await expect(profile.locator(".profile-status")).toHaveCSS("color", "rgb(63, 118, 90)");
  await expect(profile.locator("#profile-name")).toHaveClass(/is-administrator/);
  await profile.getByRole("button", { name: "关闭资料" }).click();

  const botRow = await revealVirtualMessage(page, "p-rich-entities");
  await botRow.getByRole("link", { name: "Notgram Bot", exact: true }).click();
  await expect(profile.getByRole("heading", { name: "Notgram Bot" })).toBeVisible();
  await expect(profile.locator(".profile-status")).toHaveText("机器人");
  await expect(profile.locator(".profile-status")).toHaveClass(/is-bot/);
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  expect(context.pages()).toHaveLength(initialPageCount);
});

test("administrator names and tags use the role color in light and dark themes", async ({ page }) => {
  await page.goto("/");
  const row = await revealVirtualMessage(page, "p-rich-message");
  const sender = row.locator(".message-sender");
  const tag = row.locator(".message-sender-label");

  await expect(sender).toHaveText("Mia Chen");
  await expect(tag).toHaveText("管理员");
  await expect(sender).toHaveClass(/is-administrator/);
  await expect(tag).toHaveClass(/is-administrator/);
  await expect(sender).toHaveCSS("color", "rgb(138, 90, 166)");
  await expect(tag).toHaveCSS("background-color", "rgb(240, 228, 245)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
  });
  await expect(sender).toHaveCSS("color", "rgb(199, 154, 221)");
  await expect(tag).toHaveCSS("background-color", "rgb(65, 52, 72)");

  await sender.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.locator("#profile-name")).toHaveCSS("color", "rgb(199, 154, 221)");
  await expect(profile.locator(".profile-status")).toHaveText("管理员");
  await expect(profile.locator(".profile-status")).not.toHaveClass(/is-administrator/);
  await expect(profile.locator(".profile-status")).toHaveCSS("color", "rgb(127, 175, 145)");
});

test("administrator names use the role color in reply contexts", async ({ page }) => {
  await page.goto("/");
  const source = await revealVirtualMessage(page, "p-rich-message");
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");

  const contextName = page.locator(".composer-context-subject");
  await expect(contextName).toHaveText("Mia Chen");
  await expect(contextName).toHaveClass(/is-administrator/);
  await expect(contextName).toHaveCSS("color", "rgb(138, 90, 166)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
  });
  await expect(contextName).toHaveCSS("color", "rgb(199, 154, 221)");

  await page.getByRole("textbox", { name: "消息内容" }).fill("确认管理员引用标识");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", { hasText: "确认管理员引用标识" }).last();
  const quotedName = sent.locator(".message-reply-preview strong");
  await expect(quotedName).toHaveText("Mia Chen");
  await expect(quotedName).toHaveClass(/is-administrator/);
  await expect(quotedName).toHaveCSS("color", "rgb(199, 154, 221)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-light";
  });
  await expect(quotedName).toHaveCSS("color", "rgb(138, 90, 166)");
});

test("visible mentions follow nickname changes without changing their user target", async ({ page }) => {
  await page.goto("/");
  const row = await revealVirtualMessage(page, "p-rich-entities");
  await expect(row.getByRole("link", { name: "Mia Chen", exact: true })).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { users: Map<string, { id: string; displayName: string }> };
        setState: (patch: { users: Map<string, unknown> }) => void;
      };
    };
    const users = new Map(storeModule.telegramStore.getState().users);
    const mia = users.get("u-mia");
    if (!mia) throw new Error("Mock member is missing");
    users.set("u-mia", { ...mia, displayName: "Mia Zhou" });
    storeModule.telegramStore.setState({ users });
  }, "/src/store/telegramStore.ts");

  const renamedMention = row.getByRole("link", { name: "Mia Zhou", exact: true });
  await expect(renamedMention).toHaveAttribute("href", "https://t.me/mia_design");
  await renamedMention.click();
  await expect(page.getByRole("dialog", { name: "资料" })).toBeVisible();
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
