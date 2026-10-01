import { expect, test, type Page } from "@playwright/test";

const historyFixture = async (page: Page, media: boolean) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const read = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const source = Array.from({ length: 1800 }, (_, i) => ({ ...base,
          id: String(i + 1), renderKey: undefined, senderId: i % 7 ? "u-jules" : "u-alex",
          outgoing: false, replyTo: undefined, mediaAlbumId: undefined, interaction: undefined, isPending: false,
          sentAt: new Date(1700000000000 + i * 60000).toISOString(),
          content: ${media} && i % 6 === 0
            ? { kind: "media", mediaType: "photo", fileName: "cached.jpg", sizeLabel: "18 KB",
              localPath: "/mock-video-poster.jpg", width: 480, height: 240, isDownloaded: true, canDownload: false }
            : { kind: "text", text: "History message " + (i + 1) + " " + "variable height message ".repeat(i % 11 + 1) },
        }));
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product"
          ? { ...c, unreadCount: 0, lastReadInboxMessageId: "1800" } : c);
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: source.slice(-90) };
      };
      MockTelegramTransport.prototype.loadChatHistory = async function(...args) {
        await new Promise(resolve => setTimeout(resolve, 650));
        return read.apply(this, args);
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator(".message-list").press("End");
  await expect(page.locator('[data-message-id="1800"]')).toBeVisible();
  await page.waitForTimeout(550);
};

test("upward intent loads before the boundary and stopping never chains pages", async ({ page }) => {
  await historyFixture(page, false);
  const list = page.locator(".message-list");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const original = telegramStore.getState().loadMoreHistory;
    const requests: number[] = [];
    telegramStore.setState({ loadMoreHistory: async chatId => {
      requests.push(document.querySelector<HTMLElement>(".message-list")!.scrollTop);
      return original(chatId);
    } });
    Object.assign(window, { historyScrollRequests: requests });
    document.querySelector<HTMLElement>(".message-list")!.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(350);
  const requests = () => page.evaluate(() =>
    (window as unknown as { historyScrollRequests: number[] }).historyScrollRequests);
  expect(await requests()).toEqual([]);
  await list.hover();
  for (let input = 0; input < 100 && (await requests()).length === 0; input++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(15);
  }
  await expect.poll(async () => (await requests()).length).toBe(1);
  expect((await requests())[0]).toBeGreaterThan(64);
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(900);
  expect(await requests()).toHaveLength(1);
});

for (const media of [false, true]) {
  test(`continuous upward pagination never reverses visible content under slow rendering (media: ${media})`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 900, height: 900 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await historyFixture(page, media);
    const list = page.locator(".message-list");
    await list.hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const frames: Array<{ reverse: number; empty: boolean; covered: boolean }> = [];
      let previous = new Map<string, number>();
      let stopped = false;
      const sample = () => {
        const bounds = list.getBoundingClientRect();
        const tops = new Map([...list.querySelectorAll<HTMLElement>("[data-message-id]")]
          .filter(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
          }).map(row => [row.dataset.messageId!, row.getBoundingClientRect().top]));
        // Upward input moves surviving messages down the screen. Movement in
        // the opposite direction is a pagination correction, not user input.
        frames.push({ reverse: Math.max(0, ...[...previous].map(([id, top]) =>
          tops.has(id) ? top - tops.get(id)! : 0)), empty: tops.size === 0,
        covered: Boolean(document.querySelector("[data-conversation-history-snapshot]")) });
        previous = tops;
        if (!stopped) requestAnimationFrame(() => setTimeout(sample, 0));
      };
      sample();
      Object.assign(window, { historyScrollProbe: { frames, inputFrameCount: 0,
        stopInput: () => { (window as unknown as { historyScrollProbe: { inputFrameCount: number } }).historyScrollProbe.inputFrameCount = frames.length; },
        stop: () => { stopped = true; } } });
    });
    for (let input = 0; input < 180; input++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(10);
    }
    await page.evaluate(() => (window as unknown as { historyScrollProbe: { stopInput: () => void } }).historyScrollProbe.stopInput());
    await page.waitForTimeout(750);
    const result = await page.evaluate(async () => {
      const probe = (window as unknown as { historyScrollProbe: {
        frames: Array<{ reverse: number; empty: boolean; covered: boolean }>; inputFrameCount: number; stop: () => void;
      } }).historyScrollProbe;
      probe.stop();
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return { count: telegramStore.getState().messages.get("chat-product")!.length,
        frameCount: probe.frames.length, maxReverse: Math.max(...probe.frames.map(frame => frame.reverse)),
        emptyFrames: probe.frames.filter(frame => frame.empty).length,
        coveredFrames: probe.frames.slice(0, probe.inputFrameCount).filter(frame => frame.covered).length,
        failures: probe.frames.filter(frame => frame.reverse > 2 || frame.empty).slice(0, 8) };
    });
    await test.info().attach("history-scroll-metrics", {
      body: JSON.stringify(result), contentType: "application/json",
    });
    expect(result.count, JSON.stringify(result)).toBeGreaterThanOrEqual(180);
    expect(result.frameCount).toBeGreaterThan(100);
    expect(result.maxReverse, JSON.stringify(result)).toBeLessThanOrEqual(2);
    expect(result.emptyFrames, JSON.stringify(result)).toBe(0);
    expect(result.coveredFrames, JSON.stringify(result)).toBe(0);
  });
}
