import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { conversationSwitchRecords, revealVirtualMessage, openConversationMessageSearch, chooseMessageMenuItem } from "./helpers";

test("forum groups reopen the last topic and expose compact horizontal navigation", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();

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
  await page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: {
        getState: () => { forumTopics: Map<string, Array<{ id: string; unreadCount: number; unreadReactionCount: number }>> };
        setState: (state: { forumTopics: Map<string, Array<{ id: string; unreadCount: number; unreadReactionCount: number }>> }) => void;
      };
    };
    const forumTopics = new Map(module.telegramStore.getState().forumTopics);
    forumTopics.set("chat-forum", (forumTopics.get("chat-forum") ?? []).map((topic) => topic.id === "18"
      ? { ...topic, unreadCount: 0, unreadReactionCount: 2 }
      : topic));
    module.telegramStore.setState({ forumTopics });
  }, "/src/store/telegramStore.ts");
  const reactionTopicTab = strip.locator('[data-topic-id="18"]');
  await expect(reactionTopicTab).toHaveAttribute("aria-label", "设计反馈，2 条未读回应");
  await expect(reactionTopicTab.locator(".forum-topic-tab-count.has-reaction")).toHaveText("2");

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

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect(page.getByRole("region", { name: "构建与发布 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.getByRole("button", { name: "返回话题列表" })).toHaveCount(0);
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, Message[]>;
          unreadAttentionMessageIds: Map<string, string[]>;
        };
        setState: (state: {
          messages: Map<string, Message[]>;
          unreadAttentionMessageIds: Map<string, string[]>;
        }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-forum", (messages.get("chat-forum") ?? []).map((message) => message.id === "forum-design-1"
      ? { ...message, containsUnreadReaction: true }
      : message));
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-forum", ["forum-design-1"]);
    module.telegramStore.setState({ messages, unreadAttentionMessageIds });
  }, "/src/store/telegramStore.ts");
  const reactionJump = page.getByRole("button", { name: "跳到回应，1 条待查看" });
  await expect(reactionJump).toBeVisible();
  await reactionJump.click();
  await expect(page.getByRole("region", { name: "设计反馈 话题 对话" })).toBeVisible();
  await expect(page.locator('[data-message-id="forum-design-1"]')).toBeVisible();
  await page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { setState: (state: { activeTopicId: undefined }) => void };
    };
    module.telegramStore.setState({ activeTopicId: undefined });
  }, "/src/store/telegramStore.ts");
  const topicsView = page.getByRole("region", { name: "Notgram 论坛 话题" });
  await expect(topicsView).toBeVisible();
  const reactionTopicRow = topicsView.locator(".forum-topic-row").filter({ hasText: "设计反馈" });
  await expect(reactionTopicRow.locator(".forum-topic-meta strong.has-reaction"))
    .toHaveAttribute("aria-label", "2 条未读回应");
});

test("non-forum group conversations keep messages that belong to a message thread", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="product-thread-1"]')).toBeVisible();
  await expect(page.getByText("群组线程消息也应显示在主会话中。", { exact: true })).toBeVisible();
});

test("creates a public supergroup with initial members and permissions", { tag: "@smoke" }, async ({ page }) => {
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
  await expect(page.locator('.chat-list[data-active=true] .chat-row[data-chat-id^="chat-created-"]')).toContainText("Notgram QA Team");
  await page.locator(".conversation-profile-trigger").click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toContainText("桌面客户端验收协作");
  await profile.locator(".profile-navigation > button").filter({ hasText: "成员" }).click();
  await expect(profile.locator(".profile-member-row")).toHaveCount(2);
});

