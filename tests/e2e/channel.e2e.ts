import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

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
