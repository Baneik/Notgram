import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

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
