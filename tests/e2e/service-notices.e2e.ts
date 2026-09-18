import { expect, test, type Page } from "@playwright/test";
import { revealVirtualMessage } from "./helpers";

const injectNotices = async (page: Page) => {
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const storePath = "/src/store/telegramStore.ts";
    const mapperPath = "/src/telegram/tdlibMapper.ts";
    const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
    const { mapTdMessage } = await import(mapperPath) as typeof import("../../src/telegram/tdlibMapper");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...messages.get("chat-product")!];
    const base = current.at(-1)!;
    const users = new Map(state.users);
    users.set("notice-bob", { ...users.get("u-mia")!, id: "notice-bob", displayName: "Bob" });
    const timestamp = Math.floor(Date.now() / 1000) + 86400;
    const data: Array<[string, Record<string, unknown>]> = [
      ["notice-invite", { "@type": "messageChatAddMembers", member_user_ids: ["notice-bob"] }],
      ["notice-link", { "@type": "messageChatJoinByLink" }],
      ["notice-request", { "@type": "messageChatJoinByRequest" }],
      ["notice-remove", { "@type": "messageChatDeleteMember", user_id: "notice-bob" }],
      ["notice-topic", { "@type": "messageForumTopicCreated", name: "周末计划" }],
      ["notice-gift", { "@type": "messageGiftedPremium", gifter_user_id: "u-mia", receiver_user_id: "notice-bob", month_count: 3 }],
      ["notice-pin", { "@type": "messagePinMessage", message_id: "p-2" }],
    ];
    data.forEach(([id, content], index) => {
      const mapped = mapTdMessage({ id, chat_id: "chat-product", date: timestamp + index,
        sender_id: { "@type": "messageSenderUser", user_id: "u-mia" }, content })!;
      current.push({ ...base, ...mapped, renderKey: undefined, replyTo: undefined, isLocallyDeleted: id === "notice-request" });
    });
    messages.set("chat-product", current);
    telegramStore.setState({ messages, users });
  });
};

const openProduct = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await injectNotices(page);
};

for (const scenario of [
  { width: 1280, height: 800, scale: 1, dark: false },
  { width: 390, height: 844, scale: 1, dark: true },
  { width: 900, height: 680, scale: 1.25, dark: false },
]) {
  test(`notice colors, typography and centers agree at ${scenario.width}px and ${scenario.scale}x`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario);
    await openProduct(page);
    await page.evaluate(async ({ scale, dark }) => {
      const path = "/src/store/preferencesStore.ts";
      const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("interfaceScale", scale * 100);
      preferencesStore.getState().setPreference("themeId", dark ? "notgram-dark" : "notgram-light");
    }, scenario);
    const notice = await revealVirtualMessage(page, "notice-invite");
    await expect(notice).toContainText("Mia Chen 邀请 Bob 加入群聊");
    const retained = await revealVirtualMessage(page, "notice-request");
    await expect(retained).toContainText("Mia Chen 的入群申请已通过");
    await expect(retained).not.toContainText("已删除");
    await expect(retained.locator(".message-service-content")).toHaveAttribute("title", "这条消息已被删除，当前显示本地保留记录");
    const list = page.locator(".message-list");
    await list.hover();
    await page.mouse.wheel(0, -80);
    await expect(page.locator(".conversation-date-indicator")).toHaveClass(/is-visible/);
    await expect(page.locator(".conversation-date-indicator")).toHaveCSS("opacity", "1");
    const surfaces = await page.evaluate(() => {
      const elements = [document.querySelector(".message-day:last-of-type") ?? document.querySelector(".message-day"),
        document.querySelector(".conversation-date-indicator"),
        document.querySelector('[data-message-id="notice-invite"] .message-bubble'),
        document.querySelector('[data-message-id="notice-request"] .message-bubble')];
      return elements.map(element => {
        if (!element) throw Error("A notice surface is missing");
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { center: rect.left + rect.width / 2, background: style.backgroundColor, color: style.color,
          radius: style.borderRadius, font: style.fontSize, padding: style.padding, shadow: style.boxShadow,
          blur: style.backdropFilter, opacity: getComputedStyle(element.closest(".message-row") ?? element).opacity };
      });
    });
    for (const surface of surfaces) {
      expect(Math.abs(surface.center - surfaces[0].center)).toBeLessThanOrEqual(1);
      expect(surface.background).toBe(surfaces[0].background);
      expect(surface.color).toBe(surfaces[0].color);
      expect(surface.radius).toBe(surfaces[0].radius);
      expect(surface.font).toBe(surfaces[0].font);
      expect(surface.padding).toBe(surfaces[0].padding);
      expect(surface.shadow).toBe("none");
      expect(surface.blur).toBe("none");
    }
    expect(surfaces[3].opacity).toBe("1");
    const person = notice.getByRole("button", { name: "查看 Bob 资料" });
    expect(await person.evaluate(element => getComputedStyle(element).textDecorationLine)).toBe("none");
    expect(await person.locator("strong").evaluate(element => getComputedStyle(element).fontWeight)).toBe("700");
    const bounds = await notice.locator(".message-bubble").boundingBox();
    const viewport = await list.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(viewport!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
    await page.screenshot({ path: testInfo.outputPath("notices.png") });
  });
}

