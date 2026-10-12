import { expect, test } from "@playwright/test";
import type { MessageContent } from "../../src/telegram/types";
import { revealVirtualMessage } from "./helpers";

const text = "首字边缘也能开始选择文本";
const fixtures: Array<{ name: string; content?: MessageContent; outgoing?: boolean; offset?: number }> = [
  { name: "incoming", content: { kind: "text", text } },
  { name: "outgoing", content: { kind: "text", text }, outgoing: true },
  { name: "formatted", content: { kind: "text", text, entities: [{ kind: "bold", offset: 0, length: 4 }] } },
  { name: "second-line", content: { kind: "text", text: `上一行\n${text}` }, offset: 4 },
  { name: "caption", content: {
    kind: "media", mediaType: "photo", fileName: "selection.jpg", sizeLabel: "1 KB",
    width: 320, height: 80, previewDataUrl: "/mock-video-poster.jpg", caption: text,
  } },
  { name: "discussion" },
];

for (const layout of [
  { name: "desktop", width: 1366, zoom: "1" },
  { name: "narrow-zoom", width: 390, zoom: "1.25" },
]) {
  for (const fixture of fixtures) {
    test(`bubble padding starts native text selection and copying (${fixture.name}, ${layout.name})`, async ({ page, context }) => {
      await page.setViewportSize({ width: layout.width, height: 900 });
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/");
      let scope = page.locator(".conversation");
      let id = "m-1";
      if (fixture.name === "discussion") {
        await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
        await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
        scope = page.locator(".channel-discussion-panel");
        id = "release-comment-1";
      } else {
        await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
        await expect(scope.getByRole("log")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(async ({ fixture, storePath }) => {
          const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
          const messages = new Map(telegramStore.getState().messages);
          const source = messages.get("chat-mia")!.find(message => message.id === "m-1")!;
          messages.set("chat-mia", [{
            ...source, outgoing: fixture.outgoing ?? false,
            senderId: fixture.outgoing ? "self" : source.senderId, content: fixture.content!,
          }]);
          telegramStore.setState({ messages });
        }, { fixture, storePath: "/src/store/telegramStore.ts" });
      }
      await page.locator("html").evaluate((element, zoom) => { element.style.zoom = zoom; }, layout.zoom);
      const surface = scope.locator(`[data-message-id="${id}"] .message-rich-text`).last();
      await expect(surface).toBeVisible();
      await expect(surface).not.toHaveAttribute("data-rich-text", "loading");
      if (fixture.name !== "discussion") await revealVirtualMessage(page, id);
      else await surface.scrollIntoViewIfNeeded();
      const composer = scope.getByRole("textbox", { name: "消息内容" });
      await composer.focus();
      // Capture drag coordinates after the conversation's entrance finishes.
      await scope.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => undefined)));
      });
      await expect(surface).toBeInViewport();

      const points = await surface.evaluate((element, offset) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const character = (index: number) => {
          walker.currentNode = element;
          let node = walker.nextNode();
          while (node && index >= (node.textContent?.length ?? 0)) {
            index -= node.textContent?.length ?? 0;
            node = walker.nextNode();
          }
          if (!node) throw new Error("Selection fixture has no text at the requested offset");
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          return range.getBoundingClientRect();
        };
        const first = character(offset);
        const end = character(offset + 7);
        const start = { x: first.left - 2, y: first.top + first.height / 2 };
        const target = document.elementFromPoint(start.x, start.y);
        return {
          start, end: { x: end.right, y: end.top + end.height / 2 },
          expected: element.textContent!.slice(offset, offset + 8),
          paddingTarget: target?.matches(".message-bubble, .message-text-flow") ?? false,
        };
      }, fixture.offset ?? 0);
      expect(points.paddingTarget).toBe(true);
      await page.mouse.move(points.start.x, points.start.y);
      await page.mouse.down();
      await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(points.expected);
      await expect(composer).not.toBeFocused();
      await page.keyboard.press("Control+c");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(points.expected);

      // Extending beyond the message must retain its original text boundary.
      const boundary = await surface.evaluate(element => {
        const selection = getSelection()!;
        const other = element.closest("[data-composer-scope]")!.querySelector(".composer-input")!;
        const text = document.createTreeWalker(other, NodeFilter.SHOW_TEXT).nextNode() ?? other;
        selection.setBaseAndExtent(selection.anchorNode!, selection.anchorOffset, text, 0);
        document.dispatchEvent(new Event("selectionchange"));
        return element.contains(selection.anchorNode) && element.contains(selection.focusNode);
      });
      expect(boundary).toBe(true);
      await scope.getByRole("log").click({ position: { x: 3, y: 3 } });
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("");
      await expect(scope.locator(".is-text-selection-origin")).toHaveCount(0);
    });
  }
}
