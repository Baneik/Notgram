import { expect, test, type Page } from "@playwright/test";

test("presentation timing waits for the list opacity entrance to finish", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const timing = await page.evaluate(async () => {
    const monitor = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
    const presentation = await import("/src/utils/conversationPresentation.ts" as string) as typeof import("../../src/utils/conversationPresentation");
    const list = document.createElement("div");
    const content = document.createElement("div");
    content.className = "message-list-content";
    list.append(content);
    document.body.append(list);
    const traceId = monitor.beginConversationSwitch({ cached: true, messageCount: 0,
      viewTransition: false, navigationKind: 1, trackPresentation: true });
    for (const stage of ["transitionStarted", "selectionCommitted", "dataReady", "titleCommitted", "positioned"] as const) {
      monitor.markConversationSwitch(traceId, stage);
    }
    const animation = content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: "both" });
    const cleanup = presentation.observeConversationPresentation(list, traceId);
    await new Promise(resolve => setTimeout(resolve, 60));
    const finishedEarly = monitor.getPerformanceRecords().some(record => record.event === "ui_conversation_switch" && record.details.traceId === traceId);
    await animation.finished;
    for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    const record = monitor.getPerformanceRecords().find(record => record.event === "ui_conversation_switch" && record.details.traceId === traceId);
    cleanup();
    animation.cancel();
    list.remove();
    return { finishedEarly, duration: record?.details.presentationDurationMs };
  });
  expect(timing.finishedEarly).toBe(false);
  expect(timing.duration).toBeGreaterThanOrEqual(170);
});

const installColdUnread = async (page: Page) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const context = MockTelegramTransport.prototype.getMessageContext;
      const history = MockTelegramTransport.prototype.loadChatHistory;
      const getMessage = MockTelegramTransport.prototype.getMessage;
      const message = n => ({ id: "cold-" + n, chatId: "chat-mia", senderId: "u-mia", outgoing: false,
        sentAt: new Date(1700000000000 + n * 1000).toISOString(), delivery: "read",
        content: { kind: "text", text: "Unread context message " + n } });
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-mia"),
          ...Array.from({ length: 105 }, (_, i) => message(i + 1))];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-mia"
          ? { ...c, unreadCount: 1, lastReadInboxMessageId: "cold-119" } : c);
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: this.snapshot.messages.filter(m => m.chatId === "chat-mia") };
      };
      MockTelegramTransport.prototype.getMessageContext = async function(chatId, messageId, limit) {
        if (chatId !== "chat-mia") return context.call(this, chatId, messageId, limit);
        const failed = await new Promise(resolve => { window.releaseColdContext = resolve; });
        return failed ? [] : Array.from({ length: 31 }, (_, i) => message(i + 90));
      };
      MockTelegramTransport.prototype.getMessage = async function(chatId, messageId) {
        return chatId === "chat-mia" ? undefined : getMessage.call(this, chatId, messageId);
      };
      window.coldHistoryRequests = [];
      MockTelegramTransport.prototype.loadChatHistory = async function(chatId, limit, request) {
        if (chatId !== "chat-mia") return history.call(this, chatId, limit, request);
        window.coldHistoryRequests.push({ at: performance.now(),
          hidden: document.querySelector(".message-list")?.classList.contains("is-entry-positioning") });
        const from = request?.fromMessageId ? Number(request.fromMessageId.replace("cold-", "")) - 1 : 120;
        const messages = Array.from({ length: Math.min(30, from) }, (_, i) => message(from - i));
        return { messages, messageIds: messages.map(m => m.id), loadedCount: messages.length,
          nextFromMessageId: messages.at(-1)?.id, hasMore: from > 30 };
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};

