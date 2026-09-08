import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

test("discussion rendering failures keep the client and return action available", async ({ page }) => {
  await page.route("**/src/components/ChannelDiscussionPanel.tsx*", route => route.fulfill({
    contentType: "application/javascript", body: 'export function ChannelDiscussionPanel() { throw new Error("synthetic discussion render failure"); }',
  }));
  await page.goto("/");
  await page.locator('[data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  await expect(page.locator(".channel-discussion-panel").getByRole("alert")).toContainText("留言加载失败");
  await page.getByRole("button", { name: "返回频道", exact: true }).click();
  await expect(page.locator(".channel-discussion-panel")).toHaveCount(0);
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
});

test("discussion messages honor local blocking and only reveal for the current visit", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const { localUserBlocksStore } = await (0, eval)('import("/src/store/localUserBlocks.ts")') as typeof import("../../src/store/localUserBlocks");
    const state = telegramStore.getState();
    localUserBlocksStore.getState().blockUser(state.activeAccountId!, state.users.get("u-mia")!);
  });
  const open = page.locator('[data-message-id="release-post-1"] .channel-post-discussion');
  await open.click();
  const panel = page.locator(".channel-discussion-panel");
  const comment = panel.locator('[data-message-id="release-comment-1"] .message-bubble-shell');
  await expect(comment).toHaveClass(/is-local-block-concealed/);
  await comment.getByRole("button", { name: /显示一条来自/ }).click();
  await expect(comment).not.toHaveClass(/is-local-block-concealed/);
  await panel.getByRole("button", { name: "返回频道" }).click();
  await open.click();
  await expect(comment).toHaveClass(/is-local-block-concealed/);
});

test("channel posting follows owner and administrator rights, including revoked access", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  for (const [status, allowed] of [["owner", true], ["administrator", true], ["administrator", false], ["member", false]] as const) {
    await page.evaluate(async ({ status, allowed }) => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
      const { deriveChatManagementCapabilities, DEFAULT_CHAT_ADMIN_RIGHTS } = await (0, eval)('import("/src/telegram/chatManagement.ts")') as typeof import("../../src/telegram/chatManagement");
      const chats = new Map(telegramStore.getState().chats);
      chats.set("chat-release", { ...chats.get("chat-release")!, management: deriveChatManagementCapabilities("channel", status, { ...DEFAULT_CHAT_ADMIN_RIGHTS, canPostMessages: allowed }) });
      telegramStore.setState({ chats, loadChatManagement: async () => undefined });
    }, { status, allowed });
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveCount(allowed ? 1 : 0);
    if (status === "administrator" && allowed) {
      await page.getByRole("textbox", { name: "消息内容" }).fill("administrator channel post");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message-rich-text").filter({ hasText: "administrator channel post" })).toBeVisible();
    }
    if (!allowed) {
      expect(await page.evaluate(async () => {
        const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
        return telegramStore.getState().sendMessage("must not be sent");
      })).toBe(false);
    }
  }
});

test("offline replies stay visible in the selected discussion and keep other threads out of its queue count", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator('[data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const source = state.messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const root: Message = { ...source, id: "linked-root", chatId: "linked-group", isChannelPost: false, topicId: "linked-root" };
    const comment: Message = { ...root, id: "reply-target", senderId: "u-mia", outgoing: false,
      replyTo: { kind: "message", chatId: root.chatId, messageId: root.id },
      permissions: { canReply: true, canEdit: false, canDeleteOnlyForSelf: true, canDeleteForAllUsers: false, canForward: true },
      content: { kind: "text", text: "comment to reply to" },
    };
    const messages = new Map(state.messages);
    messages.set(source.chatId, [{ ...source, discussionThread: { chatId: root.chatId, messageId: root.id } }]);
    messages.set(root.chatId, [root, comment]);
    telegramStore.setState({ messages, connectionStatus: "offline",
      loadMessageThreadHistory: async () => ({ chatId: root.chatId, messageId: root.id, messages: [root, comment], hasMore: false }),
      outbox: [{ id: "other-thread-queued", chatId: root.chatId, discussionThreadId: "other-root", replyToMessageId: "other-root", text: "unrelated queued reply", createdAt: new Date().toISOString(), status: "queued" }],
    });
  });
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/条消息将在联网后发送/)).toHaveCount(0);
  await panel.locator('[data-message-id="reply-target"] .message-bubble-shell').click({ button: "right" });
  await page.getByRole("menuitem", { name: "回复", exact: true }).click();
  await panel.getByRole("textbox", { name: "消息内容" }).fill("offline nested reply from composer");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(panel.locator(".message-rich-text").filter({ hasText: "offline nested reply from composer" })).toBeVisible();
  await expect(panel.getByText("1 条消息将在联网后发送")).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "消息内容" })).toBeEmpty();
  expect(errors).toEqual([]);
});

