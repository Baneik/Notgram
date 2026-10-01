import { expect, test, type Page } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";
import type { Chat, ChatHistoryPage, ConnectionStatus, ForumTopic, Message, TelegramEvent } from "../../src/telegram/types";
import type { DesktopNotification } from "../../src/notifications/desktopNotifications";

const exposeRecoveryTransport = (page: Page) => page.route("**/src/telegram/mockTransport.ts", async (route) => {
  const response = await route.fetch();
  const body = await response.text();
  await route.fulfill({ response, body: `${body}\n{
    globalThis.__notgramRecoveryTransport = MockTelegramTransport;
    const originalConnect = MockTelegramTransport.prototype.connect;
    MockTelegramTransport.prototype.connect = function(listener, ...options) {
      globalThis.__notgramRecoveryDispatch = listener;
      return originalConnect.call(this, listener, ...options);
    };
  }` });
});

test("notification eligibility is checked before resolving topics in a replay burst", async ({ page }) => {
  await exposeRecoveryTransport(page);
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const counts = await page.evaluate(async ({ storePath, preferencesPath }) => {
    const { telegramStore } = await import(storePath) as { telegramStore: {
      getState: () => TelegramState; setState: (state: Partial<TelegramState>) => void;
    } };
    const { preferencesStore } = await import(preferencesPath) as { preferencesStore: {
      setState: (state: { notificationsEnabled: boolean }) => void;
    } };
    const dispatch = (window as typeof window & { __notgramRecoveryDispatch: (event: TelegramEvent) => void }).__notgramRecoveryDispatch;
    const source = telegramStore.getState().messages.get("chat-product")![0];
    let resolutions = 0;
    telegramStore.setState({ resolveForumTopic: async () => { resolutions += 1; return undefined; } });
    const inject = (id: string, fields: Partial<Message> = {}) => dispatch({ type: "message.upsert", animateEntrance: true, message: {
      ...source, id, chatId: "chat-forum", topicId: "12", outgoing: false, sentAt: new Date().toISOString(), ...fields,
    } });
    preferencesStore.setState({ notificationsEnabled: false });
    for (let i = 0; i < 100; i++) inject(`disabled-${i}`);
    const disabled = resolutions;
    preferencesStore.setState({ notificationsEnabled: true });
    for (let i = 0; i < 100; i++) inject(`outgoing-${i}`, { outgoing: true });
    const outgoing = resolutions;
    for (let i = 0; i < 100; i++) inject(`old-${i}`, { sentAt: "2020-01-01T00:00:00.000Z" });
    const historical = resolutions;
    inject("eligible-topic");
    await Promise.resolve();
    return { disabled, outgoing, historical, eligible: resolutions };
  }, { storePath: "/src/store/telegramStore.ts", preferencesPath: "/src/store/preferencesStore.ts" });
  expect(counts).toEqual({ disabled: 0, outgoing: 0, historical: 0, eligible: 1 });
});

