import { expect, test, type Page } from "@playwright/test";
import type { Message, TelegramEvent } from "../../src/telegram/types";

interface ArrivalSample { top: number; height: number; preparing: boolean; entering: boolean }
interface ArrivalAudit { writes: number[]; samples: ArrivalSample[]; startTop: number; interrupted?: boolean }
interface ArrivalOptions { animateEntrance?: boolean; burst?: boolean; interrupt?: boolean }
type ArrivalWindow = Window & {
  arrivalTransport: { snapshot: { messages: Message[] }; listener: (event: TelegramEvent) => void };
  arrivalAudit: ArrivalAudit;
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

for (const width of [1366, 390]) {
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
