import { expect, test, type Page } from "@playwright/test";
import type { ComposerInputElement } from "../../src/components/ComposerInput";
import { scrollAwayFromBottom } from "./helpers";

const composer = (page: Page) => page.locator(".conversation > .composer-wrap .composer-input");
const search = (page: Page) => page.getByRole("searchbox", { name: "搜索会话和消息" });
const emoji = (page: Page) => page.getByRole("button", { name: "表情", exact: true });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(composer(page)).toBeFocused();
});

const draftWithSelection = async (page: Page) => {
  await composer(page).fill("abcdef");
  await composer(page).evaluate(element => (element as ComposerInputElement).setSelectionRange(2, 4));
};

const continueTyping = async (page: Page, expected = "abXYef") => {
  await expect(composer(page)).toBeFocused({ timeout: 1_500 });
  await page.keyboard.type("XY");
  await expect(composer(page)).toHaveJSProperty("value", expected);
};

const useLoadedReplyTarget = async (page: Page) => {
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message =>
      message.id === "p-channel-reply" && message.replyTo?.kind === "message"
        ? { ...message, replyTo: { ...message.replyTo, messageId: "p-4" } } : message));
    telegramStore.setState({ messages });
  });
};

for (const action of ["latest", "return", "pinned", "reply", "attention"] as const) {
  test(`conversation ${action} action restores typing and the editor selection`, async ({ page }) => {
    if (action === "latest") await scrollAwayFromBottom(page);
    if (action === "attention") {
      await page.getByRole("log", { name: "消息列表" }).hover();
      await page.mouse.wheel(0, -1800);
      await expect(page.locator('[data-message-id="p-4"]')).not.toBeInViewport();
    }
    if (action === "return") {
      await page.locator('[data-message-id="p-channel-reply"] .message-reply-preview').click();
      await expect(page.locator(".jump-to-latest")).toHaveAccessibleName(/返回跳转前位置/);
      await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");
    }
    if (action === "reply") await useLoadedReplyTarget(page);
    if (action === "attention") {
      await page.evaluate(async () => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        const state = telegramStore.getState();
        const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
        unreadAttentionMessageIds.set("chat-product", ["p-4"]);
        const messages = new Map(state.messages);
        messages.set("chat-product", messages.get("chat-product")!.map(message =>
          message.id === "p-4" ? { ...message, containsUnreadMention: true } : message));
        telegramStore.setState({ messages, unreadAttentionMessageIds });
      });
    }
    await draftWithSelection(page);
    const trigger = action === "latest" || action === "return" ? page.locator(".jump-to-latest")
      : action === "pinned" ? page.locator(".pinned-message-preview")
      : action === "reply" ? page.locator('[data-message-id="p-channel-reply"] .message-reply-preview')
      : page.locator(".jump-to-attention");
    await trigger.click();
    if (action === "latest") await expect(trigger).toHaveCount(0);
    if (action === "return") await expect(trigger).not.toHaveAccessibleName(/返回跳转前位置/);
    if (action === "pinned" || action === "reply" || action === "attention") {
      await expect(page.locator('[data-highlight-message-id="p-4"]')).toHaveCount(1);
    }
    await continueTyping(page);
  });
}

for (const close of ["toggle", "escape", "leave", "search-escape", "search-leave", "tab-leave", "close-button"] as const) {
  test(`emoji ${close} dismissal restores typing and selection`, async ({ page }) => {
    await draftWithSelection(page);
    await emoji(page).click();
    await expect(page.locator(".emoji-picker")).toBeVisible();
    if (close.startsWith("search-")) await page.getByRole("searchbox", { name: "搜索贴纸", exact: true }).fill("cat");
    if (close === "tab-leave") await page.getByRole("tab", { name: "Emoji", exact: true }).click();
    if (close === "toggle") await emoji(page).click();
    else if (close.endsWith("escape")) await page.keyboard.press("Escape");
    else if (close === "close-button") await page.getByRole("button", { name: "关闭表情面板" }).click();
    await page.mouse.move(200, 100);
    await expect(page.locator(".emoji-picker")).toHaveCount(0);
    await continueTyping(page);
  });
}

for (const close of ["button", "escape"] as const) {
  test(`cancelling message selection by ${close} restores the mounted composer`, async ({ page }) => {
    await composer(page).fill("draft");
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "多选", exact: true }).click();
    await expect(composer(page)).toHaveCount(0);
    if (close === "button") await page.getByRole("button", { name: "取消选择", exact: true }).click();
    else await page.keyboard.press("Escape");
    await continueTyping(page, "draftXY");
  });
}

test("channel silent sending keeps typing at the existing selection", async ({ page }) => {
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { deriveChatManagementCapabilities, DEFAULT_CHAT_ADMIN_RIGHTS } = await import("/src/telegram/chatManagement.ts" as string) as typeof import("../../src/telegram/chatManagement");
    const chats = new Map(telegramStore.getState().chats);
    chats.set("chat-release", { ...chats.get("chat-release")!, management: deriveChatManagementCapabilities("channel", "owner", { ...DEFAULT_CHAT_ADMIN_RIGHTS, canPostMessages: true }) });
    telegramStore.setState({ chats, loadChatManagement: async () => undefined });
  });
  await draftWithSelection(page);
  const toggle = page.getByRole("button", { name: "静默发送", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await continueTyping(page);
});

for (const action of ["outside-click", "hover", "pending-close"] as const) {
  test(`emoji ${action} preserves a newer sidebar search`, async ({ page }) => {
    await draftWithSelection(page);
    if (action === "hover") {
      await search(page).fill("Mia");
      await emoji(page).hover();
    } else await emoji(page).click();
    await expect(page.locator(".emoji-picker")).toBeVisible();
    if (action === "pending-close") await page.mouse.move(200, 100);
    if (action !== "hover") await search(page).fill("Mia");
    await page.mouse.move(200, 100);
    await expect(page.locator(".emoji-picker")).toHaveCount(0);
    await expect(search(page)).toBeFocused();
    await page.keyboard.type(" Chen");
    await expect(search(page)).toHaveValue("Mia Chen");
    await expect(composer(page)).toHaveJSProperty("value", "abcdef");
  });
}

test("a queued navigation focus return yields to newer input in the same event turn", async ({ page }) => {
  await draftWithSelection(page);
  const field = await search(page).elementHandle();
  await page.locator(".pinned-message-preview").evaluate((button, searchField) => {
    (button as HTMLButtonElement).click();
    searchField!.focus();
  }, field);
  await expect(page.locator('[data-highlight-message-id="p-4"]')).toHaveCount(1);
  await page.keyboard.type("Mia");
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue("Mia");
  await expect(composer(page)).toHaveJSProperty("value", "abcdef");
});

test("an emoji hover close cannot restore focus into the previous conversation", async ({ page }) => {
  await composer(page).fill("original draft");
  await emoji(page).click();
  await page.getByRole("searchbox", { name: "搜索贴纸", exact: true }).fill("cat");
  await page.mouse.move(200, 100);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await search(page).fill("new destination");
  await expect(page.locator(".emoji-picker")).toHaveCount(0);
  await expect(search(page)).toBeFocused();
  await page.keyboard.type(" stays");
  await expect(search(page)).toHaveValue("new destination stays");
  await expect(composer(page)).toHaveJSProperty("value", "");
});
