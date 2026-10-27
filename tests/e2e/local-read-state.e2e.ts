import { expect, test, type Page } from "@playwright/test";

const fixture = async (page: Page) => {
  await page.addInitScript(() => {
    const key = "notgram:preferences:v1";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ blockReadReceipts: true }));
    const runtime = globalThis as unknown as { __localBadgeHistory: number[] };
    runtime.__localBadgeHistory = [];
    new MutationObserver(() => {
      const badge = document.querySelector('.chat-list[data-active=true] [data-chat-id="chat-mia"] .unread-count');
      const count = Number(badge?.textContent ?? 0);
      if (runtime.__localBadgeHistory.at(-1) !== count) runtime.__localBadgeHistory.push(count);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}
      {
        const connect = MockTelegramTransport.prototype.connect;
        globalThis.__localServerReads = [];
        globalThis.__localForumQueryCount = 0;
        const getTopics = MockTelegramTransport.prototype.getForumTopics;
        MockTelegramTransport.prototype.getForumTopics = async function(input) {
          const result = await getTopics.call(this, input);
          if (input.chatId === "chat-forum") {
            globalThis.__localForumQueryCount++;
            // Model reply hydration after a topic preview refresh, as in TDLib.
            const message = this.snapshot.messages.find(message => message.chatId === input.chatId && message.topicId === "12");
            if (message) this.listener?.({ type: "message.upsert", message: structuredClone(message) });
          }
          return result;
        };
        for (const name of ["markChatRead", "markForumTopicRead", "markMessageThreadRead", "viewChannelMessages", "markMessageAttentionRead", "markAllChatReactionsRead"]) {
          const original = MockTelegramTransport.prototype[name];
          MockTelegramTransport.prototype[name] = function(...args) {
            globalThis.__localServerReads.push(name);
            return original.apply(this, args);
          };
        }
        MockTelegramTransport.prototype.connect = async function(listener, options) {
          globalThis.__localReadFixture = this;
          const base = this.snapshot.messages.find(message => message.chatId === "chat-mia" && message.content.kind === "text");
          const extra = Number(localStorage.getItem("local-read-offline-count") || 0);
          const messages = Array.from({ length: 120 + extra }, (_, index) => ({ ...base,
            id: String(1001 + index), outgoing: false, topicId: undefined, renderKey: undefined,
            sentAt: new Date(1700000000000 + index * 1000).toISOString(), delivery: "read",
            containsUnreadMention: false, containsUnreadReaction: false, replyTo: undefined, interaction: undefined,
            content: { kind: "text", text: "Private reading " + (1001 + index) }
          }));
          this.snapshot.messages = [...this.snapshot.messages.filter(message => message.chatId !== "chat-mia"), ...messages];
          this.snapshot.chats = this.snapshot.chats.map(chat => chat.id === "chat-mia"
            ? { ...chat, unreadCount: 120 + extra, unreadMentionCount: 0, unreadReactionCount: 0, lastReadInboxMessageId: "1000" } : chat);
          return connect.call(this, listener, options);
        };
      }
    ` });
  });
};
const storeCount = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
  return telegramStore.getState().chats.get("chat-mia")?.unreadCount;
});

for (const width of [1366, 390]) {
  for (const extra of [0, 3]) {
    test(`local reads survive cache clearing and restart with ${extra} offline messages at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await fixture(page);
      await page.goto("/");
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
      await expect(page.locator('[data-message-id="1120"]')).toBeVisible();
      await expect.poll(() => storeCount(page)).toBe(0);
      await expect.poll(() => page.evaluate(() => localStorage.getItem("notgram:local-read-state:v1"))).toContain('"id":"1120"');
      await page.evaluate(async offlineCount => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        telegramStore.getState().selectChat("chat-product");
        const runtime = globalThis as unknown as { __localReadFixture: { clearCachedSnapshot(): Promise<void> }; __localServerReads: string[] };
        await runtime.__localReadFixture.clearCachedSnapshot();
        localStorage.setItem("local-read-offline-count", String(offlineCount));
        if (runtime.__localServerReads.length) throw new Error("Read receipt escaped the local policy");
      }, extra);
      await page.reload();
      await expect.poll(() => storeCount(page)).toBe(extra);
      const back = page.getByRole("button", { name: "返回会话列表", exact: true });
      if (await back.isVisible()) await back.click();
      const row = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');
      await expect(row).toBeVisible();
      if (extra) await expect(row.locator(".unread-count")).toHaveText(String(extra));
      else await expect(row.locator(".unread-count")).toHaveCount(0);
      const result = await page.evaluate(() => {
        const runtime = globalThis as unknown as { __localBadgeHistory: number[]; __localServerReads: string[] };
        return { counts: runtime.__localBadgeHistory, reads: runtime.__localServerReads };
      });
      expect(result.counts).not.toContain(120 + extra);
      expect(result.reads).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("local-read-restart.png") });
    });
  }
}

test("the read receipt switch is opt-in, persists, and updates the main window from standalone settings", async ({ page, context }) => {
  await page.goto("/");
  const settings = await context.newPage();
  await settings.goto("/windows/settings-window.html");
  await settings.getByRole("button", { name: "Notgram", exact: true }).click();
  const toggle = settings.getByRole("switch", { name: "屏蔽已读上报", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(() => page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    return preferencesStore.getState().blockReadReceipts;
  })).toBe(true);
  await settings.reload();
  await settings.getByRole("button", { name: "Notgram", exact: true }).click();
  await expect(toggle).toBeChecked();
  await settings.close();
});

for (const width of [1366, 390]) {
  test(`local forum counts settle while typing and switching topics at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    await page.goto("/");
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
    await expect(page.locator('[data-message-id="forum-general-1"]')).toBeVisible();
    const tab = (id: string) => page.locator(`.forum-topic-strip [data-topic-id="${id}"]`);
    await tab("12").click();
    const input = page.getByRole("textbox", { name: "消息" });
    await expect(input).toBeFocused();
    await expect.poll(() => page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.unreadCount;
    })).toBe(0);
    await page.waitForTimeout(800);
    const queries = () => page.evaluate(() => (globalThis as unknown as { __localForumQueryCount: number }).__localForumQueryCount);
    const settled = await queries();
    expect(settled).toBeGreaterThan(0);
    await input.fill("Responsive local forum draft");
    await tab("1").click();
    await tab("12").click();
    await expect(input).toBeFocused();
    await expect(input).toHaveText("Responsive local forum draft");
    await page.waitForTimeout(1_200);
    expect(await queries()).toBe(settled);
    expect(await page.evaluate(() => (globalThis as unknown as { __localServerReads: string[] }).__localServerReads)).toEqual([]);
  });
}