test("manages member exceptions, default permissions, and audit events", async ({ page }) => {
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
  await expect(dialog.getByLabel("慢速模式间隔")).toHaveCount(0);
  await expect(dialog.getByText("成员例外权限", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "审计日志" }).click();
  await expect(dialog.getByText("更新群组默认发送权限", { exact: true })).toBeVisible();
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

test("suggests bot commands and sends paginated inline results", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await composer.fill("/");
  const suggestions = page.getByRole("listbox", { name: "机器人命令建议" });
  await expect(suggestions.getByRole("option")).toHaveCount(3);
  await expect(suggestions.locator(".bot-suggestion-group")).toHaveCount(2);
  await expect(suggestions.locator('[data-bot-user-id="bot:qa_helper_bot"]')).toContainText("@qa_helper_bot");
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
  expect(suggestionLayout.width).toBeGreaterThan(280);
  expect(suggestionLayout.width).toBeLessThan(320);
  expect(suggestionLayout.commandBottom).toBeLessThanOrEqual(suggestionLayout.descriptionTop + 1);
  await expect(suggestions.locator(".bot-suggestion-group-heading").first()).toHaveCSS("height", "29px");
  await expect(firstSuggestion.locator(".avatar")).toHaveCount(1);
  await expect(firstSuggestion.locator(".bot-suggestion-command small")).toHaveCount(0);
  await suggestions.evaluate((element) => {
    element.style.maxHeight = "84px";
  });
  await composer.press("ArrowDown");
  await composer.press("ArrowDown");
  await expect.poll(() => suggestions.evaluate((element) => {
    const active = element.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!active) return false;
    const panelBounds = element.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    return element.scrollTop > 0 && activeBounds.top >= panelBounds.top && activeBounds.bottom <= panelBounds.bottom;
  })).toBe(true);
  await composer.fill("/he");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "/help@notgram_bot ");
  await composer.fill("/st");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await suggestions.getByRole("option").click();
  await expect(composer).toHaveJSProperty("value", "/start@notgram_bot ");
  await composer.fill("/start@notgram_bot campaign");
  await composer.press("Enter");
  await expect(page.getByText("/start campaign", { exact: true })).toBeVisible();

  await composer.fill("@notgram_bot release");
  const inline = page.getByRole("region", { name: "Inline 查询结果" });
  await expect(inline.getByRole("button").filter({ hasText: "快速摘要" })).toBeVisible();
  await inline.getByRole("button").filter({ hasText: "快速摘要" }).click();
  await expect(page.getByText("@notgram_bot: release", { exact: true })).toBeVisible();

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
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

test("opens parameterized bot links and preserves the start payload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const openBotLink = (url: string) => page.evaluate(async (targetUrl) => {
    const modulePath = "/src/utils/externalLinks.ts";
    const { openTelegramLinkInApp } = await import(/* @vite-ignore */ modulePath);
    return openTelegramLinkInApp(targetUrl);
  }, url);

  await expect(openBotLink("https://t.me/notgram_bot?start=verify_A1b2-token"))
    .resolves.toBe(true);
  await expect(page.getByRole("button", { name: "启动机器人" })).toBeVisible();
  await page.getByRole("button", { name: "启动机器人" }).click();
  const botMessages = page.locator(".message-list").getByText("/start verify_A1b2-token", { exact: true });
  await expect(botMessages).toHaveCount(1);
  await expect(page.getByRole("button", { name: "启动机器人" })).toHaveCount(0);

  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await page.evaluate(() => {
    document.documentElement.dataset.botStartMounted = "false";
    const observer = new MutationObserver(() => {
      if (document.querySelector(".bot-start-bar")) {
        document.documentElement.dataset.botStartMounted = "true";
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    (globalThis as typeof globalThis & { botStartObserver?: MutationObserver }).botStartObserver = observer;
  });
  await expect(openBotLink("tg://resolve?domain=notgram_bot&start=verify_A1b2-token"))
    .resolves.toBe(true);
  await expect(botMessages).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute("data-bot-start-mounted", "false");
  await expect(page.getByRole("button", { name: "启动机器人" })).toHaveCount(0);
  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { botStartObserver?: MutationObserver };
    target.botStartObserver?.disconnect();
    delete target.botStartObserver;
    delete document.documentElement.dataset.botStartMounted;
  });
});

