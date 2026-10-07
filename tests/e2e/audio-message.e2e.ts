import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

async function audioMessage(page: Page) {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  await page.evaluate(async ({ storePath, mapperPath }) => {
    const { telegramStore } = await import(storePath);
    const { mapTdMessageContent } = await import(mapperPath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    const content = mapTdMessageContent({ "@type": "messageAudio", audio: {
      file_name: "track.mp3", title: "A long song title ".repeat(12), performer: "An artist name ".repeat(12),
      duration: 150, mime_type: "audio/mpeg", audio: { id: 4242, size: 2_400_000,
        local: { path: "/mock-video.mp4", is_downloading_completed: true } },
    }, caption: { text: "Audio description" } });
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message =>
      message.id === "p-video" ? { ...message, content } : message));
    telegramStore.setState({ messages });
    // Keep playback events deterministic while the existing decoder fixture loads.
    HTMLMediaElement.prototype.play = function () {
      Object.defineProperty(this, "paused", { configurable: true, value: false });
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      Object.defineProperty(this, "paused", { configurable: true, value: true });
      this.dispatchEvent(new Event("pause"));
    };
  }, { storePath: "/src/store/telegramStore.ts", mapperPath: "/src/telegram/tdlibMapper.ts" });
  return page.getByRole("log").locator('[data-message-id="p-video"]');
}

test("audio CD follows play and pause and respects both reduced motion preferences", async ({ page }) => {
  const row = await audioMessage(page);
  const player = row.locator(".audio-player");
  const disc = player.locator(".audio-disc");
  await expect(player.locator(".audio-quality")).toHaveText("≈128K");
  await expect(player.locator(".audio-quality")).toHaveAttribute("title", "估算平均码率：128 kbps");
  await expect(disc).toHaveCSS("animation-play-state", "paused");
  await player.getByRole("button", { name: "播放 track.mp3" }).click();
  await expect(disc).toHaveCSS("animation-play-state", "running");
  await player.getByRole("button", { name: "暂停 track.mp3" }).click();
  await expect(disc).toHaveCSS("animation-play-state", "paused");
  await player.getByRole("button", { name: "播放 track.mp3" }).click();
  await expect(disc).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(disc).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("html").evaluate(element => element.classList.add("reduce-motion"));
  await expect(disc).toHaveCSS("animation-name", "none");
  await player.getByRole("button", { name: "暂停 track.mp3" }).click();
  await expect(player.getByRole("button", { name: "播放 track.mp3" })).toBeVisible();
});

test("audio metadata and download controls fit a narrow zoomed message with an inset caption divider", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const row = await audioMessage(page);
  await page.locator("html").evaluate(element => {
    element.dataset.theme = "notgram-dark";
    element.style.zoom = "1.25";
  });
  await page.evaluate(async storePath => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message =>
      message.id === "p-video" ? { ...message, content: { ...message.content,
        isDownloaded: false, canDownload: true, isDownloading: true, progress: 0.5 } } : message));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  const player = row.locator(".audio-player");
  await expect(player.getByRole("button", { name: "取消下载 track.mp3" })).toBeVisible();
  await expect(player.locator("strong")).toHaveCSS("text-overflow", "ellipsis");
  await expect(player.locator(".audio-player-artist")).toHaveText("An artist name ".repeat(12).trim());
  await expect.poll(() => player.evaluate(element => {
    const parent = element.getBoundingClientRect();
    return [...element.querySelectorAll("button, input, .audio-disc, .audio-quality, .audio-volume-value")]
      .every(child => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= parent.left - 0.5 && bounds.right <= parent.right + 0.5;
      });
  })).toBe(true);
  const caption = row.locator(".attachment-caption");
  await expect(caption).toHaveText("Audio description");
  const divider = await caption.evaluate(element => {
    const style = getComputedStyle(element, "::before");
    return { left: parseFloat(style.left), right: parseFloat(style.right), height: style.height };
  });
  expect(divider.left).toBeGreaterThan(0);
  expect(divider.right).toBeGreaterThan(0);
  expect(divider.height).toBe("1px");
});
