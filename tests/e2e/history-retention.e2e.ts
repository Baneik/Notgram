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
        const make = id => ({ ...base, id: String(id), renderKey: undefined, outgoing: false,
          senderId: id % 3 ? "u-jules" : "u-alex", interaction: undefined, replyTo: undefined,
          delivery: "sent", isPending: false,
          sentAt: new Date(1700000000000 + id * 60000).toISOString(),
          content: { kind: "text", text: "Retention message " + id + " " + "variable height ".repeat(id % 5 + 1) } });
        const source = Array.from({ length: 12000 }, (_, i) => make(i + 1));
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product"
          ? { ...c, unreadCount: 0, lastReadInboxMessageId: "12000" } : c);
        window.__retentionFixture = { dispatch: listener, make };
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: source.slice(-2400) };
      };
      MockTelegramTransport.prototype.loadChatHistory = async function(...args) {
        if (args[2]?.purpose === "refresh") return read.call(this, args[0], 2400, args[2]);
        return read.apply(this, args);
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator(".message-list").press("End");
  await expect(page.locator('[data-message-id="12000"]')).toBeVisible();
  await page.waitForTimeout(400);
};

const stateCount = (page: Page) => page.evaluate(() =>
  (window as unknown as { __windowStore: { getState: () => TelegramState } }).__windowStore.getState().messages.get("chat-product")!.length);

test("live updates keep the active conversation bounded and following latest", async ({ page }) => {
  await fixture(page);
  for (let round = 0; round < 5; round++) {
    await page.evaluate(round => {
      const fixture = (window as unknown as { __retentionFixture: {
        dispatch: (event: unknown) => void; make: (id: number) => unknown;
      } }).__retentionFixture;
      fixture.dispatch({ type: "messages.upserted", messages: Array.from({ length: 500 }, (_, i) => fixture.make(12001 + round * 500 + i)) });
    }, round);
    await expect.poll(() => stateCount(page)).toBeLessThanOrEqual(2400);
    await expect(page.locator(`[data-message-id="${12500 + round * 500}"]`)).toBeVisible();
    await expect.poll(() => page.locator(".message-list").evaluate(list => list.scrollHeight - list.clientHeight - list.scrollTop)).toBeLessThanOrEqual(1);
  }
});

test("eviction preserves a detached reader frame by frame and newer paging restores the missing interval", async ({ page }) => {
  await fixture(page);
  const list = page.locator(".message-list");
  await list.hover();
  const readingDelta = await list.evaluate(list => 2200 - list.scrollTop);
  await page.mouse.wheel(0, readingDelta);
  await page.waitForTimeout(600);
  const result = await page.evaluate(async () => {
    const store = (window as unknown as { __windowStore: { getState: () => TelegramState } }).__windowStore;
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const bounds = list.getBoundingClientRect();
    const anchor = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => {
      const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
    })!;
    const before = anchor.getBoundingClientRect().top;
    const samples: Array<{ shift: number; missing: boolean }> = [];
    let stop = false;
    const sample = () => {
      const current = list.querySelector<HTMLElement>(`[data-message-id="${anchor.dataset.messageId}"]`);
      samples.push({ shift: current ? Math.abs(current.getBoundingClientRect().top - before) : 0, missing: !current });
      if (!stop) requestAnimationFrame(sample);
    };
    sample();
    await store.getState().loadMoreHistory("chat-product");
    await new Promise(resolve => setTimeout(resolve, 900));
    stop = true;
    const state = store.getState();
    return { anchor: anchor.dataset.messageId, top: list.scrollTop, count: state.messages.get("chat-product")!.length, samples: samples.length,
      missing: samples.some(s => s.missing), shift: Math.max(...samples.map(s => s.shift)),
      context: state.histories.get("chat-product")!.view!.id, hasNewer: state.histories.get("chat-product")!.view!.hasNewer };
  });
  expect(result.count).toBeLessThanOrEqual(2400);
  expect(result.samples).toBeGreaterThan(20);
  expect(result.missing, JSON.stringify(result)).toBe(false);
  expect(result.shift, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.context, JSON.stringify(result)).toMatch(/^retained:/);
  expect(result.hasNewer).toBe(true);
  // Exercise the real wheel path at the newer boundary; it must extend that
  // window rather than enabling bottom following across the evicted gap.
  const previous = await page.evaluate(() => (window as unknown as { __windowStore: { getState: () => TelegramState } })
    .__windowStore.getState().histories.get("chat-product")!.view!.newest!.id);
  const newerDelta = await list.evaluate(list => list.scrollHeight - list.scrollTop);
  await page.mouse.wheel(0, newerDelta);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __windowStore: { getState: () => TelegramState } })
    .__windowStore.getState().histories.get("chat-product")!.view!.newest!.id)).not.toBe(previous);
  await list.press("End");
  await expect(page.locator('[data-message-id="12000"]')).toBeVisible();
});