test("channel subscriptions notify without leaking non-member discussion group updates", async ({ page }) => {
  await exposeRecoveryTransport(page);
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const result = await page.evaluate(async ({ storePath, preferencesPath }) => {
    const { telegramStore } = await import(storePath) as { telegramStore: {
      getState: () => TelegramState; setState: (state: Partial<TelegramState>) => void;
    } };
    const { preferencesStore } = await import(preferencesPath) as { preferencesStore: {
      setState: (state: { notificationsEnabled: boolean; notificationSound: boolean }) => void;
    } };
    const dispatch = (window as typeof window & { __notgramRecoveryDispatch: (event: TelegramEvent) => void }).__notgramRecoveryDispatch;
    const notifications: DesktopNotification[] = [];
    Object.assign(window, { __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { notification?: DesktopNotification }) => {
        if (command === "notgram_show_notification" && args.notification) notifications.push(args.notification);
      },
    } });
    preferencesStore.setState({ notificationsEnabled: true, notificationSound: false });
    const state = telegramStore.getState();
    const source = state.messages.get("chat-product")![0];
    const group: Chat = { ...state.chats.get("chat-product")!, id: "unjoined-discussion", isMember: false, muted: false };
    const channel: Chat = { ...state.chats.get("chat-release")!, isMember: true, muted: false };
    const unknownGroup: Chat = { ...group, id: "unknown-membership", isMember: undefined };
    const previewChannel: Chat = { ...channel, id: "preview-channel", isMember: false };
    const direct: Chat = { ...state.chats.get("chat-mia")!, muted: false };
    dispatch({ type: "chats.upserted", chats: [group, channel, unknownGroup, previewChannel, direct] });
    const inject = (chatId: string, id: string) => dispatch({ type: "message.upsert", animateEntrance: true, message: {
      ...source, id, chatId, topicId: undefined, messageThreadId: "discussion-root", outgoing: false,
      sentAt: new Date().toISOString(), content: { kind: "text", text: id },
    } });
    inject(group.id, "non-member-comment");
    inject(channel.id, "followed-channel-post");
    inject(unknownGroup.id, "unknown-membership-comment");
    inject("missing-chat", "unknown-chat-message");
    inject(previewChannel.id, "unfollowed-channel-post");
    inject(direct.id, "private-message");
    dispatch({ type: "chats.upserted", chats: [{ ...group, isMember: true }] });
    inject(group.id, "joined-group-message");
    dispatch({ type: "chats.upserted", chats: [group] });
    inject(group.id, "left-group-message");
    await Promise.resolve();
    return {
      routes: notifications.map(({ route }) => ({ chatId: route.chatId, messageId: route.messageId })),
      discussionMessages: telegramStore.getState().messages.get(group.id)?.map(({ id }) => id).sort(),
    };
  }, { storePath: "/src/store/telegramStore.ts", preferencesPath: "/src/store/preferencesStore.ts" });
  expect(result.discussionMessages).toEqual(["joined-group-message", "left-group-message", "non-member-comment"]);
  expect(result.routes).toEqual([
    { chatId: "chat-release", messageId: "followed-channel-post" },
    { chatId: "chat-mia", messageId: "private-message" },
    { chatId: "unjoined-discussion", messageId: "joined-group-message" },
  ]);
});

test("notification membership is checked before topic lookup and after an in-flight lookup", async ({ page }) => {
  await exposeRecoveryTransport(page);
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const result = await page.evaluate(async ({ storePath, preferencesPath }) => {
    const { telegramStore } = await import(storePath) as { telegramStore: {
      getState: () => TelegramState; setState: (state: Partial<TelegramState>) => void;
    } };
    const { preferencesStore } = await import(preferencesPath) as { preferencesStore: {
      setState: (state: { notificationsEnabled: boolean; notificationSound: boolean }) => void;
    } };
    const dispatch = (window as typeof window & { __notgramRecoveryDispatch: (event: TelegramEvent) => void }).__notgramRecoveryDispatch;
    const notifications: DesktopNotification[] = [];
    Object.assign(window, { __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { notification?: DesktopNotification }) => {
        if (command === "notgram_show_notification" && args.notification) notifications.push(args.notification);
      },
    } });
    preferencesStore.setState({ notificationsEnabled: true, notificationSound: false });
    const source = telegramStore.getState().messages.get("chat-product")![0];
    const forum: Chat = { ...telegramStore.getState().chats.get("chat-forum")!, isMember: false, muted: false };
    dispatch({ type: "chats.upserted", chats: [forum] });
    let resolutions = 0;
    let finishLookup: (() => void) | undefined;
    telegramStore.setState({ resolveForumTopic: async () => {
      resolutions += 1;
      await new Promise<void>((resolve) => { finishLookup = resolve; });
      return {
        id: "12", chatId: forum.id, name: "Topic", muted: false, unreadCount: 0, lastReadInboxMessageId: "0",
        iconColor: 0, createdAt: source.sentAt, isGeneral: false, isOutgoing: false, isClosed: false,
        isHidden: false, isPinned: false, unreadMentionCount: 0, unreadReactionCount: 0, order: "1",
      } satisfies ForumTopic;
    } });
    const inject = (id: string) => dispatch({ type: "message.upsert", animateEntrance: true, message: {
      ...source, id, chatId: forum.id, topicId: "12", outgoing: false, sentAt: new Date().toISOString(),
    } });
    inject("non-member-topic-message");
    const nonMemberLookups = resolutions;
    finishLookup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const nonMemberNotifications = notifications.length;
    notifications.length = 0;
    dispatch({ type: "chats.upserted", chats: [{ ...forum, isMember: true }] });
    inject("message-before-leaving");
    dispatch({ type: "chats.upserted", chats: [forum] });
    finishLookup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { nonMemberLookups, nonMemberNotifications, resolutions, afterLeaving: notifications.length };
  }, { storePath: "/src/store/telegramStore.ts", preferencesPath: "/src/store/preferencesStore.ts" });
  expect(result).toEqual({ nonMemberLookups: 0, nonMemberNotifications: 0, resolutions: 1, afterLeaving: 0 });
});

