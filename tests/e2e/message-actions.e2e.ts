import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { horizontalOverflow, messageListMetrics, scrollAwayFromBottom, revealVirtualMessage, chooseMessageMenuItem } from "./helpers";

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
  await expect(actionMenu.getByRole("menuitem").first()).toBeFocused();
  await expect(actionMenu).toHaveAttribute("data-keyboard-navigation", "true");
  await expect(actionMenu.getByRole("menuitem").first())
    .not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
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
  const forwardDialog = page.getByRole("dialog", { name: /转发 1 条消息/ });
  await expect(forwardDialog.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(forwardDialog.locator(".forward-target-row").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await forwardDialog.getByRole("button", { name: "转发", exact: true }).click();
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

test("forwarding ranks quick targets and sends to multiple chats with a description", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:conversation-activity:v1", JSON.stringify([
      {
        accountId: "default",
        chatId: "chat-product",
        sentMessageCount: 20,
        activeDurationMs: 600_000,
        updatedAt: "2026-08-22T10:00:00Z",
      },
      {
        accountId: "default",
        chatId: "chat-mia",
        sentMessageCount: 1,
        activeDurationMs: 1_000,
        updatedAt: "2026-08-22T10:00:00Z",
      },
    ]));
  });
  await page.goto("/");

  const source = await revealVirtualMessage(page, "p-2");
  await source.locator(".message-bubble-shell").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "消息操作" });
  const forwardItem = menu.getByRole("menuitem", { name: "转发", exact: true });
  const forwardChevron = forwardItem.locator(".lucide-chevron-right");
  await expect(forwardChevron).toBeVisible();
  const trailingInset = await forwardItem.evaluate((element) => {
    const itemBounds = element.getBoundingClientRect();
    const chevronBounds = element.querySelector(".lucide-chevron-right")!.getBoundingClientRect();
    return itemBounds.right - chevronBounds.right;
  });
  expect(trailingInset).toBeCloseTo(9, 1);
  expect((await menu.boundingBox())?.width).toBe(160);
  await forwardItem.hover();
  const quickForward = page.getByRole("menu", { name: "快速转发" });
  await expect(quickForward.getByRole("menuitem").first()).toHaveText("收藏夹");
  await expect(quickForward.getByRole("menuitem").nth(1)).toContainText("产品讨论");
  await expect(quickForward.getByRole("menuitem").first().locator(".avatar-icon")).toBeVisible();
  await expect(quickForward.getByRole("menuitem").first().locator(".avatar")).toBeVisible();
  expect(await quickForward.evaluate((element) => {
    const style = getComputedStyle(element);
    return { overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth };
  })).toEqual({ overflowY: "auto", scrollbarWidth: "none" });
  await page.mouse.move(8, 8);
  await expect(quickForward).toBeHidden();

  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "转发");
  const dialog = page.getByRole("dialog", { name: "转发 1 条消息" });
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  await expect(dialog.getByText("描述", { exact: true })).toHaveCount(0);
  const forwardButton = dialog.getByRole("button", { name: "转发", exact: true });
  await expect(forwardButton).not.toHaveClass(/is-ready/);
  await expect(dialog.getByRole("textbox", { name: "转发附言" }))
    .toHaveAttribute("placeholder", "附带一条消息（可选）");
  await dialog.locator(".forward-target-row").filter({ hasText: "Mia Chen" }).click();
  await dialog.locator(".forward-target-row").filter({ hasText: "产品讨论" }).click();
  await expect(forwardButton).toHaveClass(/is-ready/);
  await dialog.getByLabel("转发附言").fill("请一起查看这条更新");
  await dialog.getByRole("button", { name: "转发", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> } };
    };
    const messages = module.telegramStore.getState().messages;
    return ["chat-mia", "chat-product"].map((chatId) => ({
      forwarded: messages.get(chatId)?.some((message) =>
        message.outgoing && message.forwardInfo?.source?.messageId === "p-2"
      ),
      described: messages.get(chatId)?.some((message) =>
        message.outgoing && message.content.kind === "text" &&
        message.content.text === "请一起查看这条更新"
      ),
    }));
  }, "/src/store/telegramStore.ts")).toEqual([
    { forwarded: true, described: true },
    { forwarded: true, described: true },
  ]);
});

