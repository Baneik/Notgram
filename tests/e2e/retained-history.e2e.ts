import { expect, test, type Page } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";

const fixture = async (page: Page, forum = false) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const forum = ${forum};
      const connect = MockTelegramTransport.prototype.connect;
      const read = MockTelegramTransport.prototype.loadChatHistory;
      const forumRead = MockTelegramTransport.prototype.loadForumTopicHistory;
      const makeSource = transport => {
        const base = transport.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        return Array.from({ length: 360 }, (_, i) => ({ ...base, id: String(i + 1), renderKey: undefined,
          senderId: "u-jules", outgoing: false, delivery: "sent", isPending: false, isPinned: false,
          topicId: forum ? "1" : undefined,
          sentAt: new Date(1700000000000 + i * 60000).toISOString(),
          content: { kind: "text", text: "history row " + (i + 1) },
          replyTo: undefined, interaction: undefined, replyMarkup: undefined,
          ...(i % 3 === 0 ? { isLocallyDeleted: true, locallyDeletedAt: new Date().toISOString() } : {}) }));
      };
      MockTelegramTransport.prototype.loadCachedSnapshot = async function() {
        const source = makeSource(this);
        return { version: 4, savedAt: new Date().toISOString(), currentUserId: "u-alex",
          users: this.snapshot.users, folders: this.snapshot.folders,
          chats: this.snapshot.chats.map(c => c.id === "chat-product" ? { ...c, isForum: forum, unreadCount: 0, lastReadInboxMessageId: "360" } : c),
          messages: source.filter(m => !m.isLocallyDeleted).slice(-60),
          locallyDeletedMessages: source.filter(m => m.isLocallyDeleted), activeChatId: "chat-product",
          lastForumTopicIds: forum ? [{ chatId: "chat-product", topicId: "1" }] : [],
        };
      };
      MockTelegramTransport.prototype.connect = async function(listener) {
        const source = makeSource(this).filter(m => !m.isLocallyDeleted);
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product" ? { ...c, isForum: forum, unreadCount: 0, lastReadInboxMessageId: "360" } : c);
        globalThis.__retainedHistory = { calls: [], dispatch: listener };
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: source.slice(-30) };
      };
      for (const [name, original] of [["loadChatHistory", read], ["loadForumTopicHistory", forumRead]]) {
        MockTelegramTransport.prototype[name] = async function(...args) {
          if (args[0] === "chat-product") globalThis.__retainedHistory.calls.push(args.at(-1));
          await new Promise(resolve => setTimeout(resolve, 35));
          return original.apply(this, args);
        };
      }
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="360"]')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: { getState: () => TelegramState } };
    const s = telegramStore.getState();
    return (s.activeTopicId ? s.topicHistories.get(`${s.activeChatId}:topic:${s.activeTopicId}`) : s.histories.get(s.activeChatId!))?.recovery;
  })).toBe("complete");
};

const snapshot = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as { telegramStore: { getState: () => TelegramState } };
  const { projectHistoryWindow } = await import("/src/store/conversationHistory.ts" as string) as typeof import("../../src/store/conversationHistory");
  const s = telegramStore.getState();
  const state = s.activeTopicId ? s.topicHistories.get(`${s.activeChatId}:topic:${s.activeTopicId}`) : s.histories.get(s.activeChatId!);
  const cached = s.messages.get("chat-product")!.filter(m => !s.activeTopicId || m.topicId === s.activeTopicId);
  const visible = projectHistoryWindow(cached, state?.view);
  return { first: Number(visible[0]?.id), ids: visible.map(m => Number(m.id)),
    archives: cached.filter(m => m.isLocallyDeleted).length, loading: state?.loading, hasMore: state?.hasMore,
    calls: (window as unknown as { __retainedHistory: { calls: unknown[] } }).__retainedHistory.calls.length };
});

for (const forum of [false, true]) {
  test(`restored archives stay interleaved through every upward history page (forum: ${forum})`, async ({ page }) => {
    await fixture(page, forum);
    const initial = await snapshot(page);
    expect(initial.first).toBe(272);
    expect(initial.archives).toBe(120);
    const list = page.locator(".message-list");
    for (let turn = 0; turn < 10; turn++) {
      const before = await snapshot(page);
      if (!before.hasMore) break;
      await list.hover();
      await page.mouse.wheel(0, -100000);
      await expect.poll(async () => {
        const state = await snapshot(page);
        return !state.loading && (state.first < before.first || !state.hasMore);
      }).toBe(true);
      const after = await snapshot(page);
      expect(after.ids).toEqual(Array.from({ length: 361 - after.first }, (_, i) => i + after.first));
      expect(after.archives).toBe(120);
      await expect(list).toHaveAttribute("aria-busy", "false");
    }
    const final = await snapshot(page);
    expect(final.hasMore).toBe(false);
    expect(final.ids).toEqual(Array.from({ length: 360 }, (_, i) => i + 1));
    expect(final.calls).toBeLessThanOrEqual(10);
    await list.hover();
    await page.mouse.wheel(0, -100000);
    await expect(page.locator('[data-message-id="1"]')).toBeVisible();
    await expect(page.locator('[data-message-id="2"]')).toBeVisible();
  });
}

test("reconnect preserves the archive frontier and the reader's older cursor", async ({ page }) => {
  await fixture(page);
  const list = page.locator(".message-list");
  await list.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(async () => (await snapshot(page)).first).toBeLessThan(272);
  const before = await snapshot(page);
  await page.evaluate(() => {
    const runtime = window as unknown as { __retainedHistory: { dispatch: (event: { type: "sync.required" }) => void } };
    runtime.__retainedHistory.dispatch({ type: "sync.required" });
  });
  await expect.poll(async () => (await snapshot(page)).calls).toBeGreaterThan(before.calls);
  await expect.poll(async () => (await snapshot(page)).loading).toBe(false);
  expect((await snapshot(page)).ids).toEqual(before.ids);
  await list.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(async () => (await snapshot(page)).first).toBeLessThan(before.first);
});

test("a reply can open a retained copy outside latest and return without exposing an archive-only gap", async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "360" ? { ...message,
      replyTo: { kind: "message", chatId: "chat-product", messageId: "10", senderId: "u-jules",
        content: { kind: "text", text: "history row 10" } } } : message));
    telegramStore.setState({ messages });
  });
  await page.locator('[data-message-id="360"] .message-reply-preview').click();
  await expect(page.locator('[data-message-id="10"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect((await snapshot(page)).archives).toBe(120);
  await page.locator(".message-list").press("End");
  await expect(page.locator('[data-message-id="360"]')).toBeVisible();
  await expect(page.locator('[data-message-id="10"]')).toHaveCount(0);
  expect((await snapshot(page)).first).toBe(272);
});
