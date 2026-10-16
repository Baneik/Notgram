import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

type MediaKind = "photo" | "animation" | "rich";
interface ReadingProbe {
  releaseHistory?: () => void;
  holdHistory: boolean;
  readingProbe?: { stop: () => Array<{ shift: number | null; covered: boolean }> };
}

const fixture = async (page: Page, media?: MediaKind, declared = false, initialCount = 90) => {
  let released = false;
  const pending: Array<() => void> = [];
  await page.route(/\/deferred-history-media\/\d+$/, async route => {
    if (!released) await new Promise<void>(resolve => pending.push(resolve));
    await route.fulfill({ contentType: media === "animation" ? "video/mp4" : "image/svg+xml",
      body: media === "animation" ? readFileSync("tests/fixtures/public/mock-video.mp4")
        : '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="1200"><rect width="100%" height="100%" fill="#5b7e90"/></svg>' });
  });
  const content = `{ mediaType: ${JSON.stringify(media === "animation" ? "animation" : "photo")},
    mimeType: ${JSON.stringify(media === "animation" ? "video/mp4" : "image/svg+xml")},
    fileName: "deferred", sizeLabel: "1 MB", localPath: "/deferred-history-media/" + id,
    width: ${declared ? 300 : "undefined"}, height: ${declared ? 1200 : "undefined"},
    isDownloaded: true, canDownload: false }`;
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const read = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const source = Array.from({ length: 12000 }, (_, i) => {
          const id = i + 1;
          return { ...base, id: String(id), renderKey: undefined, outgoing: false,
            senderId: id % 3 ? "u-jules" : "u-alex", interaction: undefined, replyTo: undefined,
            delivery: "sent", isPending: false,
            sentAt: new Date(1700000000000 + id * 60000).toISOString(),
            content: ${Boolean(media)} && id % 6 === 0 ? ${media === "rich"
              ? `{ kind: "rich", text: "Deferred rich media", isRtl: false, isFull: true,
                blocks: [{ kind: "media", media: { ...${content}, caption: { text: [{ text: "Deferred caption" }] } } }] }`
              : `{ kind: "media", ...${content}, caption: "Deferred caption" }`}
              : { kind: "text", text: "Reading message " + id + " " + "variable height ".repeat(id % 5 + 1) } };
        });
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product"
          ? { ...c, unreadCount: 0, lastReadInboxMessageId: "12000" } : c);
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: source.slice(-${initialCount}) };
      };
      MockTelegramTransport.prototype.loadChatHistory = async function(...args) {
        if (args[2]?.purpose === "refresh") return read.call(this, args[0], ${initialCount}, args[2]);
        if (window.holdHistory) await new Promise(resolve => { window.releaseHistory = resolve; });
        return read.apply(this, args);
      };
    }` });
  });
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 900) < 600) await page.getByRole("button", { name: /^产品讨论/ }).click();
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await list.press("End");
  await expect(page.locator('[data-message-id="12000"]')).toBeVisible();
  await page.waitForTimeout(400);
  await page.evaluate(() => { (window as unknown as ReadingProbe).holdHistory = true; });
  await list.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
  await page.waitForFunction(() => typeof (window as unknown as ReadingProbe).releaseHistory === "function");
  await page.waitForTimeout(650);
  return async () => {
    released = true;
    pending.splice(0).forEach(resolve => resolve());
  };
};

const releaseHistoryAndSample = (page: Page, anchorId = "11911") => page.evaluate(anchorId => {
  const list = document.querySelector<HTMLElement>(".message-list")!;
  const target = `[data-message-id="${anchorId}"] .message-rich-text`;
  const baseline = list.querySelector(target)!.getBoundingClientRect().top;
  const samples: Array<{ shift: number | null; covered: boolean }> = [];
  let stopped = false;
  const sample = () => {
    const anchor = list.querySelector(target);
    samples.push({ shift: anchor ? anchor.getBoundingClientRect().top - baseline : null,
      covered: Boolean(document.querySelector("[data-conversation-history-snapshot]")) });
    // Sample after paint, including the direction of the original wheel. A
    // disjoint virtual range is a failure too, not an empty set with zero drift.
    if (!stopped) requestAnimationFrame(() => setTimeout(sample, 0));
  };
  const state = window as unknown as ReadingProbe;
  state.readingProbe = { stop: () => { stopped = true; return samples; } };
  sample();
  state.holdHistory = false;
  state.releaseHistory!();
}, anchorId);

const assertStableReading = async (page: Page, live = false) => {
  const samples = await page.evaluate(() => (window as unknown as ReadingProbe).readingProbe!.stop());
  const exposed = samples.filter(sample => !sample.covered);
  if (live) expect(samples.filter(sample => sample.covered)).toHaveLength(0);
  expect(exposed.length).toBeGreaterThan(15);
  expect(exposed.filter(sample => sample.shift === null), JSON.stringify(samples)).toHaveLength(0);
  expect(Math.max(...exposed.map(sample => Math.abs(sample.shift!))), JSON.stringify(samples)).toBeLessThanOrEqual(1);
};

for (const { width, initialCount, anchorId } of [
  { width: 1280, initialCount: 90, anchorId: "11911" },
  { width: 390, initialCount: 90, anchorId: "11911" },
  { width: 1280, initialCount: 2400, anchorId: "9601" },
]) {
  test(`a live history prepend preserves content at ${width}px with ${initialCount} messages`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await fixture(page, undefined, false, initialCount);
    // At the boundary this wheel changes input ownership without moving the
    // viewport. Once the page arrives there is no further input to excuse drift.
    await page.mouse.wheel(0, -100);
    await releaseHistoryAndSample(page, anchorId);
    await page.waitForTimeout(1400);
    await assertStableReading(page, true);
  });
}

for (const scenario of [
  { media: "photo", width: 1280 }, { media: "photo", width: 390 },
  { media: "animation", width: 1280 }, { media: "rich", width: 1280 },
  { media: "photo", width: 1280, declared: true },
  { media: "photo", width: 1280, recentInput: true },
] as const) {
  test(`late ${scenario.media} geometry preserves reading at ${scenario.width}px, declared=${"declared" in scenario}, recent input=${"recentInput" in scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const releaseMedia = await fixture(page, scenario.media, "declared" in scenario);
    await releaseHistoryAndSample(page);
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[data-conversation-history-snapshot]")).toHaveCount(0);
    await page.waitForTimeout(450);
    if ("recentInput" in scenario) {
      const top = await page.locator(".message-list").evaluate(element => element.scrollTop);
      await page.mouse.wheel(0, -100);
      await expect.poll(() => page.locator(".message-list").evaluate(element => element.scrollTop)).toBeLessThanOrEqual(top - 99);
      await page.evaluate(() => (window as unknown as ReadingProbe).readingProbe!.stop());
      await releaseHistoryAndSample(page);
    }
    const media = page.locator('[data-message-id="11910"]');
    const before = await media.evaluate(element => element.getBoundingClientRect().height);
    await releaseMedia();
    await expect.poll(() => media.evaluate(element => [...element.querySelectorAll("img,video")].some(node =>
      node instanceof HTMLImageElement ? node.complete && node.naturalWidth > 0 : (node as HTMLVideoElement).videoWidth > 0,
    ))).toBe(true);
    await page.waitForTimeout(900);
    const after = await media.evaluate(element => element.getBoundingClientRect().height);
    if (!("declared" in scenario) && scenario.media !== "rich") expect(Math.abs(after - before)).toBeGreaterThan(40);
    else expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    await assertStableReading(page);
  });
}