test("conversation multi-select uses full message rows and album forwarding uses the whole group", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menu", { name: "会话操作" })
    .getByRole("menuitem", { name: "多选", exact: true }).click();
  await expect(page.getByText("已选择 0 条", { exact: true })).toBeVisible();
  await expect(page.locator(".message-selection-toggle")).toHaveCount(0);
  expect(await page.getByRole("toolbar", { name: "消息选择操作" }).evaluate(
    (element) => element.getBoundingClientRect().height,
  )).toBe(50);

  const first = await revealVirtualMessage(page, "p-2");
  await first.click({ position: { x: 4, y: Math.max(2, Math.floor((await first.boundingBox())!.height / 2)) } });
  await expect(first).toHaveClass(/is-selected/);
  expect(await first.evaluate((element) => getComputedStyle(element, "::after").backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => first.evaluate((element) => {
    const list = element.closest(".message-list");
    const overlay = getComputedStyle(element, "::after");
    if (!list) return false;
    const row = element.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    return Math.abs(row.left + Number.parseFloat(overlay.left) - bounds.left) < 1 &&
      row.right - Number.parseFloat(overlay.right) >= bounds.right - 1 &&
      overlay.borderTopWidth === "0px";
  })).toBe(true);
  const adjacent = await revealVirtualMessage(page, "p-3");
  await adjacent.click({ position: { x: 4, y: Math.max(2, Math.floor((await adjacent.boundingBox())!.height / 2)) } });
  await expect(adjacent).toHaveClass(/joins-selection-before/);
  const selectionOverlays = await Promise.all([first, adjacent].map((row) => row.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overlay = getComputedStyle(element, "::after");
    return {
      top: bounds.top + Number.parseFloat(overlay.top),
      bottom: bounds.bottom - Number.parseFloat(overlay.bottom),
    };
  })));
  expect(Math.abs(selectionOverlays[0].bottom - selectionOverlays[1].top)).toBeLessThanOrEqual(0.5);
  await adjacent.click({ position: { x: 4, y: Math.max(2, Math.floor((await adjacent.boundingBox())!.height / 2)) } });
  const second = await revealVirtualMessage(page, "p-4");
  await second.click({ position: { x: 4, y: Math.max(2, Math.floor((await second.boundingBox())!.height / 2)) } });
  await expect(page.getByText("已选择 2 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "转发已选消息" }).click();
  await expect(page.getByRole("dialog", { name: "转发 2 条消息" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "取消选择", exact: true }).click();

  const albumItem = await revealVirtualMessage(page, "p-tall");
  await albumItem.locator(".message-bubble-shell").click({ button: "right" });
  const albumMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(albumMenu.getByRole("menuitem", { name: "合并转发", exact: true })).toHaveCount(0);
  await albumMenu.getByRole("menuitem", { name: "转发", exact: true }).click();
  const albumDialog = page.getByRole("dialog", { name: "转发 2 条消息" });
  await albumDialog.locator(".forward-target-row").filter({ hasText: "Mia Chen" }).click();
  await albumDialog.getByRole("button", { name: "转发", exact: true }).click();
  await expect(albumDialog).toBeHidden();

  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> } };
    };
    return module.telegramStore.getState().messages.get("chat-mia")
      ?.filter((message) => message.outgoing &&
        ["p-tall", "p-5"].includes(message.forwardInfo?.source?.messageId ?? ""))
      .map((message) => message.forwardInfo?.source?.messageId)
      .sort();
  }, "/src/store/telegramStore.ts")).toEqual(["p-5", "p-tall"]);
});