test("blocks users and reports chats or selected messages", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "举报", exact: true }).click();
  const report = page.getByRole("dialog", { name: /举报“产品讨论”/ });
  await expect(report.getByRole("group", { name: "举报原因" })).toBeVisible();
  await expect(report.getByRole("radio")).toHaveCount(10);
  await report.getByRole("radio", { name: "垃圾信息或诈骗", exact: true }).check();
  await report.getByRole("button", { name: "继续举报" }).click();
  await report.getByRole("radio", { name: "垃圾信息", exact: true }).check();
  await report.getByRole("button", { name: "继续举报" }).click();
  await expect(report.getByRole("heading", { name: "选择举报消息" })).toBeVisible();
  await report.locator(".report-message-row input").first().check();
  await report.getByRole("button", { name: "继续举报" }).click();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  await report.getByRole("button", { name: "完成" }).click();
  await expect(report).toBeHidden();
  await profile.locator(".profile-navigation > button").filter({ hasText: "成员" }).click();
  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  const localBlockAction = profile.locator(".profile-actions button").filter({ hasText: "屏蔽" }).first();
  const localBlockWidth = await localBlockAction.evaluate((element) => element.getBoundingClientRect().width);
  await localBlockAction.click();
  await expect(profile.getByRole("button", { name: "解除屏蔽", exact: true })).toBeVisible();
  await expect(localBlockAction).toHaveText("屏蔽");
  await expect(localBlockAction).toHaveClass(/is-active/);
  expect(await localBlockAction.evaluate((element) => element.getBoundingClientRect().width)).toBe(localBlockWidth);
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"] .chat-preview')).toHaveText("消息已屏蔽");
  await profile.getByRole("button", { name: "解除屏蔽", exact: true }).click();
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"] .chat-preview')).toHaveText("那我们下午三点对一下细节");
  const blacklistAction = profile.locator(".profile-actions button").filter({ hasText: "黑名单" }).first();
  const blacklistWidth = await blacklistAction.evaluate((element) => element.getBoundingClientRect().width);
  await blacklistAction.click();
  await expect(profile.getByRole("button", { name: "移出黑名单", exact: true })).toBeVisible();
  await expect(blacklistAction).toHaveText("黑名单");
  await expect(blacklistAction).toHaveClass(/is-active/);
  expect(await blacklistAction.evaluate((element) => element.getBoundingClientRect().width)).toBe(blacklistWidth);
  await profile.getByRole("button", { name: "移出黑名单", exact: true }).click();
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(page.locator(".conversation-profile-trigger")).toBeFocused();

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
  await messageReport.getByRole("radio", { name: "我不喜欢此内容", exact: true }).check();
  await messageReport.getByRole("button", { name: "继续举报" }).click();
  await messageReport.getByRole("button", { name: "提交举报" }).click();
  await expect(messageReport.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  await messageReport.getByRole("button", { name: "完成" }).click();
  await expect(messageReport).toBeHidden();
});

