import { expect, test, type Page } from "@playwright/test";

interface HistoryFixtureOptions {
  manualHistory?: boolean;
  differentSender?: boolean;
  head?: "longText" | "captionAbove" | "captionBelow" | "reply" | "album";
  crossDay?: boolean;
}

const historyFixture = async (page: Page, media: boolean, options: HistoryFixtureOptions = {}) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const read = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const source = Array.from({ length: 1800 }, (_, i) => ({ ...base,
          id: String(i + 1), renderKey: undefined,
          senderId: ${Boolean(options.differentSender)} && i === 1709 ? "u-alex" : i % 7 ? "u-jules" : "u-alex",
          outgoing: false,
          replyTo: ${options.head === "reply"} && i === 1710
            ? { kind: "message", chatId: "chat-product", messageId: "1700", quote: "Earlier message reply" } : undefined,
          mediaAlbumId: ${options.head === "album"} && (i === 1709 || i === 1710) ? "history-boundary-album" : undefined,
          interaction: undefined, isPending: false,
          sentAt: new Date(1700000000000 + i * 60000 - (${Boolean(options.crossDay)} && i < 1710 ? 86400000 : 0)).toISOString(),
          content: ${media} && (i % 6 === 0 || (${options.head === "album"} && i === 1709))
            ? { kind: "media", mediaType: "photo", fileName: "cached.jpg", sizeLabel: "18 KB",
              localPath: "/mock-video-poster.jpg", width: 480, height: 240, isDownloaded: true, canDownload: false,
              caption: ${options.head === "captionAbove" || options.head === "captionBelow"} && i === 1710 ? "A stable history photo caption" : undefined,
              showCaptionAboveMedia: ${options.head === "captionAbove"} }
            : { kind: "text", text: "History message " + (i + 1) + " " + "variable height message ".repeat(${options.head === "longText"} && i === 1710 ? 90 : i % 11 + 1) },
        }));
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product"
          ? { ...c, unreadCount: 0, lastReadInboxMessageId: "1800" } : c);
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: source.slice(-90) };
      };
      MockTelegramTransport.prototype.loadChatHistory = async function(...args) {
        await new Promise(resolve => setTimeout(resolve, 650));
        if (${Boolean(options.manualHistory)} && args[2]?.purpose === "refresh") {
          return read.call(this, args[0], 90, args[2]);
        }
        if (${Boolean(options.manualHistory)} && window.holdHistoryPage) await new Promise(resolve => Object.assign(window, { releaseHistoryPage: resolve }));
        return read.apply(this, args);
      };
    }` });
  });
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 900) < 600) await page.getByRole("button", { name: /^产品讨论/ }).click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator(".message-list").press("End");
  await expect(page.locator('[data-message-id="1800"]')).toBeVisible();
  await page.waitForTimeout(550);
};

const idleCases: Array<{ name: string; media: boolean; options?: HistoryFixtureOptions; width?: number; scale?: number }> = [
  { name: "text", media: false },
  { name: "photo", media: true },
  { name: "long text", media: false, options: { head: "longText" } },
  { name: "reply", media: false, options: { head: "reply" } },
  { name: "caption above", media: true, options: { head: "captionAbove" } },
  { name: "caption below", media: true, options: { head: "captionBelow" } },
  { name: "album merge", media: true, options: { head: "album" } },
  { name: "different sender", media: false, options: { differentSender: true } },
  { name: "cross day", media: true, options: { crossDay: true } },
  { name: "narrow", media: false, width: 390 },
  { name: "125% scale", media: true, scale: 125 },
];

const awaitIdleHistoryPage = async (page: Page) => {
  const list = page.locator(".message-list");
  await page.evaluate(() => { Object.assign(window, { holdHistoryPage: true }); });
  await list.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-message-id="1711"] .message-sender-row')).toBeVisible();
  await page.waitForFunction(() => typeof (window as unknown as { releaseHistoryPage?: () => void }).releaseHistoryPage === "function");
};

for (const { name, media, options, width = 900, scale } of idleCases) {
  test(`idle history preserves reading content across ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await historyFixture(page, media, { ...options, manualHistory: true });
    if (scale) await page.evaluate(async (scale) => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: scale });
    }, scale);
    const list = page.locator(".message-list");
    await awaitIdleHistoryPage(page);
    await page.evaluate(({ media, longText, album }) => {
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const points = album ? [
        { id: "1712", selector: ".message-rich-text" },
        { id: "1713", selector: ".message-rich-text" },
      ] : longText ? [{ id: "1711", selector: ".message-rich-text" }] : [
        { id: "1711", selector: media ? ".photo-preview" : ".message-rich-text" },
        { id: "1712", selector: ".message-rich-text" },
        { id: "1713", selector: ".message-rich-text" },
      ];
      const top = (point: typeof points[number]) => list.querySelector<HTMLElement>(
        `[data-message-id="${point.id}"] ${point.selector}`,
      )?.getBoundingClientRect().top;
      const expected = points.map(top);
      const frames: Array<{ covered: boolean; offsets: Array<number | undefined> }> = [];
      let stopped = false;
      const sample = () => {
        frames.push({ covered: Boolean(document.querySelector("[data-conversation-history-snapshot]")),
          offsets: points.map((point, index) => {
            const actual = top(point);
            return actual !== undefined && expected[index] !== undefined ? actual - expected[index]! : undefined;
          }) });
        if (!stopped) requestAnimationFrame(() => setTimeout(sample, 0));
      };
      sample();
      Object.assign(window, { idleHistoryProbe: { frames, stop: () => { stopped = true; } } });
      (window as unknown as { releaseHistoryPage: () => void }).releaseHistoryPage();
    }, { media, longText: options?.head === "longText", album: options?.head === "album" });
    await expect(list).toHaveAttribute("aria-busy", "false");
    if (!options?.differentSender && !options?.crossDay) {
      await expect(page.locator('[data-message-id="1711"] .message-sender-row')).toHaveCount(0);
    }
    if (options?.head === "album") await expect(page.locator('[data-media-album-id="history-boundary-album"]')).toBeVisible();
    await expect(page.locator("[data-conversation-history-snapshot]")).toHaveCount(0);
    await page.waitForTimeout(450);
    // A passive resize after release must use the recaptured row memory,
    // rather than interpreting the transaction's content offset as a row top.
    await page.evaluate(() => {
      const spacer = document.querySelector<HTMLElement>(".message-list-start-spacer")!;
      spacer.style.height = `${spacer.getBoundingClientRect().height + 37}px`;
    });
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => {
      const probe = (window as unknown as { idleHistoryProbe: {
        frames: Array<{ covered: boolean; offsets: Array<number | undefined> }>; stop: () => void;
      } }).idleHistoryProbe;
      probe.stop();
      const exposed = probe.frames.filter(frame => !frame.covered);
      return { frameCount: exposed.length, coveredFrames: probe.frames.filter(frame => frame.covered).length,
        missingFrames: exposed.filter(frame => frame.offsets.some(offset => offset === undefined)).length,
        maxShift: Math.max(...exposed.flatMap(frame => frame.offsets.map(offset => Math.abs(offset ?? 0)))),
        failures: exposed.filter(frame => frame.offsets.some(offset => offset === undefined || Math.abs(offset) > 1)).slice(0, 5) };
    });
    await test.info().attach("idle-history-content-metrics", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.coveredFrames, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.frameCount).toBeGreaterThan(10);
    expect(result.missingFrames, JSON.stringify(result)).toBe(0);
    expect(result.maxShift, JSON.stringify(result)).toBeLessThanOrEqual(1);
  });
}