test("proxy recovery shows retry progress instead of blaming proxy settings", async ({ page }) => {
  await page.goto("/?connection=recovering");
  const progress = page.getByRole("status").filter({ hasText: "连接中断，正在自动重试" });
  await expect(progress.first()).toBeVisible();
  await expect(progress.first().locator(".spin")).toBeVisible();
  await expect(page.getByText("代理设置暂不可用，请检查连接设置", { exact: true })).toBeHidden();
});

test("system discovery errors explain the limitation and preserve unsaved proxy edits", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /高级设置/ }).click();
  await expect(settings.getByRole("radio", { name: "系统代理" })).toBeChecked();
  const updateDiscovery = () => page.evaluate(async (path) => {
    const { telegramStore } = await import(path) as {
      telegramStore: { getState: () => TelegramState; setState: (value: Partial<TelegramState>) => void };
    };
    const previous = telegramStore.getState().proxySettings!;
    telegramStore.setState({ proxySettings: { ...previous, revision: (previous.revision ?? 0) + 1,
      system: undefined, systemStatus: { kind: "unsupported" } } });
  }, "/src/store/telegramStore.ts");
  await updateDiscovery();
  await expect(settings.getByText("暂不支持此系统代理配置", { exact: true })).toBeVisible();
  await expect(settings.getByText("当前将使用直连", { exact: true })).toBeHidden();
  await settings.getByRole("radio", { name: "自定义" }).click();
  await settings.getByLabel("服务器").fill("edited.example.test");
  await updateDiscovery();
  await expect(settings.getByRole("radio", { name: "自定义" })).toBeChecked();
  await expect(settings.getByLabel("服务器")).toHaveValue("edited.example.test");
});

for (const presentation of [
  { language: "en", themeId: "notgram-dark", interfaceScale: 125, width: 390, forced: false },
  { language: "ja", themeId: "notgram-light", interfaceScale: 100, width: 390, forced: false },
  { language: "zh-CN", themeId: "notgram-light", interfaceScale: 100, width: 1280, forced: true },
] as const) {
  for (const discussion of [false, true]) {
    test(`connection feedback keeps ${discussion ? "discussion" : "chat"} geometry in ${presentation.language} (${presentation.themeId})`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: presentation.forced ? "active" : "none", reducedMotion: "reduce" });
      await page.addInitScript(preferences => {
        localStorage.setItem("notgram:preferences:v1", JSON.stringify(preferences));
      }, presentation);
      await page.goto("/");
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      await page.locator(`.chat-list[data-active=true] [data-chat-id="${discussion ? "chat-release" : "chat-mia"}"]`).click();
      if (discussion) {
        await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
        await expect(page.locator(".channel-discussion-messages [data-message-id]").first()).toBeVisible();
      } else {
        await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      }
      await page.setViewportSize({ width: presentation.width, height: 700 });
      const scope = page.locator(discussion ? ".channel-discussion-panel" : ".conversation");
      const editor = scope.getByRole("textbox");
      await editor.fill("connection draft");
      const geometry = () => scope.evaluate(element => {
        const composer = element.querySelector(".composer")!.getBoundingClientRect();
        const list = element.querySelector(".channel-discussion-messages, .message-list")!.getBoundingClientRect();
        return { composerTop: composer.top, composerHeight: composer.height, listTop: list.top, listHeight: list.height };
      });
      const before = await geometry();
      for (const status of ["connecting", "recovering", "waitingForNetwork", "offline", "syncing", "online", "proxyError"] as ConnectionStatus[]) {
        const label = await page.evaluate(async ({ storePath, connectionPath, status }) => {
          const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
          const { connectionPresentation } = await import(connectionPath) as typeof import("../../src/telegram/connectionState");
          telegramStore.setState({ connectionStatus: status });
          return connectionPresentation(status).label;
        }, { storePath: "/src/store/telegramStore.ts", connectionPath: "/src/telegram/connectionState.ts", status });
        const indicator = scope.locator(".composer-connection-status");
        if (status === "online" || status === "syncing") {
          await expect(indicator).toHaveCount(0);
        } else {
          await expect(indicator).toHaveText(label);
          await expect(indicator).toHaveAttribute("role", "status");
          await expect(indicator).toHaveAttribute("aria-live", "polite");
          await expect(indicator).toBeInViewport();
          expect(await indicator.evaluate(element => {
            const box = element.getBoundingClientRect();
            const wrap = element.closest(".composer-wrap")!.getBoundingClientRect();
            const scope = element.closest("[data-composer-scope]")!;
            const header = scope.querySelector(":scope > header")!.getBoundingClientRect();
            return box.top >= header.bottom && box.bottom <= wrap.top &&
              box.left >= wrap.left && box.right <= wrap.right &&
              getComputedStyle(element).pointerEvents === "none" && element.scrollWidth <= element.clientWidth;
          })).toBe(true);
        }
        expect(await geometry()).toEqual(before);
        await expect(editor).toHaveJSProperty("value", "connection draft");
        await expect(editor).toBeFocused();
      }
    });
  }
}

