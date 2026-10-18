import { expect, test, type Page } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";

const installEntryGap = async (page: Page) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const history = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      window.entryHistoryReads = 0;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const source = Array.from({ length: 1200 }, (_, i) => ({
          id: "entry-" + (i + 1), chatId: "chat-mia", senderId: "u-mia", outgoing: false,
          sentAt: new Date(1700000000000 + i * 60000).toISOString(), delivery: "read",
          content: { kind: "text", text: "Entry history message " + (i + 1) + " with variable height ".repeat(i % 4 + 1) }
        }));
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-mia"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-mia"
          ? { ...c, unreadCount: 0, lastReadInboxMessageId: "entry-1200" } : c);
        window.sendEntryMessage = () => {
          const message = { ...source.at(-1), id: "entry-1201", sentAt: new Date(1700000000000 + 1200 * 60000).toISOString() };
          listener({ type: "message.upsert", message });
        };
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: [...snapshot.messages.filter(m => m.chatId !== "chat-mia"),
          ...source.slice(0, 10), source.at(-1)] };
      };
      MockTelegramTransport.prototype.loadChatHistory = async function(chatId, ...args) {
        if (chatId === "chat-mia") {
          window.entryHistoryReads++;
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        return history.call(this, chatId, ...args);
      };
    }` });
  });
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 900) < 600) await page.getByRole("button", { name: /^产品讨论/ }).click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  if ((page.viewportSize()?.width ?? 900) < 600) await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};

const entryState = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: { getState: () => TelegramState } };
  const { projectHistoryWindow } = await import("/src/store/conversationHistory.ts" as string) as typeof import("../../src/store/conversationHistory");
  const state = telegramStore.getState();
  const history = state.histories.get("chat-mia");
  return { recovery: history?.recovery, ids: projectHistoryWindow(state.messages.get("chat-mia") ?? [], history?.view).map(m => m.id),
    reads: (window as unknown as { entryHistoryReads: number }).entryHistoryReads };
});

for (const { width, cpu } of [{ width: 1366, cpu: 1 }, { width: 390, cpu: 1 }, { width: 1366, cpu: 4 }]) {
  test(`idle entry keeps history and scrollbar stable until upward input at ${width}px, CPU ${cpu}x`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    if (cpu > 1) {
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    }
    await installEntryGap(page);
    await expect.poll(async () => (await entryState(page)).recovery).toBe("paused");
    expect(await entryState(page)).toMatchObject({ reads: 1, ids: Array.from({ length: 30 }, (_, i) => `entry-${1171 + i}`) });
    await expect(page.locator('[data-message-id="entry-1200"]')).toBeInViewport();
    await expect(page.locator(".message-list-content")).toHaveCSS("opacity", "1");
    const frames = await page.locator(".message-list").evaluate(async list => {
      const samples: Array<{ height: number; gap: number; blank: boolean; covered: boolean }> = [];
      const start = performance.now();
      while (performance.now() - start < 1200) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const bounds = list.getBoundingClientRect();
        samples.push({ height: list.scrollHeight, gap: list.scrollHeight - list.clientHeight - list.scrollTop,
          blank: ![...list.querySelectorAll("[data-message-id]")].some(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          }), covered: Boolean(document.querySelector("[data-conversation-history-snapshot]")) });
      }
      return samples;
    });
    expect(frames.length).toBeGreaterThan(10);
    expect(Math.max(...frames.map(f => f.height)) - Math.min(...frames.map(f => f.height))).toBeLessThanOrEqual(1);
    expect(Math.max(...frames.map(f => Math.abs(f.gap)))).toBeLessThanOrEqual(1);
    expect(frames.some(f => f.blank || f.covered)).toBe(false);
    expect((await entryState(page)).reads).toBe(1);
    await page.screenshot({ path: `test-results/history-idle-entry-${width}.png` });
    await page.locator(".message-list").hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(async () => (await entryState(page)).ids.length).toBe(60);
    await page.waitForTimeout(700);
    expect((await entryState(page)).reads).toBe(2);
    await page.locator(".message-list").press("End");
    await expect(page.locator('[data-message-id="entry-1200"]')).toBeInViewport();
    await page.evaluate(() => (window as unknown as { sendEntryMessage: () => void }).sendEntryMessage());
    await expect(page.locator('[data-message-id="entry-1201"]')).toBeInViewport();
    expect((await entryState(page)).reads).toBe(2);
  });
}

for (const input of ["wheel", "keyboard"]) {
  test(`a short timeline waits for explicit ${input} input before paging`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 3000 });
    await installEntryGap(page);
    await expect.poll(async () => (await entryState(page)).recovery).toBe("paused");
    const list = page.locator(".message-list");
    expect(await list.evaluate(list => list.scrollHeight - list.clientHeight)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(700);
    expect((await entryState(page)).reads).toBe(1);
    if (input === "wheel") {
      await list.hover();
      await page.mouse.wheel(0, -1000);
    } else await list.press("PageUp");
    await expect.poll(async () => (await entryState(page)).ids.length).toBe(60);
    await page.waitForTimeout(700);
    expect((await entryState(page)).reads).toBe(2);
  });
}
