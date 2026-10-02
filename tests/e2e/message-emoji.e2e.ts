import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

type TextMode = "markdown" | "entities";

async function renderedFonts(page: Page, selector: string) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    expect(nodeId, selector).toBeGreaterThan(0);
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts;
  } finally {
    await session.detach();
  }
}

const expectNoto = async (page: Page, selector: string) => {
  const fonts = await renderedFonts(page, selector);
  expect(fonts.some(font => font.familyName === "Noto Color Emoji" && font.isCustomFont && font.glyphCount > 0)).toBe(true);
  expect(fonts.some(font => font.familyName === "Segoe UI Emoji")).toBe(false);
};

async function showMessages(page: Page, texts: string[], mode: TextMode, outgoing = false, chatId = "chat-product") {
  await page.evaluate(async ({ texts, mode, outgoing, chatId }) => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const source = state.messages.get(chatId)!.find(message => message.isChannelPost)
      ?? state.messages.get(chatId)!.at(-1)!;
    const messages: Message[] = texts.map((text, index) => ({
      ...source,
      id: `emoji-layout-${index}`,
      renderKey: undefined,
      senderId: outgoing ? "self" : index % 2 === 0 ? "u-chen" : "u-jules",
      outgoing,
      sentAt: new Date(Date.now() + index * 600_000).toISOString(),
      delivery: "read",
      replyTo: undefined,
      editedAt: undefined,
      reactions: [],
      content: {
        kind: "text", text,
        entities: mode === "entities" ? [{ kind: "bold", offset: 0, length: text.length }] : undefined,
      },
    }));
    telegramStore.setState({ messages: new Map(state.messages).set(chatId, messages) });
  }, { texts, mode, outgoing, chatId });
  await expect(page.locator('[data-message-id="emoji-layout-0"] .message-rich-text'))
    .toHaveAttribute("data-rich-text", mode);
}

const geometry = (message: Locator) => message.evaluate(element => {
  const bubble = element.querySelector<HTMLElement>(".message-bubble")!;
  const flow = element.querySelector<HTMLElement>(".message-text-flow")!;
  const rich = element.querySelector<HTMLElement>(".message-rich-text")!;
  const leaf = rich.querySelector<HTMLElement>("p, strong") ?? rich;
  const meta = element.querySelector<HTMLElement>(".message-meta")!;
  const range = document.createRange();
  range.selectNodeContents(leaf);
  const glyph = range.getBoundingClientRect();
  const metaBounds = meta.getBoundingClientRect();
  const flowBounds = flow.getBoundingClientRect();
  const bubbleBounds = bubble.getBoundingClientRect();
  return {
    fontSize: Number.parseFloat(getComputedStyle(leaf).fontSize),
    glyphHeight: glyph.height,
    flowHeight: flowBounds.height,
    bubbleHeight: bubbleBounds.height,
    metaBottomGap: bubbleBounds.bottom - metaBounds.bottom,
    metaGlyphDelta: metaBounds.bottom - glyph.bottom,
    horizontalGap: metaBounds.left - glyph.right,
    metaRightGap: bubbleBounds.right - metaBounds.right,
    metaTop: metaBounds.top,
    textBottom: glyph.bottom,
  };
});

for (const mode of ["markdown", "entities"] as const) {
  for (const outgoing of [false, true]) {
    test(`multiple emoji share ordinary text height and time alignment (${mode}, outgoing=${outgoing})`, async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      await showMessages(page, ["哈哈", "😂😂", "😂😂😂", "😂 😂", "👩🏽‍💻👩🏽‍💻", "文字😂"], mode, outgoing);
      const reference = await geometry(page.locator('[data-message-id="emoji-layout-0"]'));
      for (let index = 1; index < 6; index += 1) {
        const message = page.locator(`[data-message-id="emoji-layout-${index}"]`);
        await expect(message.locator(".message-text-flow")).not.toHaveClass(/is-large-emoji|is-meta-wrapped/);
        const actual = await geometry(message);
        expect(actual.fontSize).toBe(reference.fontSize);
        expect(Math.abs(actual.flowHeight - reference.flowHeight)).toBeLessThanOrEqual(1);
        expect(Math.abs(actual.bubbleHeight - reference.bubbleHeight)).toBeLessThanOrEqual(1);
        expect(Math.abs(actual.metaBottomGap - reference.metaBottomGap)).toBeLessThanOrEqual(1);
        expect(actual.metaGlyphDelta).toBeGreaterThanOrEqual(2);
        expect(actual.metaGlyphDelta).toBeLessThanOrEqual(3);
        expect(actual.horizontalGap).toBeGreaterThanOrEqual(7);
      }
    });
  }

  test(`single emoji enlarges the glyph and keeps time inside the bubble (${mode})`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await showMessages(page, ["😂", "👩🏽‍💻", "❤️", "🇨🇳", "1️⃣"], mode);
    for (const fontSize of [14, 18]) {
      await page.evaluate(size => document.documentElement.style.setProperty("--chat-font-size", `${size}px`), fontSize);
      for (let index = 0; index < 5; index += 1) {
        const message = page.locator(`[data-message-id="emoji-layout-${index}"]`);
        await expect(message.locator(".message-text-flow")).toHaveClass(/is-large-emoji/);
        await expect(message.locator(".message-text-flow")).not.toHaveClass(/is-meta-wrapped/);
        const actual = await geometry(message);
        expect(actual.fontSize).toBeCloseTo(fontSize * 2.35, 1);
        expect(actual.glyphHeight).toBeGreaterThan(fontSize * 2);
        expect(actual.flowHeight).toBeLessThanOrEqual(fontSize * 2.35 * 1.08 + 1);
        expect(actual.metaBottomGap).toBeGreaterThanOrEqual(4);
        expect(actual.horizontalGap).toBeGreaterThanOrEqual(7);
        expect(actual.metaRightGap).toBeGreaterThanOrEqual(9);
        expect(actual.metaRightGap).toBeLessThanOrEqual(11);
      }
    }
  });
}

