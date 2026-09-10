import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

async function captionGeometry(row: Locator) {
  return row.evaluate(element => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble")!;
    const flow = element.querySelector<HTMLElement>(".photo-caption-flow")!;
    const meta = flow.querySelector<HTMLElement>(".message-meta")!;
    const text = flow.querySelector<HTMLElement>(".message-rich-text")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const textBottom = Math.max(...[...range.getClientRects()].map(rect => rect.bottom));
    const bottom = flow.getBoundingClientRect().bottom;
    const previousScrollTop = bubble.scrollTop;
    bubble.scrollTop = bubble.scrollHeight;
    const internalScroll = bubble.scrollTop;
    bubble.scrollTop = previousScrollTop;
    return {
      internalScroll,
      textBottomGap: bottom - textBottom,
      metaBottomGap: bottom - meta.getBoundingClientRect().bottom,
      height: flow.getBoundingClientRect().height,
    };
  });
}

async function expectContainedCaption(row: Locator) {
  await expect(row.locator(".photo-caption-flow .message-meta")).toBeVisible();
  await expect.poll(async () => (await captionGeometry(row)).metaBottomGap).toBeGreaterThanOrEqual(2);
  const geometry = await captionGeometry(row);
  expect(geometry.textBottomGap).toBeGreaterThanOrEqual(2);
  expect(geometry.internalScroll).toBe(0);
}

async function pastePhoto(page: Page) {
  await page.getByRole("textbox", { name: "消息内容" }).evaluate(async element => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 480;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#d0e5f0";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error("Cannot encode photo")), "image/png");
    });
    const data = new DataTransfer();
    data.items.add(new File([blob], "caption.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(page.getByRole("region", { name: "待发送附件" })).toBeVisible();
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`sent photo captions stay inside the bubble after scrolling to the bottom (${reducedMotion})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const composer = page.getByRole("textbox", { name: "消息内容" });
    await composer.fill("图片说明应完整显示在气泡内");
    await pastePhoto(page);
    await composer.press("Enter");
    const photo = page.locator(".message-row.is-outgoing", { hasText: "图片说明应完整显示在气泡内" }).last();
    await expect(photo.locator("img")).toHaveAttribute("data-image-state", "ready");
    await expect(photo).not.toHaveClass(/is-entering|is-preparing-entrance/);
    await expectContainedCaption(photo);
    const originalHeight = (await captionGeometry(photo)).height;

    await composer.fill("图片之后的一条文字消息");
    await composer.press("Enter");
    const tail = page.locator(".message-row.is-outgoing", { hasText: "图片之后的一条文字消息" }).last();
    await expect(tail).not.toHaveClass(/is-entering|is-preparing-entrance/);
    const list = page.locator(".message-list");
    const bottomGap = () => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    await list.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(bottomGap).toBeGreaterThan(100);
    await page.mouse.wheel(0, 1200);
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    await expectContainedCaption(photo);
    // Further downward wheel input must not scroll the caption's clipping box.
    await photo.locator(".photo-caption-flow").hover();
    await page.mouse.wheel(0, 600);
    await expectContainedCaption(photo);
    expect((await captionGeometry(photo)).height).toBeCloseTo(originalHeight, 2);
    await page.locator(".conversation").screenshot({ path: testInfo.outputPath("sent-photo-caption.png") });
  });
}

for (const viewportWidth of [1280, 390]) test(`media caption clipping preserves text and metadata across sizes, placement, and delivery updates (${viewportWidth}px)`, async ({ page }) => {
  await page.setViewportSize({ width: viewportWidth, height: 900 });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const row = page.locator('[data-message-id="caption-layout"]');
  for (const fontSize of [12, 14, 18]) {
    await page.evaluate(size => document.documentElement.style.setProperty("--chat-font-size", `${size}px`), fontSize);
    for (const [mediaType, caption, outgoing, showCaptionAboveMedia] of [
      ["photo", "图片说明", true, false],
      ["photo", "说明文本".repeat(20), false, false],
      ["video", "视频说明", true, false],
      ["photo", "上方说明", false, true],
    ] as const) {
      await page.evaluate(async ({ mediaType, caption, outgoing, showCaptionAboveMedia }) => {
        const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
        const state = telegramStore.getState();
        const source = state.messages.get("chat-product")!.at(-1)!;
        const message: Message = {
          ...source, id: "caption-layout", renderKey: undefined, outgoing,
          senderId: outgoing ? "self" : "u-chen", sentAt: new Date().toISOString(),
          delivery: outgoing ? "sending" : "read", replyTo: undefined, editedAt: undefined, interaction: undefined,
          content: { kind: "media", mediaType, caption, showCaptionAboveMedia,
            fileName: "caption.jpg", sizeLabel: "1 KB", width: 600, height: 480,
            captionEntities: [],
            previewDataUrl: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480"><rect width="600" height="480" fill="#d0e5f0"/></svg>'),
          },
        };
        telegramStore.setState({ messages: new Map(state.messages).set("chat-product", [message]) });
      }, { mediaType, caption, outgoing, showCaptionAboveMedia });
      await expect(row.locator(".photo-caption")).toHaveText(caption);
      await expectContainedCaption(row);
      if (!outgoing) continue;
      for (const delivery of ["failed", "read"] as const) {
        await page.evaluate(async delivery => {
          const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
          const state = telegramStore.getState();
          const messages = state.messages.get("chat-product")!.map(message => ({ ...message, delivery }));
          telegramStore.setState({ messages: new Map(state.messages).set("chat-product", messages) });
        }, delivery);
        await expect(row.locator(".message-delivery-status")).toHaveAttribute("data-delivery", delivery);
        await expectContainedCaption(row);
      }
    }
  }
});
