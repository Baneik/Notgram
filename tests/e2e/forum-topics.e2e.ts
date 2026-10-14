import { expect, test, type Page } from "@playwright/test";

const storePath = "/src/store/telegramStore.ts";
const openForum = async (page: Page) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect(page.locator('[data-message-id="forum-general-1"]')).toBeVisible();
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().forumTopicsLoading.has("chat-forum");
  }, storePath)).toBe(false);
};
const tab = (page: Page, id: string) => page.locator(`.forum-topic-strip [data-topic-id="${id}"]`);
const input = (page: Page) => page.getByRole("textbox", { name: "消息" });

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`restarted read topics repair the sidebar despite metadata updates at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/src/telegram/mockTransport.ts", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}
        const connectForRestart = MockTelegramTransport.prototype.connect;
        MockTelegramTransport.prototype.connect = function (...args) {
          this.snapshot.chats.find(chat => chat.id === "chat-forum").unreadMentionCount = 0;
          return connectForRestart.apply(this, args);
        };
        const getTopicsForRestart = MockTelegramTransport.prototype.getForumTopics;
        MockTelegramTransport.prototype.getForumTopics = async function (...args) {
          const result = await getTopicsForRestart.apply(this, args);
          const chat = this.snapshot.chats.find(chat => chat.id === args[0].chatId);
          if (chat) this.listener?.({ type: "chat.upsert", chat: { ...structuredClone(chat), memberCount: 2 } });
          return { ...result, topics: result.topics.map(topic => ({ ...topic, unreadCount: 0 })) };
        };
        const markChatReadForRestart = MockTelegramTransport.prototype.markChatRead;
        MockTelegramTransport.prototype.markChatRead = async function (chatId) {
          if (chatId === "chat-forum") throw new Error("Unexpected group read in a topic");
          return markChatReadForRestart.call(this, chatId);
        };` });
    });
    await openForum(page);
    const expectReadForum = async () => {
      await expect(tab(page, "1")).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => page.evaluate(async path => {
        const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
        const state = telegramStore.getState();
        return { unread: state.chats.get("chat-forum")?.unreadCount,
          memberCount: state.chats.get("chat-forum")?.memberCount, error: state.operationError };
      }, storePath)).toEqual({ unread: 0, memberCount: 2, error: undefined });
      if (viewport.width === 1366) {
        await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"] .unread-count')).toHaveCount(0);
      }
      await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "false");
    };
    await expectReadForum();
    await page.reload();
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
    await expect(page.locator('[data-message-id="forum-general-1"]')).toBeVisible();
    await expectReadForum();
  });

  test(`late group counts converge after reading a topic and preserve other unread topics at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/src/telegram/mockTransport.ts", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}
        const connectForLateCount = MockTelegramTransport.prototype.connect;
        MockTelegramTransport.prototype.connect = function (...args) {
          this.snapshot.chats.find(chat => chat.id === "chat-forum").unreadMentionCount = 0;
          this.snapshot.chats.find(chat => chat.id === "chat-forum").unreadCount = 3;
          this.ensureForumTopics("chat-forum").find(topic => topic.id === "18").unreadCount = 0;
          window.injectLateForumMessage = () => {
            const source = this.snapshot.messages.find(message => message.id === "forum-release-1");
            const message = { ...source, id: "late-topic-incoming", sentAt: "2026-08-01T10:00:00+08:00" };
            this.snapshot.messages.push(message);
            this.listener?.({ type: "message.upsert", message, animateEntrance: true });
          };
          window.injectOtherForumMessage = () => {
            const source = this.snapshot.messages.find(message => message.id === "forum-release-1");
            const message = { ...source, id: "other-topic-incoming", topicId: "18", sentAt: "2026-08-01T10:01:00+08:00" };
            this.snapshot.messages.push(message);
            const topic = this.ensureForumTopics("chat-forum").find(topic => topic.id === "18");
            topic.unreadCount = 1;
            topic.lastReadInboxMessageId = undefined;
            const chat = this.snapshot.chats.find(chat => chat.id === "chat-forum");
            chat.unreadCount = 5;
            this.listener?.({ type: "chat.upsert", chat: structuredClone(chat) });
            this.listener?.({ type: "message.upsert", message, animateEntrance: true });
            this.listener?.({ type: "forumTopics.changed", chatId: "chat-forum", topic: { id: "18", unreadCount: 1 } });
          };
          return connectForLateCount.apply(this, args);
        };
        MockTelegramTransport.prototype.markForumTopicRead = async function (chatId, topicId, messageId) {
          const topic = this.ensureForumTopics(chatId).find(topic => topic.id === topicId);
          topic.unreadCount = 0;
          topic.lastReadInboxMessageId = messageId;
          this.listener?.({ type: "forumTopics.changed", chatId, topic: { id: topicId, lastReadInboxMessageId: messageId } });
          if (messageId === "late-topic-incoming") window.publishLateForumCount = () => {
            const chat = this.snapshot.chats.find(chat => chat.id === chatId);
            chat.unreadCount = 4;
            this.listener?.({ type: "chat.upsert", chat: structuredClone(chat) });
          };
        };
        const markChatReadForLateCount = MockTelegramTransport.prototype.markChatRead;
        MockTelegramTransport.prototype.markChatRead = async function (chatId) {
          if (chatId === "chat-forum") throw new Error("Unexpected group read in a topic");
          return markChatReadForLateCount.call(this, chatId);
        };` });
    });
    const unreadCount = () => page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
    }, storePath);
    await openForum(page);
    await tab(page, "12").click();
    await expect.poll(unreadCount).toBe(0);
    await page.evaluate(() => (window as unknown as { injectLateForumMessage: () => void }).injectLateForumMessage());
    await expect(page.locator('[data-message-id="late-topic-incoming"]')).toBeVisible();
    await expect.poll(() => page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().forumTopics.get("chat-forum")?.find(topic => topic.id === "12")?.lastReadInboxMessageId;
    }, storePath)).toBe("late-topic-incoming");
    await page.evaluate(() => (window as unknown as { publishLateForumCount: () => void }).publishLateForumCount());
    await expect.poll(unreadCount).toBe(0);
    await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "false");
    if (viewport.width === 1366) {
      await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"] .unread-count')).toHaveCount(0);
    }
    await page.evaluate(() => (window as unknown as { injectOtherForumMessage: () => void }).injectOtherForumMessage());
    await expect(tab(page, "18").locator(".forum-topic-tab-count")).toHaveText("1");
    await expect.poll(unreadCount).toBe(1);
    await tab(page, "18").click();
    await expect(page.locator('[data-message-id="other-topic-incoming"]')).toBeVisible();
    await expect.poll(unreadCount).toBe(0);
    await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "false");
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  for (const refreshedCount of [false, true]) {
    test(`pending topic reads retain their group deduction after a new message at ${viewport.width}px (count refresh: ${refreshedCount})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.route("**/src/telegram/mockTransport.ts", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: `${await response.text()}
          const connectForPendingRead = MockTelegramTransport.prototype.connect;
          MockTelegramTransport.prototype.connect = function (...args) {
            this.snapshot.chats.find(chat => chat.id === "chat-forum").unreadMentionCount = 0;
            const source = this.snapshot.messages.find(message => message.id === "forum-release-1");
            this.snapshot.messages.push({ ...source, id: "design-incoming", topicId: "18",
              sentAt: "2026-08-01T09:50:00+08:00" });
            return connectForPendingRead.apply(this, args);
          };
          MockTelegramTransport.prototype.markForumTopicRead = async function (chatId, topicId, messageId) {
            const topic = this.ensureForumTopics(chatId).find(item => item.id === topicId);
            topic.lastReadInboxMessageId = messageId;
            this.listener?.({ type: "forumTopics.changed", chatId,
              topic: { id: topicId, lastReadInboxMessageId: messageId } });
            if (topicId !== "12" || this.pendingTopicReadStarted) return;
            this.pendingTopicReadStarted = true;
            const chat = this.snapshot.chats.find(chat => chat.id === chatId);
            chat.unreadCount += 1;
            this.listener?.({ type: "chat.upsert", chat: structuredClone(chat) });
            const source = this.snapshot.messages.find(message => message.id === messageId);
            const incoming = { ...source, id: "pending-read-incoming", sentAt: "2026-08-01T10:00:00+08:00" };
            this.snapshot.messages.push(incoming);
            ${refreshedCount ? `topic.unreadCount = 1;
              this.listener?.({ type: "forumTopics.changed", chatId,
                topic: { id: topicId, lastReadInboxMessageId: messageId, unreadCount: 1 } });` : ""}
            this.listener?.({ type: "message.upsert", message: incoming, animateEntrance: true });
            await new Promise(resolve => { window.releasePendingTopicRead = resolve; });
          };` });
      });
      await openForum(page);
      await tab(page, "12").click();
      await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releasePendingTopicRead?: () => void }).releasePendingTopicRead)).toBe("function");
      await expect.poll(() => page.evaluate(async path => {
        const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
        return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
      }, storePath)).toBe(5);
      await expect(page.locator('[data-message-id="pending-read-incoming"]')).toBeVisible();
      await page.evaluate(() => (window as unknown as { releasePendingTopicRead: () => void }).releasePendingTopicRead());
      const sidebar = page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]');
      await expect.poll(() => page.evaluate(async path => {
        const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
        return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
      }, storePath)).toBe(1);
      if (viewport.width === 1366) await expect(sidebar.locator(".unread-count")).toHaveText("1");
      await expect(tab(page, "12").locator(".forum-topic-tab-count")).toBeHidden();
      await expect(tab(page, "18").locator(".forum-topic-tab-count")).toHaveText("1");
      await tab(page, "18").click();
      await expect(sidebar.locator(".unread-count")).toHaveCount(0);
      await expect.poll(() => page.evaluate(async path => {
        const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
        return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
      }, storePath)).toBe(0);
      await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "false");
    });
  }
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`topic reads clear the sidebar badge without All or a group read update at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/src/telegram/mockTransport.ts", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}
        const connectForTopicRead = MockTelegramTransport.prototype.connect;
        MockTelegramTransport.prototype.connect = function (...args) {
          this.snapshot.chats.find(chat => chat.id === "chat-forum").unreadMentionCount = 0;
          const source = this.snapshot.messages.find(message => message.id === "forum-release-1");
          this.snapshot.messages.push({ ...source, id: "design-incoming", topicId: "18",
            sentAt: "2026-08-01T09:50:00+08:00" });
          return connectForTopicRead.apply(this, args);
        };
        MockTelegramTransport.prototype.markForumTopicRead = async function (chatId, topicId, messageId) {
          const topic = this.ensureForumTopics(chatId).find(item => item.id === topicId);
          // TDLib acknowledges only the topic boundary; the group count stays stale.
          topic.lastReadInboxMessageId = messageId;
          this.listener?.({ type: "forumTopics.changed", chatId,
            topic: { id: topicId, lastReadInboxMessageId: messageId } });
        };` });
    });
    await openForum(page);
    const sidebar = page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]');
    if (viewport.width === 1366) await expect(sidebar.locator(".unread-count")).toHaveText("4");
    else await expect.poll(() => page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
    }, storePath)).toBe(4);
    await tab(page, "12").click();
    if (viewport.width === 1366) await expect(sidebar.locator(".unread-count")).toHaveText("1");
    else await expect.poll(() => page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
    }, storePath)).toBe(1);
    await expect(tab(page, "18").locator(".forum-topic-tab-count")).toHaveText("1");
    await tab(page, "18").click();
    if (viewport.width === 1366) await expect(sidebar.locator(".unread-count")).toHaveCount(0);
    else await expect.poll(() => page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().chats.get("chat-forum")?.unreadCount;
    }, storePath)).toBe(0);
    await expect(tab(page, "18")).toHaveAttribute("aria-selected", "true");
    await page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      await telegramStore.getState().loadForumTopics("chat-forum");
    }, storePath);
    await expect(sidebar.locator(".unread-count")).toHaveCount(0);
    await tab(page, "12").click();
    await expect(sidebar.locator(".unread-count")).toHaveCount(0);
    if (viewport.width === 1366) {
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
      await sidebar.click();
      await expect(tab(page, "12")).toHaveAttribute("aria-selected", "true");
      await expect(sidebar.locator(".unread-count")).toHaveCount(0);
    }
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`forum topic switches focus the new composer and restore its draft at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openForum(page);
    await input(page).fill("General draft");
    await tab(page, "12").click();
    await expect(input(page)).toBeFocused();
    await page.keyboard.type("Release draft");
    await expect(input(page)).toHaveText("Release draft");
    await tab(page, "1").click();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveText("General draft");
    await page.keyboard.type(" continued");
    await expect(input(page)).toHaveText("General draft continued");
    await tab(page, "__all__").click();
    await expect(input(page)).toHaveCount(0);
    await tab(page, "12").click();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveText("Release draft");
  });
}