test("editing between single emoji, multiple emoji and wrapping text recalculates time layout", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const message = page.locator('[data-message-id="emoji-layout-0"]');
  for (const text of ["😂", "😂😂", "文字".repeat(100) + "😂", "😂"]) {
    await showMessages(page, [text], "markdown", true);
    const large = text === "😂";
    if (large) await expect(message.locator(".message-text-flow")).toHaveClass(/is-large-emoji/);
    else await expect(message.locator(".message-text-flow")).not.toHaveClass(/is-large-emoji/);
    if (text.length < 10) {
      await expect(message.locator(".message-text-flow")).not.toHaveClass(/is-meta-wrapped/);
      await expect.poll(async () => (await geometry(message)).fontSize).toBeCloseTo(large ? 32.9 : 14, 1);
      expect((await geometry(message)).metaBottomGap).toBeGreaterThan(2);
    }
  }
});

test("channel emoji posts retain their dedicated metadata row", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await showMessages(page, ["😂", "😂😂"], "markdown", false, "chat-release");
  for (let index = 0; index < 2; index += 1) {
    const message = page.locator(`[data-message-id="emoji-layout-${index}"]`);
    await expect(message.locator(".message-text-flow")).toHaveClass(/is-meta-wrapped/);
    const actual = await geometry(message);
    expect(actual.metaTop).toBeGreaterThanOrEqual(actual.textBottom - 1);
    expect(actual.metaBottomGap).toBeGreaterThanOrEqual(4);
  }
});

test("bundled Noto renders emoji across the composer, picker, messages and reactions without changing Unicode", async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeVisible();
  const text = "中文 AB 123 # * © ® ™ ↔ 😀 👩🏽‍💻 🇨🇳 1️⃣ ❤️";
  await composer.fill(text);
  await expect(composer).toHaveJSProperty("value", text);
  await expectNoto(page, ".composer-input p");
  const fonts = await renderedFonts(page, ".composer-input p");
  expect(fonts.some(font => font.familyName === "Segoe UI" && font.glyphCount >= 10)).toBe(true);

  await page.getByRole("button", { name: "表情", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await picker.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expectNoto(page, '.emoji-grid button[aria-label="插入 😀"]');
  await picker.getByRole("button", { name: "插入 😀", exact: true }).click();
  await expect(composer).toHaveJSProperty("value", text + "😀");
  await picker.getByRole("button", { name: "关闭表情面板" }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const sent = page.locator(".message-bubble.is-textual").filter({ hasText: text + "😀" });
  await expect(sent).toHaveCount(1);
  await expect(sent.locator(".message-rich-text")).toHaveText(text + "😀");

  await showMessages(page, [text, "😀"], "entities");
  await expectNoto(page, '[data-message-id="emoji-layout-0"] .message-rich-text strong');
  await expectNoto(page, '[data-message-id="emoji-layout-1"] .message-rich-text strong');
  await expect(page.locator('[data-message-id="emoji-layout-0"] .message-rich-text')).toHaveText(text);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const chatId = state.activeChatId!;
    const messages = state.messages.get(chatId)!.map(message => ({ ...message, interaction: {
      viewCount: 0, forwardCount: 0, replyCount: 0, ...message.interaction, reactions: [{
        type: { kind: "emoji" as const, emoji: "👍" }, totalCount: 3, chosen: false, recentSenderIds: [],
      }],
    } }));
    telegramStore.setState({ messages: new Map(state.messages).set(chatId, messages) });
  });
  await expect(page.locator('[data-message-id="emoji-layout-0"] .message-reaction-emoji')).toHaveText("👍");
  await expectNoto(page, '[data-message-id="emoji-layout-0"] .message-reaction-emoji');
});

test("notification windows bundle Noto and its complete font license", async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
  await page.goto("/windows/notification-window.html");
  await expect(page.getByRole("region", { name: "桌面通知" })).toBeVisible();
  await page.evaluate(async () => {
    const module = await (0, eval)('import("/src/notifications/notificationWindowStore.ts")') as typeof import("../../src/notifications/notificationWindowStore");
    module.replaceDesktopNotificationWindowSnapshot({ revision: 1, items: [{
      id: "noto-notification", title: "Emoji", body: "收到 😀 👩🏽‍💻 🇨🇳 ❤️", avatar: { label: "N", color: "#4e86b0" },
      themeId: "notgram-dark", reduceMotion: true, updatedAtMs: Date.now(),
      route: { accountId: "default", chatId: "chat-product", messageId: "p-5" },
    }] });
  });
  await expect(page.locator(".desktop-notification-message")).toHaveText("收到 😀 👩🏽‍💻 🇨🇳 ❤️");
  await expectNoto(page, ".desktop-notification-message");
  const licenseUrl = await page.locator('link[rel="license"]').getAttribute("href");
  expect(licenseUrl).toBeTruthy();
  const license = await page.request.get(licenseUrl!);
  expect(license.ok()).toBe(true);
  expect(await license.text()).toContain("SIL OPEN FONT LICENSE Version 1.1");
});