test("revisiting a conversation reuses fresh administrator labels", async ({ page }) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const labels = MockTelegramTransport.prototype.getChatAdministratorLabels;
      window.administratorRequests = 0;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, chats: snapshot.chats.map(chat => chat.id === "chat-product"
          ? { ...chat, management: { ...chat.management, canOpenManagement: false } } : chat) };
      };
      MockTelegramTransport.prototype.getChatAdministratorLabels = async function(chatId) {
        if (chatId === "chat-product") window.administratorRequests++;
        return labels.call(this, chatId);
      };
    }` });
  });
  await page.goto("/");
  const calls = () => page.evaluate(() => (window as unknown as { administratorRequests: number }).administratorRequests);
  await expect.poll(calls).toBe(1);
  for (let i = 0; i < 3; i++) {
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
    await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  }
  expect(await calls()).toBe(1);
});

const openColdUnread = async (page: Page) => {
  await page.evaluate(() => document.querySelector<HTMLElement>(
    '.chat-list[data-active=true] [data-chat-id="chat-mia"]',
  )!.click());
  await page.waitForFunction(() => "releaseColdContext" in window);
};
const releaseContext = (page: Page, failed = false) => page.evaluate(failed => {
  (window as unknown as { releaseColdContext: (failed: boolean) => void }).releaseColdContext(failed);
}, failed);
const requests = (page: Page) => page.evaluate(() =>
  (window as unknown as { coldHistoryRequests: Array<{ at: number; hidden: boolean }> }).coldHistoryRequests);

for (const width of [1366, 390]) {
  test(`cold unread entry clears immediately and stays interactive at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await installColdUnread(page);
    await openColdUnread(page);
    await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
    expect(await page.locator("[data-conversation-switch-snapshot]").count()).toBe(0);
    await expect(page.locator(".message-list")).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".message-positioning-placeholder")).toBeVisible();
    await expect(page.locator(".conversation-entry-label")).toHaveText("正在加载消息");
    await expect(page.locator(".conversation-header[inert], .message-list-shell[inert]")).toHaveCount(0);
    expect(await requests(page)).toEqual([]);
    await page.locator(".composer-input").fill("draft while history is loading");
    await expect(page.locator(".composer-input")).toHaveText("draft while history is loading");
    const frames = await page.evaluate(async () => {
      let frames = 0;
      const startedAt = performance.now();
      while (performance.now() - startedAt < 250) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        frames++;
      }
      return frames;
    });
    expect(frames).toBeGreaterThan(5);
    await page.screenshot({ path: `test-results/conversation-loading-${width}.png` });
    await releaseContext(page);
    await expect(page.locator(".message-list")).toHaveCSS("visibility", "visible");
    await expect(page.locator('[data-message-id="cold-119"]')).toBeInViewport();
    await expect(page.locator(".message-positioning-placeholder")).toHaveCount(0);
    await expect(page.locator(".composer-input")).toHaveText("draft while history is loading");
    await expect.poll(() => requests(page).then(r => r.length)).toBe(1);
    expect((await requests(page)).every(r => !r.hidden)).toBe(true);
    await expect(page.locator('[data-message-id="cold-119"]')).toBeInViewport();
    await expect(page.locator(".message-list-content")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `test-results/conversation-loaded-${width}.png` });
  });
}

test("late unread context cannot replace the newer conversation", async ({ page }) => {
  await installColdUnread(page);
  await openColdUnread(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-chen"]').click();
  await releaseContext(page);
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id^="cold-"]')).toHaveCount(0);
  expect(await requests(page)).toEqual([]);
});

test("failed unread context reveals the available window without trapping the loader", async ({ page }) => {
  await installColdUnread(page);
  await openColdUnread(page);
  await releaseContext(page, true);
  await expect(page.locator(".message-list")).toHaveCSS("visibility", "visible");
  await expect(page.locator(".message-positioning-placeholder")).toHaveCount(0);
  await expect.poll(() => requests(page).then(r => r.length)).toBeGreaterThan(0);
  await expect(page.locator(".composer-input")).toBeEditable();
});

test("reduced motion uses a static loading indicator and immediate message reveal", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installColdUnread(page);
  await openColdUnread(page);
  await expect(page.locator(".conversation-entry-loader")).toBeVisible();
  await expect(page.locator(".conversation-entry-loader span").first()).toHaveCSS("animation-name", "none");
  await releaseContext(page);
  await expect(page.locator(".message-list")).toHaveCSS("visibility", "visible");
  await expect(page.locator(".message-list-content")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".message-list-content")).toHaveCSS("opacity", "1");
});

test("message entrance fades without moving the unread anchor during the head refresh", async ({ page }) => {
  await installColdUnread(page);
  await openColdUnread(page);
  const frames = await page.evaluate(async () => {
    (window as unknown as { releaseColdContext: (failed: boolean) => void }).releaseColdContext(false);
    const frames: Array<{ opacity: number; top: number; covered: boolean }> = [];
    const start = performance.now();
    while (performance.now() - start < 800) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const target = list.querySelector<HTMLElement>('[data-message-id="cold-119"]');
      if (!target || getComputedStyle(list).visibility !== "visible") continue;
      frames.push({ opacity: Number(getComputedStyle(list.querySelector(".message-list-content")!).opacity),
        top: target.getBoundingClientRect().top - list.getBoundingClientRect().top,
        covered: Boolean(document.querySelector("[data-conversation-history-snapshot]")) });
    }
    return frames;
  });
  expect(frames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  expect(frames.at(-1)?.opacity).toBe(1);
  // The existing prepend snapshot preserves the painted reading position
  // while Virtuoso changes the live DOM underneath it.
  const exposed = frames.filter(frame => !frame.covered);
  expect(exposed.length).toBeGreaterThan(5);
  expect(frames.at(-1)?.covered).toBe(false);
  expect(Math.max(...exposed.map(frame => frame.top)) - Math.min(...exposed.map(frame => frame.top)), JSON.stringify(frames)).toBeLessThanOrEqual(1);
  expect((await requests(page)).length).toBe(1);
});