for (const input of ["wheel", "latest", "switch"] as const) {
  test(`idle history content anchoring yields to ${input} while its snapshot is visible`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await historyFixture(page, true, { manualHistory: true });
    await awaitIdleHistoryPage(page);
    await page.evaluate(() => (window as unknown as { releaseHistoryPage: () => void }).releaseHistoryPage());
    await page.locator("[data-conversation-history-snapshot]").waitFor({ state: "attached" });
    const list = page.locator(".message-list");
    if (input === "wheel") {
      const before = await list.evaluate(element => element.scrollTop);
      await page.mouse.wheel(0, 220);
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 100);
    } else if (input === "latest") {
      await list.press("End");
      await expect(page.locator('[data-message-id="1800"]')).toBeVisible();
    } else {
      await page.getByRole("button", { name: /^Mia Chen/ }).click();
      await expect(page.getByRole("region", { name: "Mia Chen 对话" })).toBeVisible();
      await expect(list).toHaveAttribute("data-conversation-virtuoso-key", "default:chat-mia:conversation");
    }
    await expect(page.locator("[data-conversation-history-snapshot]")).toHaveCount(0);
    await expect(list).toHaveAttribute("aria-busy", "false");
    await page.waitForTimeout(450);
    const before = await list.evaluate(element => element.scrollTop);
    await page.waitForTimeout(800);
    expect(Math.abs(await list.evaluate(element => element.scrollTop) - before)).toBeLessThanOrEqual(1);
    if (input === "latest") expect(await list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  });
}

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
