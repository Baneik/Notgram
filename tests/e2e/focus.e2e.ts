import { expect, test, type Page } from "@playwright/test";
import type { telegramStore as Store } from "../../src/store/telegramStore";

type FocusControl = Window & { releaseFocusSend?: () => void; focusSendStarted?: boolean; focusSendFinished?: boolean };
const composer = (page: Page) => page.locator(".conversation > .composer-wrap .composer-input");
const search = (page: Page) => page.getByRole("searchbox", { name: "搜索会话和消息" });
const openReady = async (page: Page) => {
  await page.goto("/");
  await expect(composer(page)).toBeFocused();
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");
};

test("replying from a message context menu returns typing to the composer", async ({ page }) => {
  await openReady(page);
  await page.locator('[data-message-id="p-4"] .message-bubble-shell').click({ button: "right" });
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  await expect(menu.getByRole("menuitem", { name: "复制", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "回复", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("typing after menu");
  await expect(composer(page)).toHaveJSProperty("value", "typing after menu");
});

for (const media of ["photo", "video"] as const) {
  test(`closing a conversation ${media} window restores typing`, async ({ page }) => {
    await openReady(page);
    const trigger = media === "photo" ? page.locator(".message-list .photo-open").first()
      : page.locator('[data-message-id="p-video"] .video-player');
    await trigger.scrollIntoViewIfNeeded();
    const opened = page.waitForEvent("popup");
    if (media === "photo") await trigger.click();
    else await trigger.dblclick();
    const popup = await opened;
    await expect(popup.locator(media === "photo" ? ".media-viewer" : ".video-window")).toBeVisible();
    const closed = popup.waitForEvent("close");
    await popup.keyboard.down("Escape");
    await closed;
    await page.bringToFront();
    await expect(composer(page)).toBeFocused();
    await page.keyboard.type("typing after media");
    await expect(composer(page)).toHaveJSProperty("value", "typing after media");
  });
}

for (const order of ["closed-first", "activation-first"] as const) {
  test(`external focus return survives the opener's activation focusin (${order})`, async ({ page }) => {
    await openReady(page);
    await page.locator(".message-list .photo-open").first().focus();
    await page.evaluate(async order => {
      const { captureActiveComposerFocus } = await import("/src/hooks/useComposerFocus.ts" as string) as typeof import("../../src/hooks/useComposerFocus");
      const restore = captureActiveComposerFocus(true);
      const opener = document.activeElement!;
      let focused = false;
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
      window.dispatchEvent(new Event("blur"));
      const activate = () => {
        focused = true;
        window.dispatchEvent(new Event("focus"));
        // Model activation re-emitting focusin for the unchanged opener.
        opener.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: null }));
      };
      if (order === "closed-first") {
        restore();
        await new Promise(resolve => setTimeout(resolve, 0));
        activate();
      } else {
        activate();
        restore();
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      Reflect.deleteProperty(document, "hasFocus");
    }, order);
    await expect(composer(page)).toBeFocused();
    await page.keyboard.type("typing after activation");
    await expect(composer(page)).toHaveJSProperty("value", "typing after activation");
  });
}

for (const navigation of ["search", "switch"] as const) {
  test(`a conversation video close preserves a newer ${navigation} operation`, async ({ page }) => {
    await openReady(page);
    const player = page.locator('[data-message-id="p-video"] .video-player');
    await player.scrollIntoViewIfNeeded();
    const opened = page.waitForEvent("popup");
    await player.dblclick();
    const popup = await opened;
    await expect(popup.locator(".video-window")).toBeVisible();
    if (navigation === "switch") {
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
      await expect(page.locator(".conversation-header")).toContainText("Mia Chen");
    }
    await search(page).fill("Mia");
    if (!popup.isClosed()) {
      const closed = popup.waitForEvent("close");
      await popup.keyboard.down("Escape");
      await closed;
    }
    await page.bringToFront();
    await expect(search(page)).toBeFocused();
    await page.keyboard.type(" Chen");
    await expect(search(page)).toHaveValue("Mia Chen");
    await expect(composer(page)).toHaveJSProperty("value", "");
  });
}

const deferSendCompletion = async (page: Page) => {
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
    const original = telegramStore.getState().sendMessage;
    const control = window as FocusControl;
    const gate = new Promise<void>(resolve => { control.releaseFocusSend = resolve; });
    telegramStore.setState({ sendMessage: async (...args) => {
      const sent = await original(...args);
      control.focusSendStarted = true;
      await gate;
      control.focusSendFinished = true;
      return sent;
    } });
  });
  await composer(page).fill("delayed focus regression");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as FocusControl).focusSendStarted);
};

const releaseSend = async (page: Page) => {
  await page.evaluate(() => (window as FocusControl).releaseFocusSend?.());
  await page.waitForFunction(() => (window as FocusControl).focusSendFinished);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

test("a channel owner's comment click and Enter stay in the discussion", async ({ page }) => {
  await openReady(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
    const { deriveChatManagementCapabilities, DEFAULT_CHAT_ADMIN_RIGHTS } = await import("/src/telegram/chatManagement.ts" as string) as typeof import("../../src/telegram/chatManagement");
    const chats = new Map(telegramStore.getState().chats);
    chats.set("chat-release", { ...chats.get("chat-release")!, management: deriveChatManagementCapabilities("channel", "owner", { ...DEFAULT_CHAT_ADMIN_RIGHTS, canPostMessages: true }) });
    telegramStore.setState({ chats, loadChatManagement: async () => undefined });
  });
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  const input = panel.locator(".composer-input");
  await expect(input).toBeFocused();
  await expect(composer(page)).toHaveCount(1);
  expect(await composer(page).evaluate(element => Boolean(element.closest("[inert]")))).toBe(true);
  await panel.locator(".channel-discussion-message-group .message-rich-text").first().click();
  await expect(input).toBeFocused();
  await page.keyboard.type("This is a comment, not a channel post");
  await expect(composer(page)).toHaveJSProperty("value", "");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("This is a comment, not a channel post", { exact: true })).toBeVisible();
  const sent = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: typeof Store };
    return [...telegramStore.getState().messages.values()].flat()
      .filter(message => message.content.kind === "text" && message.content.text === "This is a comment, not a channel post")
      .map(message => ({ post: message.isChannelPost === true, reply: message.replyTo?.kind === "message" ? message.replyTo.messageId : undefined }));
  });
  expect(sent).toEqual([{ post: false, reply: "release-post-1" }]);
  await panel.getByRole("button", { name: "返回频道" }).click();
  await expect(panel).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
});