for (const reason of ["reconnect", "wake"] as const) {
  test(`${reason} refreshes exhausted history and displays missed messages`, async ({ page }) => {
    await exposeRecoveryTransport(page);
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async (storePath) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      await telegramStore.getState().loadMoreHistory("chat-product");
    }, "/src/store/telegramStore.ts");
    const latest = page.getByRole("button", { name: /^跳到最新消息/ });
    if (await latest.isVisible()) await latest.click();

    const previousIds = await page.evaluate(async ({ storePath, reason }) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      // Use the class instrumented during startup, avoiding a second dynamic
      // module import through Vite's cyclic transport/store dependency graph.
      const runtime = window as typeof window & {
        __notgramRecoveryTransport: { prototype: { loadChatHistory: (chatId: string, limit?: number) => Promise<ChatHistoryPage> } };
        __notgramRecoveryDispatch: (event: TelegramEvent) => void;
      };
      const MockTelegramTransport = runtime.__notgramRecoveryTransport;
      const state = telegramStore.getState();
      if (state.histories.get("chat-product")?.hasMore !== false) throw new Error("History did not reach its end");
      const previous = state.messages.get("chat-product")!;
      const missed: Message = {
        ...previous.at(-1)!,
        id: "missed-after-sleep",
        outgoing: false,
        sentAt: new Date(Date.now() + 60_000).toISOString(),
        content: { kind: "text", text: "休眠后补齐的消息" },
      };
      const original = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadChatHistory = async function (chatId, limit) {
        if (chatId !== "chat-product") return original.call(this, chatId, limit);
        const messages = [...previous, missed];
        return { messages, messageIds: messages.map((message) => message.id), loadedCount: 1, hasMore: false };
      };
      const dispatch = runtime.__notgramRecoveryDispatch;
      if (reason === "wake") dispatch({ type: "sync.required" });
      else {
        dispatch({ type: "connection.changed", status: "waitingForNetwork" });
        dispatch({ type: "connection.changed", status: "online" });
      }
      return previous.map((message) => message.id);
    }, { storePath: "/src/store/telegramStore.ts", reason });

    await expect(page.getByText("休眠后补齐的消息", { exact: true })).toBeVisible();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const actualIds = await page.evaluate(async (storePath) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      return telegramStore.getState().messages.get("chat-product")?.map((message) => message.id);
    }, "/src/store/telegramStore.ts");
    expect(actualIds).toEqual(expect.arrayContaining([...previousIds, "missed-after-sleep"]));
  });
}

