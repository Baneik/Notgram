import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

type TextMode = "markdown" | "entities";

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
    test(`multiple emoji share ordinary text height and time alignment (${mode}, outgoing=${outgoing})`, async ({ page }, testInfo) => {
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
      await page.locator(".conversation").screenshot({ path: testInfo.outputPath("multiple-emoji.png") });
    });
  }

  test(`single emoji enlarges the glyph and keeps time inside the bubble (${mode})`, async ({ page }, testInfo) => {
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
    await page.locator(".conversation").screenshot({ path: testInfo.outputPath("single-emoji.png") });
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
  await page.locator('[data-chat-id="chat-release"]').click();
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
