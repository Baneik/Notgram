/// <reference types="vite/client" />
import { expect, test, type Page } from "@playwright/test";

const ready = async (page: Page) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};

const anchor = (page: Page) => page.locator(".message-list").evaluate((list) => {
  const bounds = list.getBoundingClientRect();
  const row = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => {
    const rect = item.getBoundingClientRect();
    return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
  });
  if (!row?.dataset.messageId) throw new Error("Missing reading anchor");
  return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - bounds.top };
});

const traceViewport = (page: Page, chatId: string, messageId: string) => page.evaluate(({ chatId, messageId }) => {
  const frames: Array<{ offset: number | null; covered: boolean; first?: string }> = [];
  Object.assign(window, { stabilityFrames: frames, stopStabilityTrace: false });
  const sample = () => {
    const list = document.querySelector<HTMLElement>(".message-list");
    if (list && document.querySelector<HTMLElement>('.chat-row[aria-current="true"]')?.dataset.chatId === chatId) {
      const bounds = list.getBoundingClientRect();
      const target = list.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      const content = list.querySelector<HTMLElement>(".message-list-content") ?? list;
      frames.push({
        offset: target ? target.getBoundingClientRect().top - bounds.top : null,
        covered: getComputedStyle(content).visibility === "hidden" || Boolean(document.querySelector(
          "[data-conversation-switch-snapshot], [data-conversation-motion-snapshot], .message-positioning-placeholder",
        )),
      });
    }
    if (!(window as unknown as { stopStabilityTrace: boolean }).stopStabilityTrace) {
      requestAnimationFrame(() => setTimeout(sample, 0));
    }
  };
  requestAnimationFrame(sample);
}, { chatId, messageId });

const exposedOffsets = (page: Page) => page.evaluate(() => {
  const state = window as unknown as {
    stopStabilityTrace: boolean;
    stabilityFrames: Array<{ offset: number | null; covered: boolean }>;
  };
  state.stopStabilityTrace = true;
  return state.stabilityFrames.filter((frame) => !frame.covered).map((frame) => frame.offset);
});

const deferReplyContext = (page: Page) => page.evaluate(async () => {
  const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
  const original = MockTelegramTransport.prototype.getMessageContext;
  MockTelegramTransport.prototype.getMessageContext = async function (...args) {
    await new Promise<void>((resolve) => Object.assign(window, { releaseContext: resolve }));
    return original.apply(this, args);
  };
});

test("media download updates do not interrupt wheel scrolling in either direction", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    const source = messages.get("chat-product")![0];
    messages.set("chat-product", Array.from({ length: 60 }, (_, index) => ({
      ...source, id: `scroll-media-${index}`, mediaAlbumId: undefined,
      sentAt: new Date(Date.UTC(2026, 8, 9, 0, index)).toISOString(),
      content: {
        kind: "media" as const, mediaType: index % 2 ? "photo" as const : "video" as const,
        fileName: `scroll-media-${index}.png`, fileId: 99000 + index,
        sizeLabel: "10 MB", size: 10_000_000, width: 480, height: 240,
        canDownload: true, isDownloaded: false, isDownloading: true,
        thumbnailIsDownloading: true, progress: 0.1,
      },
    })));
    telegramStore.setState({ messages });
  });
  const list = page.locator(".message-list");
  await expect(page.locator('[data-message-id="scroll-media-59"]')).toBeVisible();
  await expect.poll(() => list.evaluate(element =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(13);
  await list.hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(450);

  const timer = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return window.setInterval(() => {
      const messages = new Map(telegramStore.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map(message => (
        message.content.kind === "media" ? {
          ...message, content: { ...message.content, progress: ((message.content.progress ?? 0) + 0.01) % 0.9 },
        } : message
      )));
      telegramStore.setState({ messages });
    }, 30);
  });
  try {
    // Let an idle update acquire an anchor first, then exercise actual browser
    // wheel input while new updates arrive throughout each scroll interval.
    await page.waitForTimeout(120);
    for (const delta of [-160, 160]) {
      for (let step = 0; step < 5; step += 1) {
        const before = await list.evaluate(element => element.scrollTop);
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(220);
        const movement = await list.evaluate(element => element.scrollTop) - before;
        expect(Math.abs(movement - delta), `wheel ${delta}, step ${step}: moved ${movement}`)
          .toBeLessThanOrEqual(2);
      }
    }
    // Continued progress updates after input settles must not restore an old
    // reading position either.
    const beforeIdle = await anchor(page);
    await page.waitForTimeout(450);
    const afterIdle = await anchor(page);
    expect(afterIdle.id).toBe(beforeIdle.id);
    expect(Math.abs(afterIdle.offset - beforeIdle.offset)).toBeLessThanOrEqual(2);
  } finally {
    await page.evaluate(timer => window.clearInterval(timer), timer);
  }
});