test("locally masks a group member and reveals messages at the requested scope", async ({ page }) => {
  await page.addInitScript((storageKey) => {
    localStorage.setItem(storageKey, JSON.stringify([{
      accountId: "default",
      userId: "u-mia",
      realName: "Mia Chen",
      realAvatar: { label: "MC", color: "#8d6cab" },
      alias: "小熊",
      aliasAvatar: { label: "🐻", color: "#8b6b55" },
      identityId: "bear",
      blockedAt: "2026-08-21T00:00:00.000Z",
    }]));
  }, "notgram:local-user-blocks:v1");

  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('.message-list[aria-busy="false"]')).toBeVisible();
  await expect(page.locator(".message-bubble-shell.is-local-block-concealed").first()).toBeVisible();

  await page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
      message.id === "p-channel-reply"
        ? {
            ...message,
            senderId: "u-mia",
            forwardInfo: {
              origin: { kind: "user", userId: "u-mia" },
              source: { chatId: "chat-product", messageId: "p-3", senderId: "u-mia", outgoing: false },
            },
          }
        : message,
    ));
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const concealedForward = page.locator('[data-message-id="p-channel-reply"]');
  await concealedForward.scrollIntoViewIfNeeded();
  await expect(concealedForward.locator(".message-forward-label")).toHaveText(/转发自 受限来源/);
  await expect(concealedForward.locator("button.message-forward-label")).toHaveCount(0);
  await expect(concealedForward.locator(".message-forward-label")).toHaveCSS("filter", "none");

  const keyboardRow = await revealVirtualMessage(page, "p-bot-keyboard");
  const concealedBounds = await keyboardRow.evaluate((row) => {
    const bubble = row.querySelector<HTMLElement>(":scope > .message-bubble-shell > .message-bubble")!;
    const overlay = bubble.querySelector<HTMLElement>(":scope > .local-block-message-reveal")!;
    return {
      bubble: bubble.getBoundingClientRect().toJSON(),
      overlay: overlay.getBoundingClientRect().toJSON(),
    };
  });
  expect(Math.abs(concealedBounds.bubble.width - concealedBounds.overlay.width)).toBeLessThan(0.5);
  expect(Math.abs(concealedBounds.bubble.height - concealedBounds.overlay.height)).toBeLessThan(0.5);

  const richRow = await revealVirtualMessage(page, "p-rich-message");
  const maskLayering = await richRow.evaluate((row) => {
    const bubble = row.querySelector<HTMLElement>(":scope > .message-bubble-shell > .message-bubble")!;
    const sender = bubble.querySelector<HTMLElement>(":scope > .message-sender-row")!;
    const overlay = bubble.querySelector<HTMLElement>(":scope > .local-block-message-reveal")!;
    const unclippedBlurredChildren = [...bubble.children].filter((child) => {
      const style = getComputedStyle(child);
      return style.filter !== "none" && style.clipPath === "none";
    });
    return {
      senderZIndex: Number.parseInt(getComputedStyle(sender).zIndex, 10),
      overlayZIndex: Number.parseInt(getComputedStyle(overlay).zIndex, 10),
      unclippedBlurredChildren: unclippedBlurredChildren.length,
    };
  });
  expect(maskLayering.unclippedBlurredChildren).toBe(0);
  expect(maskLayering.senderZIndex).toBeGreaterThan(maskLayering.overlayZIndex);

  await openConversationMessageSearch(page);
  await page.getByRole("searchbox", { name: "搜索会话和消息" })
    .fill("desktop-layout-review.pdf");
  const searchResult = page.locator('[data-search-message-id="p-3"]');
  await expect(searchResult).toContainText("desktop-layout-review.pdf");
  await searchResult.click();
  const searchTarget = page.locator('[data-message-id="p-3"]');
  await expect(searchTarget.locator(":scope > .message-bubble-shell"))
    .not.toHaveClass(/is-local-block-concealed/);
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).not.toHaveClass(/is-jump-transitioning/);
  await messageList.hover();
  await page.mouse.wheel(0, 100_000);
  await expect.poll(() => messageList.evaluate((element, messageId) => {
    const row = element.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!row) return true;
    const listBounds = element.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    return rowBounds.bottom <= listBounds.top + 1 || rowBounds.top >= listBounds.bottom - 1;
  }, "p-3")).toBe(true);

  const targetRow = await revealVirtualMessage(page, "p-3");
  await expect(targetRow.locator(":scope > .message-bubble-shell"))
    .toHaveClass(/is-local-block-concealed/);
  await targetRow.locator(".local-block-message-reveal").click();
  await expect(targetRow.locator(":scope > .message-bubble-shell"))
    .not.toHaveClass(/is-local-block-concealed/);
  await expect(page.locator(".message-bubble-shell.is-local-block-concealed").first()).toBeVisible();

  const animalAvatar = page.getByRole("button", {
    name: /显示 小熊 的连续消息和真实身份/,
  }).last();
  await animalAvatar.scrollIntoViewIfNeeded();
  const animalAvatarLayout = await animalAvatar.evaluate((button) => {
    const avatar = button.querySelector<HTMLElement>(".avatar")!;
    const label = button.querySelector<HTMLElement>(".avatar > span")!;
    const avatarBounds = avatar.getBoundingClientRect();
    const labelBounds = label.getBoundingClientRect();
    const labelStyle = getComputedStyle(label);
    const avatarStyle = getComputedStyle(avatar);
    return {
      fontSize: Number.parseFloat(labelStyle.fontSize),
      horizontalCenterDelta: (labelBounds.left + labelBounds.width / 2)
        - (avatarBounds.left + avatarBounds.width / 2),
      translateY: new DOMMatrix(labelStyle.transform).m42,
      backgroundColor: avatarStyle.backgroundColor,
    };
  });
  expect(animalAvatarLayout.fontSize).toBeGreaterThanOrEqual(24);
  expect(Math.abs(animalAvatarLayout.horizontalCenterDelta)).toBeLessThan(0.1);
  expect(animalAvatarLayout.translateY).toBe(-3);
  expect(animalAvatarLayout.backgroundColor).toBe("rgb(255, 255, 255)");
  const groupId = await animalAvatar
    .locator("xpath=ancestor::*[contains(@class, 'message-group')]")
    .locator("[data-local-block-group]")
    .first()
    .getAttribute("data-local-block-group");
  expect(groupId).toBeTruthy();
  await animalAvatar.click();
  await expect(page.locator(`[data-local-block-group="${groupId}"]`)
    .locator(".message-bubble-shell.is-local-block-concealed"))
    .toHaveCount(0);

  await page.getByRole("button", { name: "查看 Mia Chen 资料" }).last().click();
  await expect(page.getByRole("dialog", { name: "资料" })).toBeVisible();
  await page.getByRole("button", { name: "关闭资料" }).click();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /诊断与隐私/ }).click();
  const localBlockSection = settings.locator(".settings-section", { hasText: "屏蔽管理" });
  await expect(localBlockSection.getByText("Mia Chen", { exact: true })).toBeVisible();
  await expect(localBlockSection.getByText(/群聊中显示为 小熊/)).toBeVisible();
  await localBlockSection.getByRole("button", { name: "解除屏蔽" }).click();
  await expect(localBlockSection.getByText("暂无屏蔽用户", { exact: true })).toBeVisible();
});