for (const navigation of ["stay", "switch", "return"] as const) {
  test(`a completed send preserves search focus (${navigation})`, async ({ page }) => {
    await openReady(page);
    await deferSendCompletion(page);
    if (navigation !== "stay") {
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
      await expect(page.locator(".conversation-header")).toContainText("Mia Chen");
    }
    if (navigation === "return") {
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
      await expect(page.locator(".conversation-header")).toContainText("产品讨论");
    }
    await search(page).fill("Mia");
    await releaseSend(page);
    await expect(search(page)).toBeFocused();
    await page.keyboard.type(" Chen");
    await expect(search(page)).toHaveValue("Mia Chen");
    await expect(composer(page)).toHaveJSProperty("value", "");
  });
}

test("a pending send and programmatic focus cannot escape a forward dialog", async ({ page }) => {
  await openReady(page);
  await deferSendCompletion(page);
  await page.locator(".message-list .message-bubble-shell").last().click({ button: "right" });
  await page.getByRole("menuitem", { name: "转发", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /转发 1 条消息/ });
  const field = dialog.getByRole("searchbox");
  await expect(field).toBeFocused();
  await composer(page).evaluate(input => input.focus());
  await expect(field).toBeFocused();
  await releaseSend(page);
  await page.keyboard.type("Mia");
  await expect(field).toHaveValue("Mia");
  await expect(composer(page)).toHaveJSProperty("value", "");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await composer(page).evaluate(input => Boolean(input.closest("[inert]")))).toBe(false);
});

test("closing a video preview preserves a newer search operation", async ({ page }) => {
  await openReady(page);
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/public/mock-video.mp4");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "预览 mock-video.mp4" }).click();
  const popup = await popupPromise;
  await expect(popup.locator(".video-window")).toBeVisible();
  await search(page).fill("Mia");
  const closed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await closed;
  await page.bringToFront();
  await expect(search(page)).toBeFocused();
  await page.keyboard.type(" Chen");
  await expect(search(page)).toHaveValue("Mia Chen");
  await expect(composer(page)).toHaveJSProperty("value", "");
});

test("returning to the window restores only unclaimed input focus", async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => { (document.activeElement as HTMLElement).blur(); window.dispatchEvent(new Event("focus")); });
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("ready immediately");
  await expect(composer(page)).toHaveJSProperty("value", "ready immediately");
  await search(page).fill("Mia");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.keyboard.type(" Chen");
  await expect(search(page)).toHaveValue("Mia Chen");
  await expect(composer(page)).toHaveJSProperty("value", "ready immediately");
});

test("window return preserves a message selection and editor caret", async ({ page }) => {
  await openReady(page);
  await composer(page).fill("abcdef");
  await composer(page).evaluate(input => (input as HTMLElement & { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(2, 4));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.keyboard.type("XY");
  await expect(composer(page)).toHaveJSProperty("value", "abXYef");
  await page.locator(".message-list .message-rich-text").last().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    (document.activeElement as HTMLElement).blur();
    window.dispatchEvent(new Event("focus"));
  });
  const selected = await page.evaluate(() => getSelection()?.toString());
  expect(selected).toBeTruthy();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
  await expect(composer(page)).not.toBeFocused();
});

test("closing animation does not restore focus over a newer search", async ({ page }) => {
  await openReady(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await search(page).fill("new operation");
  await expect(dialog).toHaveCount(0);
  await expect(search(page)).toBeFocused();
  await page.keyboard.type(" continues");
  await expect(search(page)).toHaveValue("new operation continues");
});

test("a temporarily hidden parent dialog retains its eventual focus return", async ({ page }) => {
  await openReady(page);
  const trigger = page.getByRole("button", { name: "设置", exact: true });
  await trigger.click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: /Notgram/ }).click();
  const toggle = settings.getByRole("switch", { name: "屏蔽 Zalgo 文本" });
  await toggle.click();
  const confirmation = page.getByRole("dialog", { name: "关闭 Zalgo 文本屏蔽？" });
  await expect(confirmation).toBeVisible();
  await composer(page).evaluate(input => input.focus());
  expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await composer(page).evaluate(input => Boolean(input.closest("[inert]")))).toBe(false);
});

test("beginning an account switch closes the photo viewer before file IDs can be reused", async ({ page }) => {
  await openReady(page);
  const opened = page.waitForEvent("popup");
  await page.locator(".message-list .photo-open").first().click();
  const popup = await opened;
  await expect(popup.locator(".media-viewer")).toBeVisible();
  const closed = popup.waitForEvent("close");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ accountSwitching: true });
  });
  await closed;
  expect(popup.isClosed()).toBe(true);
});