test("message reactions stay in the bubble and reveal the reacting users", async ({ page }) => {
  await page.goto("/?reactionPreview=1");

  const message = await revealVirtualMessage(page, "p-4");
  const bubble = message.locator(".message-bubble");
  const reactions = bubble.getByRole("group", { name: "消息回应" });
  await expect(reactions).toBeVisible();
  await expect(reactions.locator(":scope > button")).toHaveCount(2);
  await expect(reactions.locator(".message-reaction-avatars .avatar")).toHaveCount(5);
  const footer = bubble.locator(":scope > .message-reaction-footer");
  expect(await footer.evaluate((element) => element.parentElement?.classList.contains("message-bubble")))
    .toBe(true);
  await expect(bubble.locator(".message-text-flow .message-meta")).toHaveCount(0);
  await expect(footer.locator(":scope > .message-meta")).toHaveCount(1);
  const layout = await Promise.all([
    bubble.boundingBox(),
    reactions.boundingBox(),
    reactions.locator(":scope > button").first().boundingBox(),
    footer.locator(":scope > .message-meta").boundingBox(),
  ]);
  expect(layout[0]).not.toBeNull();
  expect(layout[1]).not.toBeNull();
  expect(layout[2]).not.toBeNull();
  expect(layout[3]).not.toBeNull();
  expect(layout[1]!.x).toBeGreaterThanOrEqual(layout[0]!.x);
  expect(layout[1]!.x + layout[1]!.width).toBeLessThanOrEqual(layout[0]!.x + layout[0]!.width + 1);
  expect(Math.abs(layout[2]!.y + layout[2]!.height / 2 - (layout[3]!.y + layout[3]!.height / 2)))
    .toBeLessThanOrEqual(3);
  const reactionStyle = await footer.evaluate((element) => ({
    borderTopStyle: getComputedStyle(element).borderTopStyle,
    emojiSize: getComputedStyle(element.querySelector(".message-reaction-emoji")!).fontSize,
  }));
  expect(reactionStyle.borderTopStyle).toBe("none");
  expect(Number.parseFloat(reactionStyle.emojiSize)).toBeLessThanOrEqual(14);

  const thumbsUp = reactions.getByRole("button", { name: /👍，3 个回应/ });
  await thumbsUp.click({ button: "right" });
  const details = page.getByRole("menu", { name: "👍 的回应者" });
  await expect(details).toBeVisible();
  await expect(details.getByRole("menuitem", { name: "林然", exact: true })).toBeVisible();
  await expect(details.getByRole("menuitem", { name: "Mia Chen", exact: true })).toBeVisible();
  await expect(details.getByRole("menuitem", { name: "陈默", exact: true })).toBeVisible();
  await expect(details.locator(".reaction-details-user .avatar")).toHaveCount(3);
  await expect(details.getByText("正在读取回应者", { exact: true })).toHaveCount(0);
  await expect(details.locator(".reaction-details-header")).toHaveCount(0);
  await expect(details.locator(".reaction-details-user-emoji")).toHaveCount(0);
  const detailsBox = await details.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox!.width).toBeLessThan(214);

  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(thumbsUp).toBeFocused();

  await thumbsUp.click();
  const updatedThumbsUp = reactions.getByRole("button", { name: /👍，2 个回应/ });
  await expect(updatedThumbsUp).toHaveAttribute("aria-pressed", "false");
  await expect(updatedThumbsUp.locator(".message-reaction-avatars .avatar")).toHaveCount(2);

  const outgoingMessage = await revealVirtualMessage(page, "p-2");
  await expect(outgoingMessage).toHaveClass(/is-outgoing/);
  const outgoingBubble = outgoingMessage.locator(".message-bubble");
  const outgoingReaction = outgoingBubble.locator(".message-reactions > button").first();
  const outgoingLayout = await Promise.all([outgoingBubble.boundingBox(), outgoingReaction.boundingBox()]);
  expect(outgoingLayout[0]).not.toBeNull();
  expect(outgoingLayout[1]).not.toBeNull();
  expect(outgoingLayout[1]!.x - outgoingLayout[0]!.x).toBeLessThanOrEqual(11);

  await page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (state: { messages: Map<string, Message[]> }) => void;
      };
    };
    const messages = new Map(module.telegramStore.getState().messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) => message.id === "p-5"
      ? {
          ...message,
          interaction: {
            viewCount: 0,
            forwardCount: 0,
            replyCount: 0,
            canGetAddedReactions: true,
            reactions: [{
              type: { kind: "emoji" as const, emoji: "🔥" },
              totalCount: 2,
              chosen: false,
              recentSenderIds: ["u-mia", "u-jules"],
            }],
          },
        }
      : message));
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  const albumMessage = await revealVirtualMessage(page, "p-5");
  const album = page.locator('[data-media-album-id="mock-album-product"]');
  const albumReactionFooter = albumMessage.locator(".message-reaction-footer");
  await expect(albumReactionFooter.getByRole("group", { name: "消息回应" })).toBeVisible();
  await expect(albumReactionFooter.getByRole("button", { name: /🔥，2 个回应/ })).toBeVisible();
  const albumReactionLayout = await album.evaluate((element) => {
    const grid = element.querySelector<HTMLElement>(".media-album-grid")!;
    const footer = element.querySelector<HTMLElement>('[data-message-id="p-5"] .message-reaction-footer')!;
    const button = footer.querySelector<HTMLElement>(".message-reactions > button")!;
    return {
      albumHeight: element.getBoundingClientRect().height,
      gridHeight: grid.getBoundingClientRect().height,
      footerPosition: getComputedStyle(footer).position,
      footerBackground: getComputedStyle(footer).backgroundColor,
      footerPointerEvents: getComputedStyle(footer).pointerEvents,
      buttonPointerEvents: getComputedStyle(button).pointerEvents,
    };
  });
  expect(albumReactionLayout.albumHeight).toBeCloseTo(albumReactionLayout.gridHeight, 0);
  expect(albumReactionLayout).toMatchObject({
    footerPosition: "absolute",
    footerBackground: "rgba(0, 0, 0, 0)",
    footerPointerEvents: "none",
    buttonPointerEvents: "auto",
  });
});

