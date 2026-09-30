import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Message } from "../../src/telegram/types";

for (const chatId of ["chat-product", "chat-release"]) {
  test(`photos finish download and decode before scrolling into ${chatId}`, async ({ page }) => {
    const image = readFileSync("tests/fixtures/public/mock-video-poster.jpg");
    await page.route("**/prefetch-photo-*", async route => {
      await new Promise(resolve => setTimeout(resolve, 200));
      await route.fulfill({ contentType: "image/jpeg", body: image });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.locator(`.chat-list[data-active=true] [data-chat-id="${chatId}"]`).click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async chatId => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const state = telegramStore.getState();
      const base = state.messages.get(chatId)![0];
      const messages = Array.from({ length: 26 }, (_, index): Message => ({
        ...base, id: `prefetch-${index}`, isChannelPost: chatId === "chat-release", mediaAlbumId: undefined,
        isPinned: false, replyTo: undefined, outgoing: false,
        sentAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString(),
        content: index === 18 ? {
          kind: "media", mediaType: "photo", fileName: "prefetch.jpg", sizeLabel: "100 KB", size: 100_000,
          fileId: 922, canDownload: true, width: 400, height: 240,
        } : { kind: "text", text: `Row ${index}\n` + "Scroll buffer content.\n".repeat(4) },
      }));
      const requests: number[] = [], releases: number[] = [];
      Object.assign(window, { photoPrefetchRequests: requests, photoPrefetchReleases: releases });
      telegramStore.setState({ messages: new Map(state.messages).set(chatId, messages),
        cacheFile: async fileId => {
          requests.push(fileId);
          const update = (downloaded: boolean) => {
            const current = telegramStore.getState();
            telegramStore.setState({ messages: new Map(current.messages).set(chatId,
              current.messages.get(chatId)!.map(message => message.id !== "prefetch-18" ? message : {
                ...message, content: { ...message.content as Extract<Message["content"], { kind: "media" }>,
                  isDownloading: !downloaded, isDownloaded: downloaded,
                  localPath: downloaded ? `${location.origin}/prefetch-photo-${chatId}.jpg` : undefined,
                },
              })) });
          };
          update(false);
          await new Promise(resolve => setTimeout(resolve, 250));
          update(true);
        },
        releaseFile: fileId => { releases.push(fileId); },
      });
    }, chatId);
    const target = page.locator('.message-list [data-message-id="prefetch-18"]');
    await expect(page.locator('.message-list [data-message-id="prefetch-25"]')).toBeVisible();
    await expect(target).toBeAttached();
    await expect.poll(async () => {
      const bounds = await target.boundingBox();
      const viewport = await page.locator(".message-list").boundingBox();
      return bounds!.y + bounds!.height < viewport!.y;
    }).toBe(true);
    const bounds = await target.boundingBox();
    const viewport = await page.locator(".message-list").boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThan(viewport!.y);
    expect(viewport!.y - bounds!.y - bounds!.height).toBeLessThan(1600);
    await expect(target.locator('img[data-photo-preview="true"][data-image-state="ready"]')).toBeAttached();
    expect(await page.evaluate(() => (window as unknown as { photoPrefetchRequests: number[] }).photoPrefetchRequests)).toEqual([922]);
    await page.locator(".message-list").evaluate((element, distance) => { element.scrollTop -= distance; }, viewport!.y - bounds!.y + 50);
    await expect(target).toBeVisible();
    await expect(target.locator('img[data-photo-preview="true"][data-image-state="ready"]')).toBeVisible();
    await expect(target.getByLabel("媒体正在加载", { exact: true })).toHaveCount(0);
  });
}

for (const chatId of ["chat-product", "chat-release"]) {
  test(`pin service notices disappear from ${chatId} while pinned messages stay available`, async ({ page }) => {
    await page.goto("/");
    await page.locator(`.chat-list[data-active=true] [data-chat-id="${chatId}"]`).click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async chatId => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const state = telegramStore.getState();
      const base = state.messages.get(chatId)![0];
      const rows: Message[] = [
        { ...base, id: "pin-target", isChannelPost: chatId === "chat-release", isPinned: true, content: { kind: "text", text: "Pinned post remains" } },
        { ...base, id: "hidden-pin-notice", content: { kind: "service", text: "Pinned", event: { type: "messagePinMessage", target: { messageId: "pin-target" } } } },
        { ...base, id: "visible-join-notice", content: { kind: "service", text: "Joined", event: { type: "messageChatJoinByLink" } } },
      ];
      telegramStore.setState({ messages: new Map(state.messages).set(chatId, rows) });
    }, chatId);
    await expect(page.locator('.message-list [data-message-id="pin-target"]')).toBeVisible();
    await expect(page.locator('.message-list [data-message-id="hidden-pin-notice"]')).toHaveCount(0);
    await expect(page.locator('.message-list [data-message-id="visible-join-notice"]')).toBeVisible();
    await expect(page.locator('.message-list [data-message-id="pin-target"]').getByLabel("已置顶", { exact: true })).toBeVisible();
  });
}
