import { expect, test, type Page } from "@playwright/test";
import { horizontalOverflow } from "./helpers";

async function prepare(page: Page, request = false) {
  await page.route("**/src/telegram/mockData.ts*", async route => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: `${body}\nfor (const [id,title] of [["chat-product","public_group"],["chat-release","public_channel"]]) {
      const chat = mockSnapshot.chats.find(chat=>chat.id===id);
      Object.assign(chat, {title, isMember:false, joinByRequest:${request}, folderIds:[], pinned:false, pinnedFolderIds:[], listOrderByFolder:{}, management:undefined});
    }` });
  });
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
}

async function openLink(page: Page, url: string) {
  await page.evaluate(async url => {
    const { openTelegramLinkInApp } = await (0, eval)('import("/src/utils/externalLinks.ts")') as typeof import("../../src/utils/externalLinks");
    await openTelegramLinkInApp(url);
  }, url);
}

test("sent and received public URLs retain link semantics and inline navigation offers joining", async ({ page }) => {
  await prepare(page);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("https://t.me/public_group");
  await composer.press("Enter");
  const link = page.locator('.message-list a[href="https://t.me/public_group"]').last();
  await expect(link).toHaveText("https://t.me/public_group");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const chatId = state.activeChatId!;
    const rows = state.messages.get(chatId)!;
    const sent = rows.at(-1)!;
    const text = "https://t.me/public_channel @mia_design";
    telegramStore.setState({ messages: new Map(state.messages).set(chatId, [...rows, { ...sent, id: "received-link", outgoing: false, senderId: "u-mia", content: {
      kind: "text", text, entities: [{ kind: "url", offset: 0, length: 27 }, { kind: "mention", offset: 28, length: 11 }],
    } }]) });
  });
  await expect(page.locator('[data-message-id="received-link"] a[href="https://t.me/public_channel"]')).toHaveText("https://t.me/public_channel");
  await expect(page.locator('[data-message-id="received-link"] a[href="https://t.me/mia_design"]')).toHaveText("Mia Chen");
  await link.click();
  const join = page.getByRole("button", { name: "加入群组", exact: true });
  await expect(join).toBeVisible();
  await expect(composer).toHaveCount(0);
  const bar = await page.locator(".chat-membership-bar").boundingBox();
  expect(bar?.height).toBe(50);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/join-public-group.png" });
  await join.click();
  await expect(composer).toBeVisible();
  expect((await page.locator(".composer").boundingBox())?.height).toBe(50);
  await composer.fill("加入后的测试消息");
  await composer.press("Enter");
  await expect(page.locator(".message-list")).toContainText("加入后的测试消息");
});

test("public channel join becomes a working mute switch", async ({ page }) => {
  await prepare(page);
  await openLink(page, "tg://resolve?domain=public_channel");
  await page.getByRole("button", { name: "加入频道", exact: true }).click();
  const mute = page.locator(".chat-membership-bar").getByRole("switch", { name: "静音", exact: true });
  await expect(mute).toBeVisible();
  const initial = await mute.getAttribute("aria-checked");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/join-channel-muted.png" });
});

test("approval requests keep the composer closed and react to membership updates", async ({ page }) => {
  await prepare(page, true);
  await openLink(page, "https://t.me/public_group");
  await page.getByRole("button", { name: "申请加入", exact: true }).click();
  await expect(page.getByRole("button", { name: "已申请，等待管理员批准" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveCount(0);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    telegramStore.setState({ chats: new Map(state.chats).set("chat-product", { ...state.chats.get("chat-product")!, isMember: true, canSendMessages: true }) });
  });
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
});

test("private approval invites show a modal without navigating or exposing history", async ({ page }) => {
  await prepare(page, true);
  await openLink(page, "tg://join?invite=chat-product");
  const dialog = page.getByRole("dialog", { name: "public_group", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("管理员批准后即可进入会话");
  await expect(page.locator(".conversation")).not.toContainText("public_group");
  await dialog.getByRole("button", { name: "申请加入", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "已申请，等待管理员批准" })).toBeDisabled();
  await page.screenshot({ path: "artifacts/join-approval-dialog.png" });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openLink(page, "https://telegram.me/joinchat/chat-product");
  await expect(page.getByRole("dialog").getByRole("button", { name: "已申请，等待管理员批准" })).toBeDisabled();
});

test("ordinary invitations join through the preview and already joined links open directly", async ({ page }) => {
  await prepare(page);
  await openLink(page, "https://t.me/+chat-product");
  const dialog = page.getByRole("dialog", { name: "public_group", exact: true });
  await dialog.getByRole("button", { name: "加入群组", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await openLink(page, "https://t.me/+chat-product");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".conversation")).toContainText("public_group");
});

test("invite error keeps the current conversation usable", async ({ page }) => {
  await prepare(page);
  await openLink(page, "https://t.me/+expired");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("邀请链接无效或已过期", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
});

test("invite modal fits a narrow dark window and closes with Escape", async ({ page }) => {
  await prepare(page, true);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.evaluate(async () => {
    const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("themeId", "notgram-dark");
  });
  await openLink(page, "https://t.me/+chat-product");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").evaluate(async element => {
    const presence = element.closest(".motion-presence")!;
    await Promise.all(presence.getAnimations({ subtree: true }).map(animation => animation.finished));
  });
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: "artifacts/join-approval-dark-narrow.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing an invitation while joining prevents delayed navigation", async ({ page }) => {
  await prepare(page);
  await openLink(page, "https://t.me/+chat-product");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const join = telegramStore.getState().joinChat;
    telegramStore.setState({ joinChat: input => new Promise(resolve => {
      Object.assign(window, { finishInviteJoin: async () => resolve(await join(input)) });
    }) });
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "加入群组", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(async () => {
    await (window as unknown as { finishInviteJoin: () => Promise<void> }).finishInviteJoin();
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".conversation-header")).toContainText("Mia Chen");
});

test("paid invites explain the limitation and never offer an enabled join", async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const chat = telegramStore.getState().chats.get("chat-release")!;
    window.dispatchEvent(new CustomEvent("notgram:telegram-link-opened", { detail: { kind: "chatInvite", preview: {
      inviteLink: "https://t.me/+paid", kind: "channel", title: "付费频道", avatar: chat.avatar,
      description: "需要订阅才能加入", memberCount: 32, createsJoinRequest: false, requiresSubscription: true,
    } } }));
  });
  await expect(page.getByRole("dialog")).toContainText("此邀请需要付费订阅");
  await expect(page.getByRole("dialog").getByRole("button", { name: "加入频道", exact: true })).toBeDisabled();
});

test("protocol settings register the app and direct existing defaults to Windows", async ({ page }) => {
  await page.route("**/src/release/telegramProtocol.ts*", route => route.fulfill({
    contentType: "application/javascript", body: `let registered=false; export const telegramProtocol={
      settings:async()=>({supported:true,registered,isDefault:false}),
      register:async()=>{registered=true;return {supported:true,registered,isDefault:false}},
      openDefaultApps:async()=>{window.defaultAppsOpened=true}
    };`,
  }));
  await prepare(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Notgram/ }).click();
  await page.getByRole("button", { name: "注册 Telegram 链接", exact: true }).click();
  await expect(page.getByText("在 Windows 默认应用中，将 TG 链接类型设为 Notgram", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开 Windows 默认应用", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { defaultAppsOpened?: boolean }).defaultAppsOpened)).toBe(true);
});