test("middle-clicking forward repeats an incoming message directly to the current group only", async ({ page }) => {
  await page.goto("/");

  const incoming = await revealVirtualMessage(page, "p-4");
  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  let menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(menu.getByRole("menuitem", { name: "复读", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "转发", exact: true }).click({ button: "middle" });

  await expect(menu).toBeHidden();
  await expect(page.getByRole("dialog", { name: /转发 \d+ 条消息/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> } };
    };
    return module.telegramStore.getState().messages.get("chat-product")
      ?.filter((message) => message.outgoing && message.forwardInfo?.source?.messageId === "p-4")
      .map((message) => ({ chatId: message.chatId, text: message.content.kind === "text" ? message.content.text : "" }));
  }, "/src/store/telegramStore.ts")).toEqual([{
    chatId: "chat-product",
    text: "我把交互稿更新到最新版本了，下午可以直接走查。",
  }]);

  const outgoing = await revealVirtualMessage(page, "p-2");
  await outgoing.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "复读", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  const directIncoming = await revealVirtualMessage(page, "m-3");
  await directIncoming.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "复读", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  const forumIncoming = await revealVirtualMessage(page, "forum-general-1");
  await forumIncoming.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await menu.getByRole("menuitem", { name: "转发", exact: true }).click({ button: "middle" });
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> } };
    };
    return module.telegramStore.getState().messages.get("chat-forum")
      ?.find((message) => message.outgoing && message.forwardInfo?.source?.messageId === "forum-general-1")
      ?.topicId;
  }, "/src/store/telegramStore.ts")).toBe("1");
});