test("clicking or dragging the selected forum tab preserves the editor caret", async ({ page }) => {
  await openForum(page);
  await input(page).fill("abcdef");
  await input(page).evaluate(element => {
    (element as import("../../src/components/ComposerInput").ComposerInputElement).setSelectionRange(2, 2);
  });
  await tab(page, "1").click();
  await expect(input(page)).toBeFocused();
  await page.keyboard.type("XY");
  await expect(input(page)).toHaveText("abXYcdef");
  const first = await tab(page, "1").boundingBox();
  const last = await tab(page, "18").boundingBox();
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
  await page.mouse.down();
  await page.mouse.move(last!.x + last!.width - 3, last!.y + last!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(tab(page, "1")).toHaveAttribute("aria-selected", "true");
  await expect(input(page)).toBeFocused();
  await page.keyboard.type("Z");
  await expect(input(page)).toHaveText("abXYZcdef");
});

test("rapid forum clicks focus only the final topic editor", async ({ page }) => {
  await openForum(page);
  await input(page).fill("General draft");
  for (const id of ["12", "18", "1", "12"]) await tab(page, id).click();
  await expect(tab(page, "12")).toHaveAttribute("aria-selected", "true");
  await expect(input(page)).toBeFocused();
  await page.keyboard.type("Final topic");
  await expect(input(page)).toHaveText("Final topic");
  await tab(page, "1").click();
  await expect(input(page)).toHaveText("General draft");
});

test("forum entry focus yields to newer search and topic keyboard navigation", async ({ page }) => {
  await openForum(page);
  await page.evaluate(() => {
    document.addEventListener("click", () => {
      document.querySelector<HTMLInputElement>('input[type="search"]')!.focus();
    }, { once: true });
  });
  await tab(page, "12").click();
  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(search).toBeFocused();
  await page.keyboard.type("Mia");
  await expect(search).toHaveValue("Mia");
  await tab(page, "18").focus();
  await page.keyboard.press("Enter");
  await expect(tab(page, "18")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(tab(page, "18")).toBeFocused();
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect(tab(page, "18")).toBeFocused();
});

test("forced-colors forum navigation retains tab focus", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openForum(page);
  await tab(page, "12").click();
  await expect(tab(page, "12")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(tab(page, "12")).toBeFocused();
});

test("reading all forum history clears the sidebar count and topic badges", async ({ page }) => {
  await page.route("**/src/telegram/mockTransport.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}
      const connectForReadFixture = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.connect = function (...args) {
        // The default fixture has two mention counts without matching messages.
        // This case isolates ordinary unread messages from unseen attention.
        this.snapshot.chats.find(chat => chat.id === "chat-forum").unreadMentionCount = 0;
        return connectForReadFixture.apply(this, args);
      }` });
  });
  await openForum(page);
  const sidebar = page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]');
  await expect(sidebar.locator(".unread-count")).toHaveText("4");
  await tab(page, "12").click();
  await expect(sidebar.locator(".unread-count")).toHaveText("1");
  await expect(tab(page, "18").locator(".forum-topic-tab-count")).toHaveText("1");
  await tab(page, "__all__").click();
  await expect(sidebar.locator(".unread-count")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().forumTopics.get("chat-forum")!.every(topic => topic.unreadCount === 0);
  }, storePath)).toBe(true);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`forum avatar toggle saves group scope and removes its column at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openForum(page);
    const header = page.locator(".conversation-header");
    const avatars = page.locator(".message-list .message-group-avatar");
    await expect(avatars.first()).toBeVisible();
    const before = await page.locator('[data-message-id="forum-general-1"]').boundingBox();
    await header.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "隐藏消息头像", exact: true }).click();
    await expect(avatars).toHaveCount(0);
    const after = await page.locator('[data-message-id="forum-general-1"]').boundingBox();
    expect(before!.x - after!.x).toBeCloseTo(viewport.width === 390 ? 42 : 44, 0);
    await tab(page, "12").click();
    await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
    await expect(avatars).toHaveCount(0);
    await tab(page, "__all__").click();
    await expect(avatars).toHaveCount(0);
    await page.reload();
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
    await tab(page, "12").click();
    await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
    await expect(avatars).toHaveCount(0);
    await header.getByRole("button", { name: "更多操作", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "显示消息头像", exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/forum-hidden-avatars-${viewport.width}.png` });
    await page.getByRole("menuitem", { name: "显示消息头像", exact: true }).click();
    await expect(avatars.first()).toBeVisible();
    if (viewport.width === 390) {
      await tab(page, "__all__").click();
      await header.getByRole("button", { name: "返回会话列表", exact: true }).click();
    }
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(avatars.first()).toBeVisible();
    await header.getByRole("button", { name: "更多操作", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /消息头像/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("forum administration survives delayed chat updates after saving info, permissions and members", async ({ page }) => {
  await openForum(page);
  await page.evaluate(async paths => {
    const { MockTelegramTransport } = await import(paths.transport) as typeof import("../../src/telegram/mockTransport");
    const { deriveChatManagementCapabilities } = await import(paths.management) as typeof import("../../src/telegram/chatManagement");
    const originalLoad = MockTelegramTransport.prototype.getChatManagement;
    MockTelegramTransport.prototype.getChatManagement = async function (...args: Parameters<typeof originalLoad>) {
      const value = await originalLoad.apply(this, args);
      if (args[0] !== "chat-forum") return value;
      const internal = this as unknown as { listener?: (event: unknown) => void; snapshot: { chats: Array<{ id: string }> } };
      setTimeout(() => internal.listener?.({ type: "chat.upsert", chat: {
        ...internal.snapshot.chats.find(chat => chat.id === "chat-forum"),
        management: deriveChatManagementCapabilities("supergroup", "owner"),
      } }), 100);
      return { ...value, capabilities: { ...value.capabilities, canTransferOwnership: false },
        ownershipTransfer: { available: false, reason: "passwordNeeded" } };
    };
  }, { transport: "/src/telegram/mockTransport.ts", management: "/src/telegram/chatManagement.ts" });
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Notgram 论坛", exact: true });
  const categories = manager.getByRole("navigation", { name: "管理分类" });
  await categories.getByRole("button", { name: "概览与资料", exact: true }).click();
  await manager.getByRole("textbox", { name: /^简介/ }).fill("Forum admin regression");
  await manager.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(manager.getByText("已保存", { exact: true })).toBeVisible();
  await expect(manager.getByRole("textbox", { name: /^简介/ })).toHaveValue("Forum admin regression");
  await categories.getByRole("button", { name: "权限与安全", exact: true }).click();
  await manager.getByRole("checkbox", { name: "发送投票", exact: true }).uncheck();
  await manager.getByRole("button", { name: "保存默认权限", exact: true }).click();
  await expect(manager.getByText("已保存", { exact: true })).toBeVisible();
  await categories.getByRole("button", { name: "成员", exact: true }).click();
  await manager.locator(".management-person-row", { hasText: "陈默" }).click();
  await manager.getByRole("textbox", { name: /^成员标签/ }).fill("QA");
  await manager.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(manager.locator(".management-person-row", { hasText: "陈默" })).toContainText("QA");
  await categories.getByRole("button", { name: "所有权", exact: true }).click();
  await expect(manager.getByText("需要先为 Telegram 账号启用两步验证", { exact: true })).toBeVisible();
  await expect(manager.getByText("读取失败，请重试", { exact: true })).toHaveCount(0);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`forum tabs fit their content at ${viewport.width}px without unread placeholder gaps`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openForum(page);
    await page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      const forumTopics = new Map(telegramStore.getState().forumTopics);
      forumTopics.set("chat-forum", forumTopics.get("chat-forum")!.map(topic => ({ ...topic,
        name: topic.id === "1" ? "通用" : topic.id === "12" ? "comfyui" : "设计", unreadCount: 0, unreadReactionCount: 0 })));
      telegramStore.setState({ forumTopics });
    }, storePath);
    const metrics = await page.locator(".forum-topic-tabs").evaluate(element => [...element.children].map(node => {
      const bounds = node.getBoundingClientRect();
      const label = node.querySelector(".forum-topic-tab-name")!.getBoundingClientRect();
      const icon = node.querySelector(".forum-topic-tab-avatar")!.getBoundingClientRect();
      return { height: bounds.height, tail: bounds.right - label.right, iconSize: icon.width };
    }));
    for (const metric of metrics) {
      expect(metric.height).toBe(32);
      expect(metric.tail).toBeLessThanOrEqual(8);
      expect(metric.iconSize).toBe(24);
    }
    await expect(tab(page, "__all__").locator(".forum-topic-tab-name")).toHaveText("全部");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(".forum-topic-strip").screenshot({ path: `test-results/forum-compact-${viewport.width}.png` });
  });
}

test("forum tabs keep their DOM, positions and scroll offset across activity and topic switches", async ({ page }) => {
  await openForum(page);
  await page.evaluate(() => {
    const runtime = window as unknown as { forumHeader: Element | null; forumStrip: Element | null };
    runtime.forumHeader = document.querySelector(".conversation-header");
    runtime.forumStrip = document.querySelector(".forum-topic-strip");
  });
  const before = await page.locator(".forum-topic-tabs").evaluate(element => ({
    order: [...element.children].map(node => (node as HTMLElement).dataset.topicId),
    positions: [...element.children].map(node => node.getBoundingClientRect().left),
    scroll: element.scrollLeft,
  }));
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const topics = new Map(telegramStore.getState().forumTopics);
    topics.set("chat-forum", [...topics.get("chat-forum")!].reverse().map((topic, i) => ({ ...topic,
      order: String(i * 1_000), isPinned: !topic.isPinned, unreadCount: 0, unreadReactionCount: 0 })));
    telegramStore.setState({ forumTopics: topics });
  }, storePath);
  await tab(page, "12").click();
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const after = await page.locator(".forum-topic-tabs").evaluate(element => ({
    order: [...element.children].map(node => (node as HTMLElement).dataset.topicId),
    positions: [...element.children].map(node => node.getBoundingClientRect().left),
    scroll: element.scrollLeft,
  }));
  expect(after).toEqual(before);
  expect(await page.evaluate(() => {
    const runtime = window as unknown as { forumHeader: Element; forumStrip: Element };
    return runtime.forumHeader === document.querySelector(".conversation-header") &&
      runtime.forumStrip === document.querySelector(".forum-topic-strip");
  })).toBe(true);
});

test("forum drag order including All survives switching and reload and keyboard sorting works", async ({ page }) => {
  await openForum(page);
  const first = await tab(page, "1").boundingBox();
  const last = await tab(page, "18").boundingBox();
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2);
  await page.mouse.down();
  await page.mouse.move(first!.x + first!.width / 2 - 3, first!.y + first!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["__all__", "18", "1", "12"]);
  const all = await tab(page, "__all__").boundingBox();
  const end = await tab(page, "12").boundingBox();
  await page.mouse.move(all!.x + all!.width / 2, all!.y + all!.height / 2);
  await page.mouse.down();
  await page.mouse.move(end!.x + end!.width - 3, end!.y + end!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(tab(page, "1")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["18", "1", "12", "__all__"]);
  await tab(page, "12").click();
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await page.reload();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["18", "1", "12", "__all__"]);
  await tab(page, "18").focus();
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["1", "18", "12", "__all__"]);
  await expect(tab(page, "__all__").locator(".forum-topic-tab-name")).toHaveText("全部");
  await tab(page, "__all__").focus();
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["1", "18", "__all__", "12"]);
});

test("All loads the whole group history, survives reentry and does not send into an unspecified topic", async ({ page }) => {
  await openForum(page);
  await tab(page, "__all__").click();
  await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  for (const id of ["forum-general-1", "forum-release-1", "forum-design-1"]) {
    await expect(page.locator(`[data-message-id="${id}"]`)).toBeVisible();
  }
  await expect(input(page)).toHaveCount(0);
  await expect(page.getByText("选择话题后发送消息", { exact: true })).toBeVisible();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
});

test("forum manager creates, renames, closes and deletes a topic with confirmation", async ({ page }) => {
  await openForum(page);
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  let manager = page.getByRole("dialog", { name: "Notgram 论坛", exact: true });
  await manager.getByRole("button", { name: "创建话题" }).click();
  await manager.getByPlaceholder("话题名称").fill("QA topic");
  await manager.getByRole("button", { name: "确认创建" }).click();
  await manager.locator(".forum-topic-main", { hasText: "QA topic" }).click();
  await expect(manager).toHaveCount(0);
  await expect(page.getByRole("region", { name: "QA topic 话题 对话" })).toBeVisible();
  await input(page).fill("Unsent text in a deleted topic");
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  manager = page.getByRole("dialog", { name: "Notgram 论坛", exact: true });
  await manager.locator(".forum-topic-row", { hasText: "QA topic" }).getByRole("button", { name: "重命名", exact: true }).click();
  await manager.locator(".forum-topic-edit input").fill("QA renamed");
  await manager.getByRole("button", { name: "保存话题" }).click();
  await manager.locator(".forum-topic-row", { hasText: "QA renamed" }).getByRole("button", { name: "关闭话题", exact: true }).click();
  await expect(manager.locator(".forum-topic-row.is-closed", { hasText: "QA renamed" })).toBeVisible();
  await manager.locator(".forum-topic-row", { hasText: "QA renamed" }).getByRole("button", { name: "删除话题", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "删除话题", exact: true });
  await expect(confirmation.getByText(/此操作无法撤销/)).toBeVisible();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(manager.getByText("QA renamed", { exact: true })).toBeVisible();
  await manager.locator(".forum-topic-row", { hasText: "QA renamed" }).getByRole("button", { name: "删除话题", exact: true }).click();
  await confirmation.getByRole("button", { name: "删除话题", exact: true }).click();
  await expect(manager.getByText("QA renamed", { exact: true })).toHaveCount(0);
  await manager.getByRole("button", { name: "关闭管理面板" }).click();
  await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return [...telegramStore.getState().drafts.values()].some(draft => draft.text === "Unsent text in a deleted topic");
  }, storePath)).toBe(false);
});

test("unsent forum drafts stay in their original topic during immediate switches", async ({ page }) => {
  await openForum(page);
  await input(page).fill("General draft stays here");
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("");
  await input(page).fill("Release draft stays here");
  await tab(page, "1").click();
  await expect(input(page)).toHaveText("General draft stays here");
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("Release draft stays here");
  await input(page).press("Enter");
  await expect(input(page)).toHaveText("");
  await tab(page, "1").click();
  await expect(input(page)).toHaveText("General draft stays here");
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("");
});

test("sent forum text cannot return through a stale topic-list response after the clear ack", async ({ page }) => {
  await openForum(page);
  await tab(page, "12").click();
  await input(page).fill("Sent text must stay sent");
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.get("chat-forum:topic:12")?.text;
  }, storePath)).toBe("Sent text must stay sent");
  await page.evaluate(async paths => {
    const { telegramStore } = await import(paths.store);
    const { MockTelegramTransport } = await import(paths.transport);
    const original = MockTelegramTransport.prototype.getForumTopics;
    const state = telegramStore.getState();
    const stale = { topics: state.forumTopics.get("chat-forum").map((topic: { id: string }) => ({ ...topic,
      draft: state.drafts.get(`chat-forum:topic:${topic.id}`) })), hasMore: false };
    const runtime = window as unknown as { releaseStaleForum: () => void };
    MockTelegramTransport.prototype.getForumTopics = () => new Promise(resolve => {
      runtime.releaseStaleForum = () => { MockTelegramTransport.prototype.getForumTopics = original; resolve(stale); };
    });
    void telegramStore.getState().loadForumTopics("chat-forum");
  }, { store: storePath, transport: "/src/telegram/mockTransport.ts" });
  await input(page).press("Enter");
  await expect(input(page)).toHaveText("");
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.has("chat-forum:topic:12");
  }, storePath)).toBe(false);
  await page.evaluate(() => (window as unknown as { releaseStaleForum: () => void }).releaseStaleForum());
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().forumTopicsLoading.has("chat-forum");
  }, storePath)).toBe(false);
  await expect(input(page)).toHaveText("");
  expect(await page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.has("chat-forum:topic:12");
  }, storePath)).toBe(false);
  await tab(page, "1").click();
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("");
  expect(await page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.has("chat-forum:topic:12");
  }, storePath)).toBe(false);
});

test("narrow forum keeps All and management reachable without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openForum(page);
  await tab(page, "__all__").click();
  await expect(tab(page, "__all__")).toBeVisible();
  await expect(page.getByRole("button", { name: "管理话题", exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/forum-narrow.png" });
});

test("forum deletion failure keeps the topic and offers a retry; General cannot be deleted", async ({ page }) => {
  await openForum(page);
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Notgram 论坛", exact: true });
  await expect(manager.locator(".forum-topic-row", { hasText: "常规" }).getByRole("button", { name: "删除话题", exact: true })).toHaveCount(0);
  await manager.getByRole("button", { name: "创建话题" }).click();
  await manager.getByPlaceholder("话题名称").fill("Retry deletion");
  await manager.getByRole("button", { name: "确认创建" }).click();
  await manager.locator(".forum-topic-main", { hasText: "Retry deletion" }).click();
  await expect(manager).toHaveCount(0);
  await page.evaluate(async path => {
    const { MockTelegramTransport } = await import(path);
    const original = MockTelegramTransport.prototype.deleteForumTopic;
    let first = true;
    MockTelegramTransport.prototype.deleteForumTopic = async function (...args: unknown[]) {
      if (first) { first = false; throw new Error("Deletion temporarily failed"); }
      return original.apply(this, args);
    };
  }, "/src/telegram/mockTransport.ts");
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  await manager.locator(".forum-topic-row", { hasText: "Retry deletion" }).getByRole("button", { name: "删除话题", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "删除话题", exact: true });
  await confirmation.getByRole("button", { name: "删除话题", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("无法删除话题");
  await expect(manager.getByText("Retry deletion", { exact: true })).toHaveCount(1);
  await confirmation.getByRole("button", { name: "删除话题", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(manager.getByText("Retry deletion", { exact: true })).toHaveCount(0);
});

test("forum tabs keep header and All visible during a slow topic history load", async ({ page }) => {
  await openForum(page);
  await page.evaluate(async paths => {
    const { telegramStore } = await import(paths.store) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import(paths.transport);
    const original = MockTelegramTransport.prototype.loadForumTopicHistory;
    MockTelegramTransport.prototype.loadForumTopicHistory = async function (...args: unknown[]) {
      await new Promise(resolve => setTimeout(resolve, 500));
      return original.apply(this, args);
    };
    const state = telegramStore.getState();
    const topics = new Map(state.forumTopics);
    topics.set("chat-forum", [...topics.get("chat-forum")!, { ...topics.get("chat-forum")![0],
      id: "99", name: "Slow topic", isGeneral: false, lastMessage: undefined }]);
    telegramStore.setState({ forumTopics: topics });
  }, { store: storePath, transport: "/src/telegram/mockTransport.ts" });
  await tab(page, "99").click();
  const frames = await page.evaluate(async () => {
    const header = document.querySelector(".conversation-header")!;
    const strip = document.querySelector(".forum-topic-strip")!;
    let invalid = 0;
    let frameCount = 0;
    const start = performance.now();
    while (performance.now() - start < 700) {
      await new Promise(requestAnimationFrame);
      frameCount++;
      const snapshot = document.querySelector("[data-conversation-switch-snapshot]");
      const stripBounds = strip.getBoundingClientRect();
      if (!header.isConnected || !strip.isConnected || stripBounds.height < 1 ||
        (snapshot && snapshot.getBoundingClientRect().top < stripBounds.bottom - 1)) invalid++;
    }
    return { invalid, frameCount };
  });
  expect(frames.frameCount).toBeGreaterThan(10);
  expect(frames.invalid).toBe(0);
  await expect(tab(page, "99")).toHaveAttribute("aria-selected", "true");
});
