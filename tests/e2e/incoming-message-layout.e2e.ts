import { expect, test, type Page } from "@playwright/test";
import type { Message, TelegramEvent } from "../../src/telegram/types";

interface ArrivalSample { top: number; height: number; preparing: boolean; entering: boolean }
interface ArrivalAudit { writes: number[]; samples: ArrivalSample[]; startTop: number; interrupted?: boolean }
interface ArrivalOptions { animateEntrance?: boolean; burst?: boolean; interrupt?: boolean }
interface PosterFrame { top: number; rowHeight: number; width: number; height: number; hasPoster: boolean }
type ArrivalWindow = Window & {
  arrivalTransport: { snapshot: { messages: Message[] }; listener: (event: TelegramEvent) => void };
  arrivalAudit: ArrivalAudit;
  posterAudit: { frame: number; samples: PosterFrame[] };
  posterRecoveryIds: number[];
};

const seedHistory = async (page: Page) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = function(listener) {
        globalThis.arrivalTransport = this;
        const messages = Array.from({length:30}, (_,i) => ({
          id:'arrival-history-'+i,chatId:'chat-product',senderId:['u-mia','u-chen','u-jules'][Math.floor(i/3)%3],
          outgoing:i===29,sentAt:new Date(1700000000000+i*1000).toISOString(),delivery:'read',
          content:{kind:'text',text:'Synthetic history message '+i}
        }));
        this.snapshot.messages = [...this.snapshot.messages.filter(m=>m.chatId!=='chat-product'),...messages];
        this.snapshot.chats = this.snapshot.chats.map(c=>c.id==='chat-product'?{...c,unreadCount:0,lastReadInboxMessageId:'arrival-history-29'}:c);
        return connect.call(this,listener);
      };
    }` });
  });
};

const receiveQuote = async (page: Page, media: boolean, options: ArrivalOptions = {}) => {
  await page.evaluate(({ media, animateEntrance = true, burst, interrupt }) => {
    const state = window as unknown as ArrivalWindow;
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const audit: ArrivalAudit = { writes: [], samples: [], startTop: list.scrollTop };
    state.arrivalAudit = audit;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(Element.prototype, "scrollTop", { ...descriptor, set(value: number) {
      if (this === list) audit.writes.push(value);
      descriptor.set!.call(this, value);
    } });
    const observer = new MutationObserver(() => {
      const row = list.querySelector<HTMLElement>('[data-message-id="arrival-target"]');
      if (row && interrupt && !audit.interrupted && row.classList.contains("is-preparing-entrance-incoming")) {
        audit.interrupted = true;
        list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
      }
      if (row) audit.samples.push({ top: list.scrollTop, height: row.offsetHeight,
        preparing: row.classList.contains("is-preparing-entrance-incoming"),
        entering: row.classList.contains("is-entering-incoming") });
    });
    observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    setTimeout(() => { observer.disconnect(); Object.defineProperty(Element.prototype, "scrollTop", descriptor); }, 1200);
    const quote = Array.from({ length: 14 }, (_, i) => `Synthetic quotation line ${i}: preserve the arrival viewport.`).join("\n");
    const text = `${quote}\n\nSource`;
    const entities = [{ kind: "blockquote" as const, offset: 0, length: quote.length }];
    const message: Message = {
      id: "arrival-target", chatId: "chat-product", senderId: "u-jules", outgoing: false,
      sentAt: new Date(1700000031000).toISOString(), delivery: "read",
      replyTo: { kind: "message", messageId: "arrival-history-29", chatId: "chat-product",
        content: { kind: "text", text: "Synthetic history message 29" } },
      content: media
        ? { kind: "media", mediaType: "video", fileName: "arrival.mp4", sizeLabel: "1 MB", width: 1280,
          height: 720, duration: 202, caption: text, captionEntities: entities }
        : { kind: "text", text, entities },
    };
    const dispatch = (value: Message) => {
      state.arrivalTransport.snapshot.messages.push(value);
      state.arrivalTransport.listener({ type: "message.upsert", message: value, animateEntrance });
    };
    if (burst) {
      dispatch({ ...message, id: "arrival-previous", sentAt: new Date(1700000030500).toISOString() });
      setTimeout(() => dispatch(message), 45);
    } else dispatch(message);
  }, { media, ...options });
};

const openHistory = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await seedHistory(page);
  await page.goto("/");
  if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
  return list;
};

const embeddedPoster = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='23'%3E%3Crect width='40' height='23' fill='blue'/%3E%3C/svg%3E";
const posterFileId = 9301;

const receiveVideoWithPoster = async (page: Page, thumbnailPath?: string) => {
  await page.evaluate(async ({ embeddedPoster, posterFileId, thumbnailPath }) => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = window as unknown as ArrivalWindow;
    state.posterRecoveryIds = [];
    telegramStore.setState({ recoverFile: async (fileId) => { state.posterRecoveryIds.push(fileId); return false; } });
    const message: Message = {
      id: "arrival-video", chatId: "chat-product", senderId: "u-jules", outgoing: false,
      sentAt: new Date(1700000031000).toISOString(), delivery: "sent",
      replyTo: { kind: "message", messageId: "arrival-history-29", chatId: "chat-product",
        content: { kind: "text", text: "Synthetic reply target" } },
      content: { kind: "media", mediaType: "video", fileName: "arrival.mp4", sizeLabel: "1 MB",
        width: 1280, height: 720, duration: 202, caption: "视频的三行说明\n\n源链接",
        captionEntities: [{ kind: "bold", offset: 0, length: 7 }],
        thumbnailFileId: posterFileId, thumbnailPath, previewDataUrl: embeddedPoster },
    };
    state.arrivalTransport.snapshot.messages.push(message);
    state.arrivalTransport.listener({ type: "message.upsert", message, animateEntrance: true });
  }, { embeddedPoster, posterFileId, thumbnailPath });
};

for (const width of [1366, 390]) {
  test(`incoming captioned reply video keeps its poster and geometry during upgrade (${width}px)`, async ({ page }) => {
    const list = await openHistory(page, width);
    const posterPath = "/received-video-poster.jpg";
    let releasePoster!: () => void;
    const pendingPoster = new Promise<void>(resolve => { releasePoster = resolve; });
    await page.route(`**${posterPath}`, async route => {
      await pendingPoster;
      await route.fulfill({ path: "tests/fixtures/public/mock-video-poster.jpg" });
    });
    try {
      await receiveVideoWithPoster(page);
      const row = list.locator('[data-message-id="arrival-video"]');
      await expect(row.locator(".message-reply-preview")).toBeVisible();
      await expect(row.locator(".video-preview img")).toHaveCSS("opacity", "1");
      await expect(row).not.toHaveClass(/is-entering|is-preparing-entrance/);
      await list.evaluate((host, { posterFileId, posterPath }) => {
        const state = window as unknown as ArrivalWindow;
        const row = host.querySelector<HTMLElement>('[data-message-id="arrival-video"]')!;
        const preview = row.querySelector<HTMLElement>(".photo-preview")!;
        const audit: ArrivalWindow["posterAudit"] = state.posterAudit = { frame: 0, samples: [] };
        const sample = () => {
          audit.samples.push({ top: host.scrollTop, rowHeight: row.offsetHeight,
            width: preview.offsetWidth, height: preview.offsetHeight,
            hasPoster: [...preview.querySelectorAll<HTMLImageElement>(".video-preview img")].some(image =>
              image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) === 1) });
          audit.frame = requestAnimationFrame(sample);
        };
        sample();
        state.arrivalTransport.listener({ type: "file.updated", file: { fileId: posterFileId,
          localPath: posterPath, isDownloaded: true, sizeLabel: "12 KB" } });
      }, { posterFileId, posterPath });

      const newPoster = row.locator(`.video-preview img[src="${posterPath}"]`);
      await expect(newPoster).toHaveAttribute("data-image-state", "decoding");
      await expect(row.locator('.video-preview img[src^="data:"]')).toHaveCSS("opacity", "1");
      releasePoster();
      await expect(newPoster).toHaveCSS("opacity", "1");
      await expect(row.locator(".video-preview img")).toHaveCount(1);
      const samples = await page.evaluate(() => {
        const { frame, samples } = (window as unknown as ArrivalWindow).posterAudit;
        cancelAnimationFrame(frame);
        return samples;
      });
      expect(samples.length).toBeGreaterThan(1);
      expect(samples[0].hasPoster).toBe(true);
      expect(samples.every(sample => sample.hasPoster && sample.rowHeight === samples[0].rowHeight &&
        sample.width === samples[0].width && sample.height === samples[0].height &&
        Math.abs(sample.top - samples[0].top) <= 1), JSON.stringify(samples)).toBe(true);
    } finally {
      releasePoster();
    }
  });

  for (const scenario of ["text", "video caption", "scaled static video", "consecutive videos"] as const) {
    test(`incoming folded ${scenario} commits its final layout before following (${width}px)`, async ({ page }) => {
      const list = await openHistory(page, width);
      if (scenario === "scaled static video") {
        await page.evaluate(async () => {
          const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
          preferencesStore.setState({ interfaceScale: 125, reduceMotion: true });
        });
        await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
      }
      await receiveQuote(page, scenario !== "text", {
        animateEntrance: scenario !== "scaled static video", burst: scenario === "consecutive videos",
      });
      const row = page.locator('[data-message-id="arrival-target"]');
      await expect(row.locator(".rich-blockquote")).toHaveAttribute("data-quote-state", "collapsed");
      await expect(row.locator(".message-text-flow")).toHaveClass(/is-meta-wrapped/);
      await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
      await page.waitForTimeout(400);
      const result = await list.evaluate(element => ({
        ...(window as unknown as ArrivalWindow).arrivalAudit, finalTop: element.scrollTop,
        finalHeight: element.querySelector<HTMLElement>('[data-message-id="arrival-target"]')!.offsetHeight,
      }));
      expect(result.writes.some(top => top > result.startTop + 1), JSON.stringify(result)).toBe(true);
      expect(Math.max(...result.writes) - result.finalTop, JSON.stringify(result)).toBeLessThanOrEqual(1);
      const visible = result.samples.filter(sample => !sample.preparing);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every(sample => Math.abs(sample.height - result.finalHeight) <= 1), JSON.stringify(result)).toBe(true);
    });
  }

  test(`incoming folded video preserves an existing reader (${width}px)`, async ({ page }) => {
    const list = await openHistory(page, width);
    await list.hover();
    await page.mouse.wheel(0, -180);
    await expect(page.locator(".jump-to-latest")).toBeVisible();
    const anchor = await list.evaluate(element => {
      const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find(row => row.getBoundingClientRect().top > element.getBoundingClientRect().top + 5)!;
      return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
    });
    await receiveQuote(page, true);
    await expect(page.locator('[data-message-id="arrival-target"] .rich-blockquote')).toHaveAttribute("data-quote-state", "collapsed");
    await page.waitForTimeout(400);
    const top = await page.locator(`[data-message-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top);
    expect(Math.abs(top - anchor.top)).toBeLessThanOrEqual(1);
    await expect(page.locator(".jump-to-latest")).toBeVisible();
  });

  test(`upward intent cancels an incoming folded video's pending entrance pin (${width}px)`, async ({ page }) => {
    const list = await openHistory(page, width);
    await receiveQuote(page, true, { interrupt: true });
    await expect.poll(() => page.evaluate(() => (window as unknown as ArrivalWindow).arrivalAudit.interrupted)).toBe(true);
    const row = page.locator('[data-message-id="arrival-target"]');
    await expect(row).not.toHaveClass(/is-preparing-entrance/);
    await expect(row).not.toHaveClass(/is-entering-incoming/);
    await expect(page.locator(".jump-to-latest")).toBeVisible();
    const result = await list.evaluate(element => ({ ...(window as unknown as ArrivalWindow).arrivalAudit, finalTop: element.scrollTop }));
    expect(Math.abs(result.finalTop - result.startTop), JSON.stringify(result)).toBeLessThanOrEqual(1);
  });
}

test("incoming captioned reply video falls back when its cached poster is unreadable", async ({ page }) => {
  const list = await openHistory(page, 1366);
  await page.route("**/missing-video-poster.jpg", route => route.fulfill({ status: 404 }));
  await receiveVideoWithPoster(page, "/missing-video-poster.jpg");
  const row = list.locator('[data-message-id="arrival-video"]');
  await expect(row.locator('.video-preview img[src^="data:"]')).toHaveCSS("opacity", "1");
  await expect.poll(() => page.evaluate(() => (window as unknown as ArrivalWindow).posterRecoveryIds))
    .toEqual([posterFileId]);
});