for (const chatId of ["chat-product", "chat-forum"]) {
  for (const detached of [false, true]) {
    test(`repeated recovery preserves ${chatId} viewport while ${detached ? "reading history" : "following latest"}`, async ({ page }) => {
      await exposeRecoveryTransport(page);
      await page.goto("/");
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      await page.evaluate(async ({ path, chatId }) => {
        const { telegramStore } = await import(path) as { telegramStore: { getState: () => TelegramState } };
        if (chatId === "chat-forum") {
          const runtime = window as typeof window & {
            __notgramRecoveryTransport: { prototype: {
              loadForumTopicHistory: (chatId: string, topicId: string) => Promise<ChatHistoryPage>;
            } };
          };
          const template = telegramStore.getState().messages.get("chat-product")![0];
          runtime.__notgramRecoveryTransport.prototype.loadForumTopicHistory = async (chatId, topicId) => {
            const messages: Message[] = Array.from({ length: 40 }, (_, index) => ({
              ...template, chatId, topicId, id: `recovery-forum-${index}`, outgoing: false,
              sentAt: new Date(Date.UTC(2026, 8, 9, 12, index)).toISOString(),
              content: { kind: "text", text: `论坛恢复回归消息 ${index}` },
            }));
            return { messages, messageIds: messages.map((m) => m.id), loadedCount: messages.length, hasMore: false };
          };
        }
        await telegramStore.getState().selectChat(chatId);
      }, { path: "/src/store/telegramStore.ts", chatId });
      await expect(page.locator(".message-list")).toHaveAttribute("data-conversation-virtuoso-key", new RegExp(chatId));
      if (chatId === "chat-forum") {
        await expect(page.locator('[data-message-id="recovery-forum-39"]')).toBeVisible();
      }
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      const latest = page.getByRole("button", { name: /^跳到最新消息/ });
      if (await latest.isVisible()) await latest.click();
      if (detached) {
        await page.locator(".message-list").hover();
        await page.mouse.wheel(0, -180);
        await expect(page.locator(".message-list")).toHaveClass(/is-detached/);
      }
      const sample = await page.evaluate(async ({ path, chatId }) => {
        const { telegramStore } = await import(path) as { telegramStore: { getState: () => TelegramState } };
        const runtime = window as typeof window & {
          __notgramRecoveryTransport: { prototype: {
            loadChatHistory: (chatId: string) => Promise<ChatHistoryPage>;
            loadForumTopicHistory: (chatId: string, topicId: string) => Promise<ChatHistoryPage>;
          } };
          __notgramRecoveryDispatch: (event: TelegramEvent) => void;
        };
        // Let startup media measurements and the user wheel intent settle before
        // measuring only the connection/recovery work below.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const topicId = telegramStore.getState().activeTopicId;
        const messages = (telegramStore.getState().messages.get(chatId) ?? [])
          .filter((message) => !topicId || message.topicId === topicId);
        const prototype = runtime.__notgramRecoveryTransport.prototype;
        const method = topicId ? "loadForumTopicHistory" : "loadChatHistory";
        const originalChatHistory = prototype.loadChatHistory;
        const originalTopicHistory = prototype.loadForumTopicHistory;
        prototype[method] = async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { messages: structuredClone(messages), messageIds: messages.map((m) => m.id), loadedCount: messages.length, hasMore: false };
        };
        const list = document.querySelector<HTMLElement>(".message-list")!;
        const heights = [list.clientHeight];
        const tops = [list.scrollTop];
        let replaced = false;
        let hidden = false;
        let loading = false;
        const timer = setInterval(() => {
          replaced ||= document.querySelector(".message-list") !== list;
          const content = list.querySelector<HTMLElement>(".message-list-content") ?? list;
          hidden ||= list.querySelectorAll("[data-message-id]").length === 0 ||
            getComputedStyle(content).visibility === "hidden" || getComputedStyle(content).opacity === "0";
          loading ||= list.classList.contains("is-history-adjusting") || Boolean(document.querySelector(".history-loading"));
          heights.push(list.clientHeight);
          tops.push(list.scrollTop);
        }, 16);
        try {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            runtime.__notgramRecoveryDispatch({ type: "connection.changed", status: "recovering" });
            await new Promise((resolve) => setTimeout(resolve, 300));
            runtime.__notgramRecoveryDispatch({ type: "connection.changed", status: "online" });
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
          return { replaced, hidden, loading, heightRange: Math.max(...heights) - Math.min(...heights), topRange: Math.max(...tops) - Math.min(...tops) };
        } finally {
          clearInterval(timer);
          prototype.loadChatHistory = originalChatHistory;
          prototype.loadForumTopicHistory = originalTopicHistory;
        }
      }, { path: "/src/store/telegramStore.ts", chatId });
      expect(sample).toMatchObject({ replaced: false, hidden: false, loading: false, heightRange: 0 });
      expect(sample.topRange).toBeLessThanOrEqual(1);
    });
  }
}
