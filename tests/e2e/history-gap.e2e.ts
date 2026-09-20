import { expect, test, type Page } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";

const fixture = async (page: Page, forum: boolean, count: number) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const forum = ${forum}, count = ${count};
      const connect = MockTelegramTransport.prototype.connect;
      const read = MockTelegramTransport.prototype.loadChatHistory;
      const topicRead = MockTelegramTransport.prototype.loadForumTopicHistory;
      const makeSource = transport => {
        const base = transport.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        return Array.from({ length: count }, (_, i) => ({ ...base, id: String(i + 1), renderKey: undefined,
          senderId: "u-jules", outgoing: false, delivery: "sent", isPending: false, isPinned: false,
          topicId: forum ? "1" : undefined, sentAt: new Date(1700000000000 + i * 60000).toISOString(),
          content: { kind: "text", text: "overnight history " + (i + 1) },
          replyTo: undefined, interaction: undefined, replyMarkup: undefined }));
      };
      MockTelegramTransport.prototype.loadCachedSnapshot = async function() {
        const persisted = sessionStorage.getItem("overnight-snapshot");
        if (persisted) return JSON.parse(persisted);
        const source = makeSource(this);
        return { version: 4, savedAt: new Date().toISOString(), currentUserId: "u-alex",
          users: this.snapshot.users, folders: this.snapshot.folders,
          chats: this.snapshot.chats.map(c => c.id === "chat-product" ? { ...c, isForum: forum, unreadCount: 0, lastReadInboxMessageId: String(count) } : c),
          messages: [...source.slice(0, 30), ...source.slice(-30)], activeChatId: "chat-product",
          lastForumTopicIds: forum ? [{ chatId: "chat-product", topicId: "1" }] : [] };
      };
      MockTelegramTransport.prototype.saveCachedSnapshot = async function(snapshot) {
        sessionStorage.setItem("overnight-snapshot", JSON.stringify(snapshot));
      };
      MockTelegramTransport.prototype.connect = async function(listener) {
        const source = makeSource(this);
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product" ? { ...c, isForum: forum, unreadCount: 0, lastReadInboxMessageId: String(count) } : c);
        return { ...await connect.call(this, listener), messages: source.slice(-1) };
      };
      for (const [name, original] of [["loadChatHistory", read], ["loadForumTopicHistory", topicRead]]) {
        MockTelegramTransport.prototype[name] = async function(...args) {
          await new Promise(resolve => setTimeout(resolve, 35));
          return original.apply(this, args);
        };
      }
    }` });
  });
  await page.goto("/");
  await expect(page.locator('[data-message-id="' + count + '"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};

const snapshot = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: { getState: () => TelegramState } };
  const { projectHistoryWindow } = await import("/src/store/conversationHistory.ts" as string) as typeof import("../../src/store/conversationHistory");
  const state = telegramStore.getState();
  const history = state.activeTopicId ? state.topicHistories.get(`chat-product:topic:${state.activeTopicId}`) : state.histories.get("chat-product");
  const messages = state.messages.get("chat-product")!.filter(m => !state.activeTopicId || m.topicId === state.activeTopicId);
  return { ids: projectHistoryWindow(messages, history?.view).map(m => Number(m.id)), recovery: history?.recovery,
    loading: history?.loading, hasMore: history?.hasMore };
});

for (const forum of [false, true]) {
  test(`fills the overnight gap and retains it after restart (forum: ${forum})`, async ({ page }) => {
    await fixture(page, forum, 200);
    await expect.poll(async () => (await snapshot(page)).recovery).toBe("complete");
    expect((await snapshot(page)).ids).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    const list = page.locator(".message-list");
    await list.hover();
    await page.mouse.wheel(0, -700);
    await expect(page.locator('[data-message-id="175"]')).toBeVisible();
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: { getState: () => TelegramState } };
      await telegramStore.getState().rebuildCachedSnapshot();
    });
    await page.reload();
    await expect.poll(async () => (await snapshot(page)).recovery).toBe("complete");
    for (let turn = 0; turn < 8; turn++) {
      const current = await snapshot(page);
      expect(current.ids).toEqual(Array.from({ length: 201 - current.ids[0] }, (_, i) => i + current.ids[0]));
      if (current.ids[0] === 1) break;
      await page.locator(".message-list").hover();
      await page.mouse.wheel(0, -100000);
      await expect.poll(async () => (await snapshot(page)).ids[0]).toBeLessThan(current.ids[0]);
    }
    expect((await snapshot(page)).ids[0]).toBe(1);
  });

  test(`upward scrolling resumes a gap larger than the background budget (forum: ${forum})`, async ({ page }) => {
    await fixture(page, forum, 1200);
    await expect.poll(async () => (await snapshot(page)).recovery).toBe("paused");
    expect((await snapshot(page)).ids).toEqual(Array.from({ length: 270 }, (_, i) => i + 931));
    for (let turn = 0; turn < 7; turn++) {
      const current = await snapshot(page);
      expect(current.ids).toEqual(Array.from({ length: 1201 - current.ids[0] }, (_, i) => i + current.ids[0]));
      if (current.ids[0] === 1) break;
      await page.locator(".message-list").hover();
      await page.mouse.wheel(0, -100000);
      await expect.poll(async () => (await snapshot(page)).ids[0]).toBeLessThan(current.ids[0]);
      await expect.poll(async () => (await snapshot(page)).recovery).not.toBe("refreshing");
    }
    expect((await snapshot(page)).ids).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
  });
}