test("a cold unread cursor outside the first page exposes only its settled viewport", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
    const original = MockTelegramTransport.prototype.getMessageContext;
    MockTelegramTransport.prototype.getMessageContext = async function (...args) {
      await new Promise<void>((resolve) => Object.assign(window, { releaseContext: resolve }));
      return original.apply(this, args);
    };
    const chats = new Map(telegramStore.getState().chats);
    chats.set("chat-chen", { ...chats.get("chat-chen")!, unreadCount: 120, lastReadInboxMessageId: "c-old-8" });
    telegramStore.setState({ chats });
  });
  await traceViewport(page, "chat-chen", "c-old-8");
  await page.locator('[data-chat-id="chat-chen"]').click();
  await page.waitForFunction(() => Boolean((window as unknown as { releaseContext?: () => void }).releaseContext));
  await page.waitForTimeout(600);
  await page.evaluate(() => (window as unknown as { releaseContext: () => void }).releaseContext());
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-old-8"]')).toBeVisible();
  await page.waitForTimeout(200);
  const offsets = await exposedOffsets(page);
  expect(offsets.length).toBeGreaterThan(0);
  expect(offsets).not.toContain(null);
  const measured = offsets as number[];
  expect(Math.max(...measured) - Math.min(...measured), JSON.stringify(offsets)).toBeLessThanOrEqual(2);
});

test("a delayed history page preserves the position reached while it was loading", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
    const original = MockTelegramTransport.prototype.loadChatHistory;
    MockTelegramTransport.prototype.loadChatHistory = async function (...args) {
      await new Promise<void>((resolve) => Object.assign(window, { releaseHistory: resolve }));
      return original.apply(this, args);
    };
  });
  const list = page.locator(".message-list");
  await list.hover();
  await page.mouse.wheel(0, -10000);
  await page.waitForFunction(() => Boolean((window as unknown as { releaseHistory?: () => void }).releaseHistory));
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(450);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await page.evaluate(() => (window as unknown as { releaseHistory: () => void }).releaseHistory());
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(600);
  const offsets = await exposedOffsets(page);
  expect(offsets.length).toBeGreaterThan(0);
  expect(offsets).not.toContain(null);
  expect(Math.max(...offsets.map((offset) => Math.abs(offset! - before.offset))), JSON.stringify(offsets))
    .toBeLessThanOrEqual(2);
});

test("background messages on both sides preserve a detached reading viewport", async ({ page }) => {
  await ready(page);
  const list = page.locator(".message-list");
  await list.hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(450);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { upsertMessages } = await import("/src/store/telegramStore.messages.ts" as string) as typeof import("../../src/store/telegramStore.messages");
    const messages = new Map(telegramStore.getState().messages);
    const current = messages.get("chat-product")!;
    const source = current[0];
    const additions = Array.from({ length: 45 }, (_, index) => ({
      ...source, id: `background-older-${index}`, mediaAlbumId: undefined,
      sentAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      content: { kind: "text" as const, text: "Older variable height message. ".repeat(index % 7 + 1) },
    }));
    messages.set("chat-product", upsertMessages(current, [...additions, {
      ...source, id: "background-newer", sentAt: "2027-01-01T00:00:00Z",
      content: { kind: "text", text: "Newer background message" },
    }]));
    telegramStore.setState({ messages });
  });
  await page.waitForTimeout(750);
  const offsets = await exposedOffsets(page);
  expect(offsets.length).toBeGreaterThan(0);
  expect(offsets).not.toContain(null);
  expect(Math.max(...offsets.map((offset) => Math.abs(offset! - before.offset))), JSON.stringify(offsets))
    .toBeLessThanOrEqual(2);
});

test("a slow reply keeps its origin still and reveals one continuous target motion", async ({ page }) => {
  await ready(page);
  const reply = page.locator('[data-message-id="p-channel-reply"] .message-reply-preview');
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -1);
  await reply.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await deferReplyContext(page);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await reply.click();
  await page.waitForFunction(() => Boolean((window as unknown as { releaseContext?: () => void }).releaseContext));
  await expect(page.getByRole("status", { name: "正在加载消息" })).toBeVisible();
  const originOffsets = await exposedOffsets(page);
  expect(originOffsets).not.toContain(null);
  expect(Math.max(...originOffsets.map((offset) => Math.abs(offset! - before.offset))))
    .toBeLessThanOrEqual(2);
  await traceViewport(page, "chat-product", "p-old-8");
  await page.evaluate(() => (window as unknown as { releaseContext: () => void }).releaseContext());
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveClass(/is-notification-target/);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const offsets = (await exposedOffsets(page)).filter((offset): offset is number => offset !== null);
  const changes = offsets.slice(1).map((offset, index) => offset - offsets[index]).filter((change) => Math.abs(change) > 2);
  expect(changes.some((change) => change > 0) && changes.some((change) => change < 0), JSON.stringify(offsets)).toBe(false);
  await expect(page.locator('[data-conversation-motion-snapshot]')).toHaveCount(0);
});

test("user scrolling cancels a reply that is still loading", async ({ page }) => {
  await ready(page);
  const reply = page.locator('[data-message-id="p-channel-reply"] .message-reply-preview');
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -1);
  await reply.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await deferReplyContext(page);
  await reply.click();
  await page.waitForFunction(() => Boolean((window as unknown as { releaseContext?: () => void }).releaseContext));
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(400);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await page.evaluate(() => (window as unknown as { releaseContext: () => void }).releaseContext());
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(650);
  const offsets = await exposedOffsets(page);
  expect(offsets).not.toContain(null);
  expect(Math.max(...offsets.map((offset) => Math.abs(offset! - before.offset))), JSON.stringify(offsets))
    .toBeLessThanOrEqual(2);
  await expect(page.locator('[data-message-id="p-old-8"].is-notification-target')).toHaveCount(0);
});
