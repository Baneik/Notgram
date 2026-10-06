import { expect, test, type Page } from "@playwright/test";
import type { Message, MessageContent } from "../../src/telegram/types";

const code = `[EN]\n  deepseek_whale_girl, ${"long_unbroken_token".repeat(14)}, 🐳\n\n[ZH]\n\t触发词（鲸鱼娘原版白裙）  \n`;
const second = "  second block\n\tkeep whitespace  \n";
const prefix = "Outside the block\n";
const suffix = "\nOutside after";

const contents: Record<string, MessageContent> = {
  entities: {
    kind: "text", text: `${prefix}${code}${suffix}\n${second}`,
    entities: [
      { kind: "pre", offset: prefix.length, length: code.length, language: "text" },
      { kind: "pre", offset: prefix.length + code.length + suffix.length + 1, length: second.length },
    ],
  },
  markdown: { kind: "text", text: `${prefix}\n\`\`\`text\n${code}\`\`\`\n${suffix}\n\`\`\`\n${second}\`\`\`` },
  rich: {
    kind: "rich", text: `${prefix}${code}${suffix}\n${second}`, isRtl: false, isFull: true,
    blocks: [
      { kind: "paragraph", text: [{ text: prefix }] },
      { kind: "preformatted", language: "text", text: [{ text: code.slice(0, 12) }, { text: code.slice(12), bold: true }] },
      { kind: "paragraph", text: [{ text: suffix }] },
      { kind: "preformatted", text: [{ text: second }] },
    ],
  },
};

const replaceLatest = async (page: Page, content: MessageContent) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  await page.evaluate(async ({ content, storePath }) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
      message.id === "p-video" ? { ...message, content } : message));
    telegramStore.setState({ messages });
  }, { content, storePath: "/src/store/telegramStore.ts" });
  const row = page.locator('[data-message-id="p-video"]');
  await expect(row.locator(".message-preformatted")).toHaveCount(2);
  return row;
};

for (const [kind, content] of Object.entries(contents)) {
  for (const scenario of [
    { name: "desktop", width: 1366, theme: "notgram-light", zoom: "1" },
    { name: "narrow-dark-zoom", width: 390, theme: "notgram-dark", zoom: "1.25" },
  ]) {
    test(`${kind} preformatted blocks wrap and copy their exact source (${scenario.name})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.addInitScript(() => {
        const state = { text: "" };
        Object.defineProperty(navigator, "clipboard", {
          configurable: true, value: { writeText: async (text: string) => { state.text = text; } },
        });
        Object.assign(globalThis, { __preformattedClipboard: state });
      });
      const row = await replaceLatest(page, content);
      await page.locator("html").evaluate((element, scenario) => {
        element.dataset.theme = scenario.theme;
        element.style.zoom = scenario.zoom;
      }, scenario);
      const block = row.locator(".message-preformatted").first();
      const source = block.locator("code.rich-pre");
      const button = block.getByRole("button");
      await expect(source).toHaveText(code, { useInnerText: false });
      await expect(source).toHaveCSS("white-space", "pre-wrap");
      await expect(source).toHaveCSS("overflow-wrap", "anywhere");
      await expect(button).toHaveCSS("opacity", "0");
      const before = await block.boundingBox();
      const geometry = await source.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        return {
          overflow: element.scrollWidth - element.clientWidth,
          lines: new Set(rects.map((rect) => rect.top)).size,
          contained: rects.every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1),
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.lines).toBeGreaterThan(6);
      expect(geometry.contained).toBe(true);
      await block.hover();
      await expect(button).toHaveCSS("opacity", "1");
      const after = await block.boundingBox();
      expect(after?.width).toBeCloseTo(before?.width ?? 0, 1);
      expect(after?.height).toBeCloseTo(before?.height ?? 0, 1);
      await button.click();
      await expect(button).toHaveAccessibleName("已复制");
      await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
        __preformattedClipboard: { text: string };
      }).__preformattedClipboard.text)).toBe(code);
      const secondButton = row.locator(".message-preformatted").nth(1).getByRole("button");
      await page.mouse.move(0, 0);
      await secondButton.focus();
      await expect(secondButton).toHaveCSS("opacity", "1");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
        __preformattedClipboard: { text: string };
      }).__preformattedClipboard.text)).toBe(second);
      await block.hover();
      await page.screenshot({ path: testInfo.outputPath(`${kind}-${scenario.name}.png`) });
    });
  }
}

test("preformatted copy falls back when denied and retries after a failure", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { text: "", fail: true };
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => { throw new Error("denied"); } },
    });
    document.execCommand = () => {
      if (state.fail) return false;
      state.text = document.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value ?? "";
      return true;
    };
    Object.assign(globalThis, { __preformattedClipboard: state });
  });
  const row = await replaceLatest(page, contents.entities);
  const block = row.locator(".message-preformatted").first();
  const button = block.getByRole("button");
  await block.hover();
  await button.click();
  await expect(button).toHaveAccessibleName("无法访问剪贴板，请使用键盘快捷键");
  await expect(page.locator("textarea[readonly]")).toHaveCount(0);
  await page.evaluate(() => { (globalThis as typeof globalThis & {
    __preformattedClipboard: { fail: boolean };
  }).__preformattedClipboard.fail = false; });
  await button.click();
  await expect(button).toHaveAccessibleName("已复制");
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
    __preformattedClipboard: { text: string };
  }).__preformattedClipboard.text)).toBe(code);
});