test("discussion pagination deduplicates requests, retains comments on errors, and retries the same cursor", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator('[data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const root = telegramStore.getState().messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const comments: Message[] = Array.from({ length: 10 }, (_, index) => ({ ...root, id: `page-comment-${index}`,
      isChannelPost: false, interaction: undefined, senderId: "u-mia",
      sentAt: new Date(Date.parse(root.sentAt) + (index + 1) * 1000).toISOString(),
      replyTo: { kind: "message", chatId: root.chatId, messageId: root.id },
      content: { kind: "text", text: `comment ${index}` },
    }));
    const control = window as unknown as { pageCalls: Array<string | undefined>; releasePage?: (success: boolean) => void };
    control.pageCalls = [];
    telegramStore.setState({ loadMessageThreadHistory: async (_chat, _post, _limit, before) => {
      control.pageCalls.push(before);
      if (before) await new Promise<void>((resolve, reject) => {
        control.releasePage = success => success ? resolve() : reject(new Error("temporary history failure"));
      });
      const messages = new Map(telegramStore.getState().messages);
      const pageMessages = before ? comments : comments.slice(5);
      messages.set(root.chatId, [{ ...root, discussionThread: { chatId: root.chatId, messageId: root.id } }, ...pageMessages]);
      telegramStore.setState({ messages });
      return { chatId: root.chatId, messageId: root.id, messages: pageMessages, nextFromMessageId: before ? comments[0].id : comments[5].id, hasMore: !before };
    } });
  });
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  const more = panel.getByRole("button", { name: "加载更早留言" });
  await expect(panel.locator('[data-message-id^="page-comment-"]')).toHaveCount(5);
  await more.click();
  await expect(more).toBeDisabled();
  await expect(more.locator(".spin")).toHaveCount(1);
  await more.dispatchEvent("click");
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageCalls: unknown[] }).pageCalls.length)).toBe(2);
  await page.evaluate(() => (window as unknown as { releasePage: (success: boolean) => void }).releasePage(false));
  await expect(panel.getByRole("alert")).toContainText("留言加载失败");
  await expect(panel.locator('[data-message-id^="page-comment-"]')).toHaveCount(5);
  await panel.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageCalls: unknown[] }).pageCalls.length)).toBe(3);
  await page.evaluate(() => (window as unknown as { releasePage: (success: boolean) => void }).releasePage(true));
  await expect(panel.locator('[data-message-id^="page-comment-"]')).toHaveCount(10);
  await expect(more).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pageCalls: unknown[] }).pageCalls)).toEqual([undefined, "page-comment-5", "page-comment-5"]);
  expect(errors).toEqual([]);
});

test("channel albums keep a shared caption, metadata, and one working discussion action", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator('[data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const post = state.messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const photo = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#647d90"/></svg>');
    const album: Message[] = [0, 1].map(index => ({ ...post,
      id: index === 0 ? post.id : "album-last", mediaAlbumId: "channel-test-album", outgoing: false,
      authorSignature: "Editor", editedAt: post.sentAt,
      sentAt: new Date(Date.parse(post.sentAt) + index * 1000).toISOString(),
      interaction: index === 0 ? { ...post.interaction!, viewCount: 12345, forwardCount: 67 } : undefined,
      content: { kind: "media", mediaType: "photo", fileName: `photo-${index}.jpg`, sizeLabel: "1 KB", width: 400, height: 300,
        previewDataUrl: photo, caption: index === 1 ? "两张图片的完整说明" : undefined },
    }));
    const messages = new Map(state.messages);
    messages.set("chat-release", album);
    telegramStore.setState({ messages });
  });
  const album = page.locator('[data-media-album-id="channel-test-album"]');
  await expect(album).toBeVisible();
  await expect(album.locator(".media-album-caption")).toHaveText("两张图片的完整说明");
  await expect(album.locator(".media-album-footer time")).toHaveCount(1);
  await expect(album.locator('[aria-label="12345 次观看"]')).toBeVisible();
  await expect(album.locator('[aria-label="转发 67 次"]')).toBeVisible();
  await expect(album.locator(".media-album-footer")).toContainText("已编辑");
  await expect(album.locator(".channel-post-discussion")).toHaveCount(1);
  for (const width of [1100, 700]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => album.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const footer = element.querySelector(".media-album-footer")!.getBoundingClientRect();
      const grid = element.querySelector(".media-album-grid")!.getBoundingClientRect();
      return footer.top >= grid.bottom && footer.right <= bounds.right + 1;
    })).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("channel-album.png") });
  await album.locator(".channel-post-discussion").click();
  await expect(page.locator(".channel-discussion-panel")).toBeVisible();
  expect(errors).toEqual([]);
});
