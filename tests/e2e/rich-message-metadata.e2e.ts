import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message, MessageContent } from "../../src/telegram/types";

const metrics = "ttft:1.64s  tps:46.9t/s  token:6.2k";

async function showRichMessage(page: Page, tail = metrics) {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  await page.evaluate(async tail => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { mapTdMessageContent } = await import("/src/telegram/tdlibMapper.ts" as string) as typeof import("../../src/telegram/tdlibMapper");
    const plain = (text: string) => ({ "@type": "richTextPlain", text });
    const state = telegramStore.getState();
    const source = state.messages.get("chat-product")!.find(message => message.id === "p-video")!;
    telegramStore.setState({ messages: new Map(state.messages).set(source.chatId, [{
      ...source, id: "rich-metadata", outgoing: false, replyTo: undefined, editedAt: undefined,
      interaction: undefined,
      content: mapTdMessageContent({ "@type": "messageRichMessage", message: {
        "@type": "richMessage", is_full: true, is_rtl: false, blocks: [
          { "@type": "pageBlockParagraph", text: plain("先查看一下服务器的监控数据。当前运行状态稳定。") },
          { "@type": "pageBlockPreformatted", language: "", text: plain("Uptime      1 周 28 分钟\n负载        0.21 / 0.14 / 0.12\n内存        5.5Gi / 15Gi\n磁盘        53G / 110G（51%）") },
          { "@type": "pageBlockParagraph", text: plain("负载较低，磁盘空间充足，目前无需额外处理。") },
          { "@type": "pageBlockDivider" },
          { "@type": "pageBlockParagraph", text: { "@type": "richTextBold", text: plain(tail) } },
        ],
      } }),
    }]) });
  }, tail);
  await page.evaluate(() => document.fonts.ready);
  const row = page.locator('[data-message-id="rich-metadata"]');
  await expect(row.locator(".rich-message-content > p:last-child")).toHaveText(tail);
  return row;
}

async function geometry(row: Locator) {
  return row.evaluate(element => {
    const text = element.querySelector(".rich-message-content > p:last-child")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const line = [...range.getClientRects()].filter(rect => rect.width > 0).at(-1)!;
    const meta = element.querySelector(".message-meta")!.getBoundingClientRect();
    const bubble = element.querySelector<HTMLElement>(".message-bubble")!;
    const bounds = bubble.getBoundingClientRect();
    return {
      sameLine: meta.top < line.bottom && meta.bottom > line.top,
      gap: meta.left - line.right,
      wrappedGap: meta.top - line.bottom,
      contained: meta.right <= bounds.right + 0.5 && meta.left >= bounds.left,
      overflow: bubble.scrollWidth - bubble.clientWidth,
    };
  });
}

async function updateMessage(page: Page, changes: Partial<Message>) {
  await page.evaluate(async changes => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product",
      state.messages.get("chat-product")!.map(message => ({ ...message, ...changes }))) });
  }, changes);
}

for (const scenario of [
  { width: 1366, zoom: "1", tail: metrics },
  { width: 574, zoom: "1", tail: metrics },
  { width: 390, zoom: "1.25", tail: "ttft:1.64s" },
]) test(`rich paragraphs share their final line with metadata when space permits (${scenario.width}px, zoom=${scenario.zoom})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: 900 });
  const row = await showRichMessage(page, scenario.tail);
  await row.evaluate((element, zoom) => {
    document.documentElement.style.zoom = zoom;
    element.querySelector<HTMLElement>(".message-bubble-shell")!.style.width = "356px";
  }, scenario.zoom);
  await expect.poll(async () => (await geometry(row)).sameLine).toBe(true);
  const inline = await geometry(row);
  expect(inline.gap).toBeGreaterThanOrEqual(7);
  expect(inline.contained).toBe(true);
  expect(inline.overflow).toBeLessThanOrEqual(1);
  await row.screenshot({ path: testInfo.outputPath("inline.png") });

  await row.evaluate(element => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble")!;
    const scale = bubble.getBoundingClientRect().width / bubble.offsetWidth;
    const range = document.createRange();
    range.selectNodeContents(element.querySelector(".rich-message-content > p:last-child")!);
    const textWidth = range.getBoundingClientRect().width / scale;
    const metaWidth = element.querySelector(".message-meta")!.getBoundingClientRect().width / scale;
    element.querySelector<HTMLElement>(".message-bubble-shell")!.style.width = `${textWidth + metaWidth + 18}px`;
  });
  await expect.poll(async () => (await geometry(row)).sameLine).toBe(false);
  const wrapped = await geometry(row);
  expect(wrapped.wrappedGap).toBeGreaterThanOrEqual(1);
  expect(wrapped.contained).toBe(true);
  expect(wrapped.overflow).toBeLessThanOrEqual(1);

  await row.evaluate(element => { element.querySelector<HTMLElement>(".message-bubble-shell")!.style.width = "356px"; });
  await expect.poll(async () => (await geometry(row)).sameLine).toBe(true);
});

test("rich metadata reflows after delivery changes and moves once into a reaction footer", async ({ page }) => {
  const row = await showRichMessage(page);
  await row.evaluate(element => { element.querySelector<HTMLElement>(".message-bubble-shell")!.style.width = "330px"; });
  await expect.poll(async () => (await geometry(row)).sameLine).toBe(true);
  await updateMessage(page, { outgoing: true, delivery: "read", editedAt: "2026-10-01T02:00:00Z" });
  await expect(row.locator(".message-meta")).toHaveAttribute("data-context", "outgoing");
  await expect.poll(async () => (await geometry(row)).sameLine).toBe(false);
  expect((await geometry(row)).wrappedGap).toBeGreaterThanOrEqual(1);
  await updateMessage(page, { outgoing: false, editedAt: undefined, interaction: {
    viewCount: 0, forwardCount: 0, replyCount: 0,
    reactions: [{ type: { kind: "emoji", emoji: "👍" }, totalCount: 1, chosen: false, recentSenderIds: [] }],
  } });
  await expect(row.locator(".message-meta")).toHaveCount(1);
  await expect(row.locator(".message-reaction-footer .message-meta")).toBeVisible();
  await updateMessage(page, { interaction: undefined });
  await expect(row.locator(".message-reaction-footer")).toHaveCount(0);
  await expect.poll(async () => (await geometry(row)).sameLine).toBe(true);
});

for (const ending of ["preformatted", "divider", "streaming", "rtl"] as const) {
  test(`rich ${ending} endings retain a separate metadata row`, async ({ page }) => {
    const row = await showRichMessage(page);
    const content = await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().messages.get("chat-product")![0].content;
    }) as Extract<MessageContent, { kind: "rich" }>;
    if (ending === "preformatted") content.blocks[content.blocks.length - 1] = { kind: "preformatted", text: [{ text: "Final code block" }] };
    if (ending === "divider") content.blocks[content.blocks.length - 1] = { kind: "divider" };
    if (ending === "streaming") content.isFull = false;
    if (ending === "rtl") content.isRtl = true;
    await updateMessage(page, { content });
    await expect(row.locator(".message-meta")).toHaveCount(1);
    await expect.poll(() => row.evaluate(element => {
      const tail = element.querySelector(".rich-message-content")!.lastElementChild!.getBoundingClientRect();
      const meta = element.querySelector(".message-meta")!.getBoundingClientRect();
      return meta.top - tail.bottom;
    })).toBeGreaterThanOrEqual(0);
  });
}
