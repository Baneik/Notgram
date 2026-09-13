import { expect, test, type Page } from "@playwright/test";
import type { MockTelegramTransport } from "../../src/telegram/mockTransport";

declare global {
  interface Window { __chatActionsTransport: MockTelegramTransport }
}

const prepare = async (page: Page) => {
  await page.route("**/src/telegram/createTransport.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      "return new MockTelegramTransport(", "return window.__chatActionsTransport = new MockTelegramTransport(",
    ) });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};
const row = (page: Page, id: string) => page.locator(`.chat-list[data-active=true] .chat-row[data-chat-id="${id}"]`);
const openMenu = async (page: Page, id: string, title: string) => {
  await row(page, id).click({ button: "right" });
  const menu = page.getByRole("menu", { name: `会话操作：${title}`, exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  return menu;
};

test("chat list menu matches each chat kind and toggles mute without opening the conversation", async ({ page }) => {
  await prepare(page);
  const cases = [
    ["chat-saved", "收藏夹", ["置顶", "分组"]],
    ["chat-mia", "Mia Chen", ["取消置顶", "分组", "静音", "删除"]],
    ["chat-product", "产品讨论", ["取消置顶", "分组", "静音", "退出群组"]],
    ["chat-release", "Release Notes", ["置顶", "分组", "取消静音", "退出频道"]],
  ] as const;
  for (const [id, title, items] of cases) {
    const menu = await openMenu(page, id, title);
    await expect(menu.getByRole("menuitem")).toHaveText([...items]);
    await page.keyboard.press("Escape");
  }
  const menu = await openMenu(page, "chat-mia", "Mia Chen");
  await menu.getByRole("menuitem", { name: "静音", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  const muted = await openMenu(page, "chat-mia", "Mia Chen");
  await muted.getByRole("menuitem", { name: "取消静音", exact: true }).click();
  await expect((await openMenu(page, "chat-mia", "Mia Chen")).getByRole("menuitem", { name: "静音", exact: true })).toBeEnabled();
});

test("private chat deletion supports cancel, visible failure, and retry", async ({ page }) => {
  await prepare(page);
  await row(page, "chat-mia").click();
  await (await openMenu(page, "chat-mia", "Mia Chen")).getByRole("menuitem", { name: "删除", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除“Mia Chen”？" });
  await expect(dialog).toContainText("对方的聊天记录不受影响");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row(page, "chat-mia")).toBeVisible();
  await page.evaluate(() => {
    const original = window.__chatActionsTransport.deletePrivateChat.bind(window.__chatActionsTransport);
    let fail = true;
    window.__chatActionsTransport.deletePrivateChat = async id => {
      if (fail) { fail = false; throw new Error("CHAT_DELETE_FAILED"); }
      return original(id);
    };
  });
  await (await openMenu(page, "chat-mia", "Mia Chen")).getByRole("menuitem", { name: "删除", exact: true }).click();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("CHAT_DELETE_FAILED");
  await expect(row(page, "chat-mia")).toBeVisible();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "chat-mia")).toHaveCount(0);
  await expect(page.locator(".conversation-title strong")).not.toHaveText("Mia Chen");
});

test("bot menu stops notifications through the Telegram blacklist and keeps history until deletion", async ({ page }) => {
  await prepare(page);
  const botId = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return (await telegramStore.getState().startPrivateChat("u-notgram-bot"))!;
  });
  let menu = await openMenu(page, botId, "Notgram Bot");
  await expect(menu.getByRole("menuitem")).toHaveText(["置顶", "分组", "静音", "停用", "删除"]);
  await menu.getByRole("menuitem", { name: "停用", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "停用“Notgram Bot”？" });
  await expect(dialog).toContainText("已有聊天记录会保留");
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await expect(dialog).toBeHidden();
  menu = await openMenu(page, botId, "Notgram Bot");
  await expect(menu.getByRole("menuitem", { name: "已停用" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.evaluate(() => window.__chatActionsTransport.setMessageSenderBlocked("u-notgram-bot", "user", false));
  menu = await openMenu(page, botId, "Notgram Bot");
  await expect(menu.getByRole("menuitem", { name: "停用", exact: true })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "删除“Notgram Bot”？" }).getByRole("button", { name: "删除", exact: true }).click();
  await expect(row(page, botId)).toHaveCount(0);
});

test("channel exit uses channel confirmation text and removes the mock subscription", async ({ page }) => {
  await prepare(page);
  await (await openMenu(page, "chat-release", "Release Notes")).getByRole("menuitem", { name: "退出频道" }).click();
  const dialog = page.getByRole("dialog", { name: "退出“Release Notes”？" });
  await expect(dialog).toContainText("不再接收此频道的新消息");
  await dialog.getByRole("button", { name: "退出频道" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "chat-release")).toHaveCount(0);
});

test("unavailable deletion and left membership stay disabled, including keyboard navigation", async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const chats = new Map(telegramStore.getState().chats);
    chats.set("chat-mia", { ...chats.get("chat-mia")!, canDeleteForSelf: false });
    chats.set("chat-release", { ...chats.get("chat-release")!, isMember: false });
    telegramStore.setState({ chats });
  });
  await row(page, "chat-mia").focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "会话操作：Mia Chen" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toBeDisabled();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "静音", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row(page, "chat-mia")).toBeFocused();
  const channel = await openMenu(page, "chat-release", "Release Notes");
  await expect(channel.getByRole("menuitem", { name: "退出频道" })).toBeDisabled();
});

test("bot menu stays within a narrow viewport and exposes its folder submenu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await prepare(page);
  const botId = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return (await telegramStore.getState().startPrivateChat("u-notgram-bot"))!;
  });
  const menu = await openMenu(page, botId, "Notgram Bot");
  await menu.getByRole("menuitem", { name: "分组", exact: true }).click();
  const folders = page.getByRole("menu", { name: "选择分组", exact: true });
  await expect(folders).toBeVisible();
  const primaryBounds = (await menu.locator("[data-context-menu-primary]").boundingBox())!;
  const folderBounds = (await folders.boundingBox())!;
  expect(folderBounds.y + folderBounds.height <= primaryBounds.y ||
    folderBounds.y >= primaryBounds.y + primaryBounds.height).toBe(true);
  for (const panel of [menu.locator("[data-context-menu-primary]"), folders]) {
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(520);
  }
  await page.screenshot({ path: test.info().outputPath("narrow-bot-menu.png") });
  await folders.getByRole("menuitemcheckbox", { name: "添加到工作" }).click();
  await expect(menu).toBeHidden();
});