test("service details preserve identities, language changes and related-message navigation", async ({ page }) => {
  await openProduct(page);
  const gift = await revealVirtualMessage(page, "notice-gift");
  await expect(gift).toContainText("Mia Chen · 赠送了 Telegram Premium");
  await gift.locator("summary").click();
  await expect(gift).toContainText("3 个月 Premium");
  await expect(gift.getByRole("button", { name: "查看 Bob 资料" })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/preferencesStore.ts";
    const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("language", "en");
  });
  await expect(gift).toContainText("3 months of Premium");
  await expect(gift).toContainText("Recipient: Bob");
  await page.evaluate(async () => {
    const path = "/src/store/preferencesStore.ts";
    const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
    preferencesStore.getState().setPreference("language", "zh-CN");
  });
  const pin = await revealVirtualMessage(page, "notice-pin");
  await pin.getByRole("button", { name: /置顶了一条消息/ }).click();
  await expect(page.locator('[data-message-id="p-2"]')).toBeVisible();
  await expect(page.locator('[data-message-id="p-2"]')).toHaveClass(/is-notification-target/);
});

test("member aliases stay private in service notices and linked summaries", async ({ page }) => {
  await openProduct(page);
  const alias = await page.evaluate(async () => {
    const storePath = "/src/store/telegramStore.ts";
    const blocksPath = "/src/store/localUserBlocks.ts";
    const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
    const { localUserBlocksStore } = await import(blocksPath) as typeof import("../../src/store/localUserBlocks");
    const state = telegramStore.getState();
    localUserBlocksStore.getState().blockUser(state.activeAccountId!, state.users.get("notice-bob")!);
    const messages = new Map(state.messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-2"
      ? { ...message, senderId: "notice-bob", content: { kind: "text", text: "Private blocked message" } }
      : message));
    telegramStore.setState({ messages });
    return localUserBlocksStore.getState().users.find(user => user.userId === "notice-bob")!.alias;
  });
  const invite = await revealVirtualMessage(page, "notice-invite");
  await expect(invite).toContainText(alias);
  await expect(invite).not.toContainText("Bob");
  await expect(invite.getByRole("button", { name: /Bob/ })).toHaveCount(0);
  const gift = await revealVirtualMessage(page, "notice-gift");
  await gift.locator("summary").click();
  await expect(gift).toContainText(`接收人：${alias}`);
  await expect(gift).not.toContainText("Bob");
  await expect(gift.locator("strong").filter({ hasText: alias })).toBeVisible();
  const pin = await revealVirtualMessage(page, "notice-pin");
  await expect(pin).not.toContainText("Private blocked message");
  await expect(pin.getByRole("button", { name: "置顶了一条消息", exact: true })).toBeVisible();
});

test("long names wrap, missing users stay bold and service photos fall back safely", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page);
  await page.evaluate(async () => {
    const path = "/src/store/telegramStore.ts";
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const users = new Map(state.users);
    users.set("notice-bob", { ...users.get("notice-bob")!, displayName: "VeryLongUnbrokenUsername".repeat(10) });
    const messages = new Map(state.messages);
    const current = [...messages.get("chat-product")!];
    const index = current.findIndex(message => message.id === "notice-topic");
    current[index] = { ...current[index], content: { kind: "service", text: "", event: {
      type: "messageChatChangePhoto", actorId: "missing-user", photo: {
        localPath: "/missing-service-photo.png",
        previewDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=",
      },
    } } };
    messages.set("chat-product", current);
    telegramStore.setState({ users, messages });
  });
  const notice = await revealVirtualMessage(page, "notice-invite");
  const bounds = await notice.locator(".message-bubble").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await notice.locator(".message-bubble").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const photo = await revealVirtualMessage(page, "notice-topic");
  await expect(photo.locator("strong")).toHaveText("Telegram 用户");
  await expect(photo.getByRole("button", { name: /Telegram 用户/ })).toHaveCount(0);
  await expect(photo.locator("img")).toHaveAttribute("data-image-state", "ready");
});

test("channel and discussion service messages use the whole timeline center without avatars", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const path = "/src/store/telegramStore.ts";
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...messages.get("chat-release")!];
    current.push({ ...current.at(-1)!, id: "notice-channel", isChannelPost: true, sentAt: new Date(Date.now() + 86400000).toISOString(),
      content: { kind: "service", text: "", event: { type: "messageChatJoinByLink", actorId: "u-mia" } } });
    messages.set("chat-release", current);
    telegramStore.setState({ messages });
  });
  const channel = await revealVirtualMessage(page, "notice-channel");
  await expect(channel).toHaveClass(/is-service/);
  await expect(channel).not.toHaveClass(/is-channel-post/);
  expect(await channel.evaluate(row => {
    const bounds = row.getBoundingClientRect();
    const bubble = row.querySelector(".message-bubble")!.getBoundingClientRect();
    return Math.abs(bounds.left + bounds.width / 2 - bubble.left - bubble.width / 2);
  })).toBeLessThanOrEqual(1);
  const post = await revealVirtualMessage(page, "release-post-1");
  await post.getByRole("button", { name: "2 条评论" }).click();
  const panel = page.locator(".channel-discussion-panel");
  await expect(panel.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/telegramStore.ts";
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    for (const [chatId, history] of messages) {
      if (!history.some(message => message.id === "release-comment-1")) continue;
      messages.set(chatId, history.map(message => message.id === "release-comment-1" ? { ...message,
        content: { kind: "service", text: "", event: { type: "messageChatJoinByLink", actorId: "u-mia" } },
      } : message));
    }
    telegramStore.setState({ messages });
  });
  const comment = panel.locator('[data-message-id="release-comment-1"]');
  await expect(comment).toHaveClass(/is-service/);
  await expect(comment.locator("xpath=../..").locator(".message-group-avatar")).toHaveCount(0);
  expect(await comment.evaluate(row => {
    const group = row.closest(".message-group")!.getBoundingClientRect();
    const bubble = row.querySelector(".message-bubble")!.getBoundingClientRect();
    return Math.abs(group.left + group.width / 2 - bubble.left - bubble.width / 2);
  })).toBeLessThanOrEqual(1);
});
