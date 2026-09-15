import { expect, test, type Page } from "@playwright/test";

const proseExpression = "0.50。示例段落包含普通中文，检查较长内容始终限制在消息气泡内。".repeat(6);
const longExpression = `\\underbrace{${"abcdefghij".repeat(12)}}_{n}`;
const shortExpression = "E=mc^2";
const tallExpression = "\\dfrac{\\sum_{i=1}^{n} x_i^2}{\\sqrt{1+x^2}}";

async function showMathMessage(page: Page, outgoing: boolean) {
  await page.evaluate(async ({ outgoing, expressions }) => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const { mapTdMessageContent } = await (0, eval)('import("/src/telegram/tdlibMapper.ts")') as typeof import("../../src/telegram/tdlibMapper");
    const state = telegramStore.getState();
    const source = state.messages.get("chat-product")!.at(-1)!;
    const paragraphs = expressions.map(expression => ({
      "@type": "pageBlockParagraph",
      text: {
        "@type": "richTexts",
        texts: [
          { "@type": "richTextPlain", text: "Before " },
          { "@type": "richTextMathematicalExpression", expression },
          { "@type": "richTextPlain", text: " After" },
        ],
      },
    }));
    const blocks = outgoing
      ? [{ "@type": "pageBlockList", items: [{ "@type": "pageBlockListItem", label: "1.", blocks: paragraphs }] }]
      : paragraphs;
    const message = {
      ...source,
      id: "math-layout",
      renderKey: undefined,
      outgoing,
      senderId: outgoing ? "self" : "u-chen",
      sentAt: new Date().toISOString(),
      replyTo: undefined,
      editedAt: undefined,
      reactions: [],
      content: mapTdMessageContent({
        "@type": "messageRichMessage",
        message: {
          "@type": "richMessage", is_full: true, is_rtl: false,
          blocks: [...blocks, { "@type": "pageBlockMathematicalExpression", expression: expressions[1] }],
        },
      }),
    };
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", [message]) });
  }, { outgoing, expressions: [proseExpression, longExpression, shortExpression, tallExpression] });
  await expect(page.locator('[data-message-id="math-layout"] .katex')).toHaveCount(5);
  await page.evaluate(() => document.fonts.ready);
}

for (const width of [1280, 390]) {
  for (const outgoing of [false, true]) {
    test(`rich formulas stay readable inside the bubble (${width}px, outgoing=${outgoing})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      await showMathMessage(page, outgoing);
      const richText = page.locator('[data-message-id="math-layout"] .rich-message-content');
      const inlineMath = richText.locator(".rich-math-inline");

      // The same containment must hold after the user's text size changes.
      for (const fontSize of [14, 18]) {
        await page.evaluate(size => document.documentElement.style.setProperty("--chat-font-size", `${size}px`), fontSize);
        await expect.poll(() => richText.evaluate(element => element.scrollWidth - element.clientWidth))
          .toBeLessThanOrEqual(1);
        const outerGeometry = await richText.evaluate(element => {
          const bubble = element.closest<HTMLElement>(".message-bubble")!;
          const bounds = bubble.getBoundingClientRect();
          const content = element.getBoundingClientRect();
          return {
            contentLeft: content.left, contentRight: content.right,
            left: bounds.left, right: bounds.right,
          };
        });
        expect(outerGeometry.contentLeft).toBeGreaterThanOrEqual(outerGeometry.left);
        expect(outerGeometry.contentRight).toBeLessThanOrEqual(outerGeometry.right);
        expect(outerGeometry.left).toBeGreaterThanOrEqual(0);
        expect(outerGeometry.right).toBeLessThanOrEqual(width);

        await inlineMath.first().evaluate(element => { element.scrollLeft = 0; });
        await inlineMath.first().hover();
        await page.mouse.wheel(240, 0);
        await expect.poll(() => inlineMath.first().evaluate(element => element.scrollLeft)).toBeGreaterThan(0);

        for (const formula of [inlineMath.nth(0), inlineMath.nth(1), richText.locator(".rich-math-block")]) {
          const scroll = await formula.evaluate(element => {
            const surface = element as HTMLElement;
            surface.scrollLeft = 0;
            const visual = surface.querySelector<HTMLElement>(".katex-html")!;
            const before = visual.getBoundingClientRect().left;
            const maximum = surface.scrollWidth - surface.clientWidth;
            surface.scrollLeft = maximum;
            return {
              maximum,
              scrolled: surface.scrollLeft,
              displacement: before - visual.getBoundingClientRect().left,
              remainingRight: visual.getBoundingClientRect().right - surface.getBoundingClientRect().right,
            };
          });
          expect(scroll.maximum).toBeGreaterThan(100);
          expect(scroll.scrolled).toBeCloseTo(scroll.maximum, 0);
          expect(scroll.displacement).toBeCloseTo(scroll.maximum, 0);
          expect(scroll.remainingRight).toBeLessThanOrEqual(1);
        }

        for (const formula of [inlineMath.nth(2), inlineMath.nth(3)]) {
          const geometry = await formula.evaluate(element => {
            const surface = element as HTMLElement;
            const bounds = surface.getBoundingClientRect();
            const visual = surface.querySelector<HTMLElement>(".katex-html")!.getBoundingClientRect();
            const paragraph = surface.closest("p")!;
            const prefix = document.createRange();
            prefix.selectNodeContents(paragraph.firstChild!);
            const suffix = document.createRange();
            suffix.selectNodeContents(paragraph.lastChild!);
            return {
              horizontalOverflow: surface.scrollWidth - surface.clientWidth,
              topClipping: bounds.top - visual.top,
              bottomClipping: visual.bottom - bounds.bottom,
              prefixRight: prefix.getBoundingClientRect().right,
              formulaLeft: bounds.left, formulaRight: bounds.right,
              suffixLeft: suffix.getBoundingClientRect().left,
              fontSize: getComputedStyle(surface.querySelector(".katex")!).fontSize,
            };
          });
          expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
          expect(geometry.topClipping).toBeLessThanOrEqual(1);
          expect(geometry.bottomClipping).toBeLessThanOrEqual(1);
          expect(Number.parseFloat(geometry.fontSize)).toBeCloseTo(fontSize * 1.21, 1);
          if (width === 1280) {
            expect(geometry.prefixRight).toBeLessThanOrEqual(geometry.formulaLeft);
            expect(geometry.suffixLeft).toBeGreaterThanOrEqual(geometry.formulaRight);
          }
        }
      }
    });
  }
}
