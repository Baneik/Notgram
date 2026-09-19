import { expect, test, type Page } from "@playwright/test";

const fixture = async (page: Page, mode: "delayed" | "retry" | "ready" | "delayed-read" | "visible" = "delayed") => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const search = MockTelegramTransport.prototype.searchChatMessages;
      const read = MockTelegramTransport.prototype.markMessageAttentionRead;
      let searches = 0;
      globalThis.__mentionReads = [];
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const source = Array.from({length:180}, (_, i) => ({
          ...base, id:String(1000+i), renderKey:undefined, senderId:"u-mia", outgoing:false,
          sentAt:new Date(1700000000000+i*1000).toISOString(), delivery:"read", isPinned:false,
          replyMarkup:undefined, forwardInfo:undefined, mediaAlbumId:undefined, interaction:undefined,
          replyTo:i===80 ? {kind:"message",messageId:"999",outgoing:true,text:"My earlier message"} : undefined,
          containsUnreadMention:${JSON.stringify(mode)}==="visible" ? i===179 : i===20 || i===80, containsUnreadReaction:false,
          content:{kind:"text",text:"Synthetic mention history " + i + "\\nSecond line of the message"}
        }));
        this.snapshot.messages = [...this.snapshot.messages.filter(m=>m.chatId!=="chat-product"),...source];
        this.snapshot.chats = this.snapshot.chats.map(c=>c.id==="chat-product"
          ? {...c,unreadCount:0,unreadMentionCount:${mode === "visible" ? 1 : 2},lastReadInboxMessageId:"1179"} : c);
        globalThis.__clearMentions = () => {
          const chat = this.snapshot.chats.find(c=>c.id==="chat-product");
          chat.unreadMentionCount=0;
          for(const message of source) message.containsUnreadMention=false;
          listener({type:"chat.upsert",chat:structuredClone(chat)});
        };
        return connect.call(this,listener);
      };
      MockTelegramTransport.prototype.searchChatMessages = async function(input) {
        if (input.filter==="unreadMention" && input.chatId==="chat-product") {
          searches++;
          if (${JSON.stringify(mode)}==="retry" && searches===1) throw new Error("Synthetic mention search failure");
          if (${JSON.stringify(mode)}==="delayed" && searches===1)
            await new Promise(resolve => { globalThis.__releaseMentions=resolve; });
        }
        return search.call(this,input);
      };
      MockTelegramTransport.prototype.markMessageAttentionRead = async function(chatId, ids) {
        globalThis.__mentionReads.push([...ids]);
        if (${JSON.stringify(mode)}==="delayed-read" && globalThis.__mentionReads.length===1)
          await new Promise(resolve => { globalThis.__releaseMentionRead=resolve; });
        return read.call(this,chatId,ids);
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="1179"]')).toBeVisible();
};

const button = (page: Page) => page.locator(".jump-to-attention");
const badge = (page: Page) => page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"] .unread-count');
const reads = (page: Page) => page.evaluate(() => (globalThis as unknown as { __mentionReads: string[][] }).__mentionReads);
const release = (page: Page) => page.evaluate(() => (globalThis as unknown as { __releaseMentions: () => void }).__releaseMentions());

test("server mentions outside history remain reachable and clear with the sidebar after viewing", async ({ page }) => {
  await fixture(page);
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，2 条待查看");
  await expect(badge(page)).toHaveClass(/has-attention/);
  await expect(badge(page)).toHaveText("2");
  expect(await reads(page)).toEqual([]);
  await button(page).click();
  await release(page);
  await expect(page.locator('[data-message-id="1080"]')).toHaveClass(/is-notification-target/);
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，1 条待查看");
  await expect(badge(page)).toHaveText("1");
  expect((await reads(page)).flat()).toEqual(["1080"]);
  await button(page).click();
  await expect(page.locator('[data-message-id="1020"]')).toHaveClass(/is-notification-target/);
  await expect(button(page)).toHaveCount(0);
  await expect(badge(page)).toHaveCount(0);
  expect((await reads(page)).flat()).toEqual(["1080", "1020"]);
});

test("a failed mention recovery preserves the button and retries on click", async ({ page }) => {
  await fixture(page, "retry");
  await expect(page.getByText("Synthetic mention search failure")).toBeVisible();
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，2 条待查看");
  await button(page).click();
  await expect(page.locator('[data-message-id="1080"]')).toHaveClass(/is-notification-target/);
  await expect(badge(page)).toHaveText("1");
});

test("a delayed mention jump cannot reopen a conversation after switching away", async ({ page }) => {
  await fixture(page);
  await button(page).click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await release(page);
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().unreadAttentionMessageIds.get("chat-product")?.length;
  })).toBe(2);
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]')).toHaveAttribute("aria-current", "true");
  expect(await reads(page)).toEqual([]);
});

test("a remote read clears both indicators without viewing the old mentions", async ({ page }) => {
  await fixture(page, "ready");
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，2 条待查看");
  await page.evaluate(() => (globalThis as unknown as { __clearMentions: () => void }).__clearMentions());
  await expect(button(page)).toHaveCount(0);
  await expect(badge(page)).toHaveCount(0);
  expect(await reads(page)).toEqual([]);
});

test("both indicators survive a pending read confirmation without duplicate requests", async ({ page }) => {
  await fixture(page, "delayed-read");
  await button(page).click();
  await expect(page.locator('[data-message-id="1080"]')).toHaveClass(/is-notification-target/);
  await expect.poll(() => reads(page)).toEqual([["1080"]]);
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，2 条待查看");
  await expect(badge(page)).toHaveText("2");
  await page.getByRole("textbox", { name: "消息内容" }).focus();
  await page.evaluate(() => (globalThis as unknown as { __releaseMentionRead: () => void }).__releaseMentionRead());
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，1 条待查看");
  await expect(badge(page)).toHaveText("1");
  expect(await reads(page)).toEqual([["1080"]]);
});

test("a visible historical mention is acknowledged only with conversation focus", async ({ page }) => {
  await page.addInitScript(() => { document.hasFocus = () => false; });
  await fixture(page, "visible");
  await expect(button(page)).toHaveAccessibleName("跳到提及或引用，1 条待查看");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').focus();
  await page.evaluate(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event("focus"));
  });
  expect(await reads(page)).toEqual([]);
  await expect(badge(page)).toHaveText("1");
  await page.getByRole("textbox", { name: "消息内容" }).focus();
  await expect(button(page)).toHaveCount(0);
  await expect(badge(page)).toHaveCount(0);
  expect(await reads(page)).toEqual([["1179"]]);
});