test("message deletion keeps safety actions separate and exposes only allowed scopes", async ({ page }) => {
  await page.goto("/");

  const incoming = await revealVirtualMessage(page, "p-4");
  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  let menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "举报" })).toBeVisible();
  const initialLabels = (await menu.getByRole("menuitem").allTextContents()).map((label) => label.trim());
  expect(initialLabels.slice(-2)).toEqual(["删除", "举报"]);
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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
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

test("conversation multi-select copies a readable transcript and drag-scrolls at the list edge", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboardState = { text: "" };
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => { clipboardState.text = text; } },
    });
    Object.assign(globalThis, { __notgramSelectionClipboard: clipboardState });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menu", { name: "会话操作" })
    .getByRole("menuitem", { name: "多选", exact: true }).click();

  const first = await revealVirtualMessage(page, "p-2");
  await first.click({ position: { x: 4, y: Math.max(2, Math.floor((await first.boundingBox())!.height / 2)) } });
  await page.getByRole("button", { name: "复制已选消息" }).click();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramSelectionClipboard: { text: string } }
  ).__notgramSelectionClipboard.text)).toMatch(/\[\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}\].*:\s+看到了。消息区再留一点呼吸感，信息密度就比较平衡。/);
  await expect(page.getByRole("toolbar", { name: "消息选择操作" })).toHaveCount(0);

  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menu", { name: "会话操作" })
    .getByRole("menuitem", { name: "多选", exact: true }).click();
  const shortcutMessage = await revealVirtualMessage(page, "p-2");
  await shortcutMessage.click({ position: { x: 4, y: Math.max(2, Math.floor((await shortcutMessage.boundingBox())!.height / 2)) } });
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramSelectionClipboard: { text: string } }
  ).__notgramSelectionClipboard.text)).toContain("看到了。消息区再留一点呼吸感，信息密度就比较平衡。");
  await expect(page.getByRole("toolbar", { name: "消息选择操作" })).toHaveCount(0);

  const list = page.getByRole("log", { name: "消息列表" });
  await scrollAwayFromBottom(page);
  const startId = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>(".message-row:not(.is-service)")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return rowBounds.top >= bounds.top + 4 && rowBounds.bottom <= bounds.bottom - 4;
      })?.dataset.messageId;
  });
  expect(startId).toBeTruthy();
  const start = page.locator(`[data-message-id="${startId}"]`);
  const startBox = await start.locator(".message-bubble-shell").boundingBox();
  const listBox = await list.boundingBox();
  expect(startBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  const before = await messageListMetrics(page);
  await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(startBox!.x + startBox!.width / 2, listBox!.y + listBox!.height + 16, { steps: 8 });
  await page.waitForTimeout(360);
  await page.mouse.up();
  await expect.poll(async () => (await messageListMetrics(page)).scrollTop).toBeGreaterThan(before.scrollTop);
});

test("selecting message text is not interrupted by composer autofocus", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();

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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();

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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expectSelectionCleared();

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').focus();
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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').focus();
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

test("messages support pin lists, notification scope, and auto-delete settings", async ({ page }) => {
  await page.goto("/");
  const target = await revealVirtualMessage(page, "p-1");
  await target.locator(".message-bubble-shell").click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("menuitem", { name: "置顶" })).toBeVisible();
  await messageMenu.getByRole("menuitem", { name: "置顶" }).click();
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
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
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
  await expect(latestPinnedSource).toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");

  await pinnedPreview.click();
  const middlePinnedSource = page.locator('[data-message-id="p-1"]');
  await expect(middlePinnedSource).toBeVisible();
  await expect(middlePinnedSource).toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("产品讨论历史消息 1");

  await pinnedPreview.click();
  const earliestPinnedSource = page.locator('[data-message-id="p-old-1"]');
  await expect(earliestPinnedSource).toBeVisible();
  await expect(earliestPinnedSource).toHaveClass(/is-notification-target/);
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
  await expect(earliestPinnedSource).toHaveClass(/is-notification-target/);
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
