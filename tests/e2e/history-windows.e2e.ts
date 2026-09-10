import { expect, test, type Page } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";

const fixture = async (page: Page) => {
  await page.route(/\/src\/store\/telegramStore\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nglobalThis.__windowStore = telegramStore;` });
  });
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const read = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const make = id => ({ ...base, id: String(id), renderKey: undefined, senderId: id % 3 ? "u-jules" : "u-alex",
          outgoing: false, sentAt: new Date(1700000000000 + id * 60000).toISOString(), delivery: "sent",
          replyTo: id === 10000 ? { kind: "message", chatId: "chat-product", messageId: "115", senderId: "u-jules", content: { kind: "text", text: "window target 115" } } : undefined,
          content: { kind: "text", text: "window message " + id }, interaction: undefined, isPending: false });
        const source = Array.from({length:10000}, (_,i) => make(i+1));
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product" ? { ...c, unreadCount:0, lastReadInboxMessageId:"10000" } : c);
        globalThis.__historyFixture = { dispatch:listener, calls:0 };
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages:source.slice(-164) };
      };
      MockTelegramTransport.prototype.loadChatHistory = async function(...args) {
        if(args[0] === "chat-product") globalThis.__historyFixture.calls++;
        await new Promise(resolve => setTimeout(resolve, 30));
        return read.apply(this, args);
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator('.conversation .message-list')).toHaveAttribute("aria-busy", "false");
  await page.locator('.message-list').press("End");
  await expect(page.locator('[data-message-id="10000"]')).toBeVisible();
  await page.waitForTimeout(600);
};

test("a distant cached context and repeated reconnects never remount visible bottom messages", async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const telegramStore = (window as unknown as { __windowStore: { getState: () => TelegramState } }).__windowStore;
    const runtime = window as unknown as { __historyFixture: { calls: number; dispatch: (event: { type: "sync.required" }) => void } };
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const bounds = list.getBoundingClientRect();
    const visible = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
    });
    const positions = visible.map(row => ({ row, top: row.getBoundingClientRect().top }));
    const samples: Array<{ missing: number; remounted: number; shift: number; distance: number }> = [];
    let stop = false;
    const sample = () => {
      samples.push({
        missing: visible.filter(row => !list.querySelector(`[data-message-id="${row.dataset.messageId}"]`)).length,
        remounted: visible.filter(row => !row.isConnected).length,
        shift: Math.max(0, ...positions.map(({ row, top }) => Math.abs(row.getBoundingClientRect().top - top))),
        distance: list.scrollHeight - list.clientHeight - list.scrollTop,
      });
      if (!stop) requestAnimationFrame(() => setTimeout(sample, 0));
    };
    sample();
    const loaded = await telegramStore.getState().loadMessage("chat-product", "115", { forceContext: true });
    const callsBefore = runtime.__historyFixture.calls;
    for (let cycle = 0; cycle < 4; cycle++) {
      runtime.__historyFixture.dispatch({ type: "sync.required" });
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    // The old implementation starts another round after five seconds.
    await new Promise(resolve => setTimeout(resolve, 6200));
    stop = true;
    return { loaded, count: telegramStore.getState().messages.get("chat-product")!.length,
      calls: runtime.__historyFixture.calls - callsBefore,
      recovery: telegramStore.getState().histories.get("chat-product")?.recovery,
      sampleCount: samples.length, missing: Math.max(...samples.map(s => s.missing)),
      remounted: Math.max(...samples.map(s => s.remounted)), shift: Math.max(...samples.map(s => s.shift)),
      distance: Math.max(...samples.map(s => Math.abs(s.distance))),
    };
  });
  expect(result.loaded).toBe(true);
  expect(result.count).toBe(195);
  expect(result.calls).toBe(4);
  expect(result.recovery).toBe("complete");
  expect(result.sampleCount).toBeGreaterThan(100);
  expect(result.missing, JSON.stringify(result)).toBe(0);
  expect(result.remounted, JSON.stringify(result)).toBe(0);
  expect(result.shift, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.distance, JSON.stringify(result)).toBeLessThanOrEqual(1);
});

test("reply navigation selects its context and End restores the latest window", async ({ page }) => {
  await fixture(page);
  await page.locator('[data-message-id="10000"] .message-reply-preview').click();
  await expect(page.locator('[data-message-id="115"]')).toBeVisible();
  await expect(page.locator('.conversation .message-list')).toHaveAttribute("aria-busy", "false");
  const view = await page.evaluate(async () => {
    const telegramStore = (window as unknown as { __windowStore: { getState: () => TelegramState } }).__windowStore;
    return telegramStore.getState().histories.get("chat-product")?.view?.id;
  });
  expect(view).toBe("context:115");
  await page.locator('.message-list').press("End");
  await expect(page.locator('[data-message-id="10000"]')).toBeVisible();
  await expect(page.locator('[data-message-id="115"]')).toHaveCount(0);
  await expect.poll(() => page.locator('.message-list').evaluate(list => list.scrollHeight - list.clientHeight - list.scrollTop)).toBeLessThanOrEqual(1);
});

test("return from a distant reply restores the original detached reading offset", async ({ page }) => {
  await fixture(page);
  const list = page.locator('.message-list');
  await list.hover();
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(450);
  // Use the same public reply path after making its source available above the bottom.
  await page.evaluate(async () => {
    const telegramStore = (window as unknown as { __windowStore: typeof import("../../src/store/telegramStore")["telegramStore"] }).__windowStore;
    const messages = new Map(telegramStore.getState().messages);
    const source = messages.get("chat-product")!;
    messages.set("chat-product", source.map(message => message.id === "9995"
      ? { ...message, replyTo: source.at(-1)!.replyTo } : message));
    telegramStore.setState({ messages });
  });
  await page.waitForTimeout(400);
  const before = await list.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.getBoundingClientRect().top >= bounds.top)!;
    return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - bounds.top };
  });
  await page.locator('[data-message-id="9995"] .message-reply-preview').click();
  await expect(page.locator('[data-message-id="115"]')).toBeVisible();
  await page.getByRole("button", { name: /^返回跳转前位置/ }).click();
  await expect(page.locator(`[data-message-id="${before.id}"]`)).toBeVisible();
  await expect.poll(() => list.evaluate((element, anchor) => {
    const row = element.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
    return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset) : Infinity;
  }, before)).toBeLessThanOrEqual(1);
});
