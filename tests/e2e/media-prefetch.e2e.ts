import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Message } from "../../src/telegram/types";

for (const chatId of ["chat-product", "chat-release"]) {
  for (const mediaType of ["video", "videoNote"] as const) {
    test(`${mediaType} posters bypass slow full downloads in ${chatId} without hovering`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await page.locator(`.chat-list[data-active=true] [data-chat-id="${chatId}"]`).click();
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      await page.evaluate(async ({ chatId, mediaType }) => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
        const { FileDownloadQueue } = await import("/src/telegram/fileDownloadQueue.ts" as string) as typeof import("../../src/telegram/fileDownloadQueue");
        const state = telegramStore.getState();
        const base = state.messages.get(chatId)![0];
        const requests: Array<{ fileId: number; priority: number }> = [];
        const releases: number[] = [];
        const queue = new FileDownloadQueue(async request => {
          const fileId = Number(request.file_id);
          requests.push({ fileId, priority: Number(request.priority) });
          const thumbnail = fileId >= 940 && fileId < 944;
          return { "@type": "file", id: fileId, local: {
            is_downloading_active: !thumbnail, is_downloading_completed: thumbnail,
            path: thumbnail ? "/mock-video-poster.jpg" : "",
          } };
        }, file => {
          const fileId = Number(file.id);
          if (fileId < 940 || fileId >= 944) return;
          const current = telegramStore.getState();
          telegramStore.setState({ messages: new Map(current.messages).set(chatId,
            current.messages.get(chatId)!.map(message => {
              if (message.content.kind !== "media" || message.content.thumbnailFileId !== fileId) return message;
              return { ...message, content: { ...message.content, thumbnailPath: "/mock-video-poster.jpg" } };
            })) });
        });
        // Fill the three background slots with downloads that never complete.
        for (const fileId of [930, 931, 932]) void queue.cache(fileId, 18).catch(() => undefined);
        Object.assign(window, { videoPosterRequests: requests, videoPosterReleases: releases });
        preferencesStore.setState({ autoDownloadVideos: true });
        const rows: Message[] = Array.from({ length: 4 }, (_, index) => ({
          ...base, id: `poster-${index}`, isChannelPost: chatId === "chat-release",
          mediaAlbumId: undefined, replyTo: undefined, isPinned: false, outgoing: false,
          sentAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString(),
          content: { kind: "media", mediaType, fileName: `poster-${index}.mp4`, sizeLabel: "1 MB",
            size: 1_000_000, fileId: 950 + index, canDownload: true,
            thumbnailFileId: 940 + index, thumbnailCanDownload: true,
            previewDataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='gray'/%3E%3C/svg%3E",
            width: 240, height: 160, duration: 11 },
        }));
        telegramStore.setState({ messages: new Map(state.messages).set(chatId, rows),
          cacheFile: (fileId, priority) => queue.cache(fileId, priority),
          releaseFile: fileId => { releases.push(fileId); queue.release(fileId); },
        });
      }, { chatId, mediaType });
      await expect(page.locator('.message-list .video-preview img[src="/mock-video-poster.jpg"][data-image-state="ready"]')).toHaveCount(4);
      const requests = await page.evaluate(() => (window as unknown as {
        videoPosterRequests: Array<{ fileId: number; priority: number }>;
      }).videoPosterRequests);
      expect(requests.map(request => request.fileId).sort((a, b) => a - b)).toEqual([930, 931, 932, 940, 941, 942, 943]);
      expect(requests.filter(request => request.fileId >= 940).every(request => request.priority === 19)).toBe(true);
    });
  }
}

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
