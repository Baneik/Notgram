import { expect, test, type Page } from "@playwright/test";
import type { ViewerMessage } from "../../src/utils/mediaViewerModel";
import type { mediaPlaybackCoordinator } from "../../src/media/mediaPlayback";

interface PlaybackFixture {
  messages: ViewerMessage[];
  released: number;
  closed: number;
  loaded: boolean;
  pending?: () => void;
  sync: () => void;
  coordinator: typeof mediaPlaybackCoordinator;
  audioPaused: number;
}
declare global {
  interface Window { playbackFixture: PlaybackFixture }
}

// Exercise the real bridge and viewer with deterministic source acquisition.
// Actual TDLib ranges and WebView2 decoding need the native acceptance matrix.
async function fixture(page: Page, broken = false, delayed = false) {
  await page.route("**/video-fixture", route => route.fulfill({ contentType: "text/html", body: '<button id="open">Open</button>' }));
  await page.goto("/video-fixture");
  await page.evaluate(async ({ broken, delayed }) => {
    const bridgePath = "/src/media/mediaViewerWindowBridge.ts";
    const { openMediaViewerWindow, syncMediaViewerWindow } = await import(bridgePath);
    const coordinatorPath = "/src/media/mediaPlayback.ts";
    const { mediaPlaybackCoordinator } = await import(coordinatorPath);
    const video: ViewerMessage = {
      id: "video", chatId: "fixture", senderId: "self", outgoing: false, sentAt: "", delivery: "read",
      content: { kind: "media", mediaType: "video", fileName: "sample.mp4", fileId: 42,
        size: 100_000, sizeLabel: "100 KB", duration: 20, width: 640, height: 360,
        thumbnailPath: "/mock-video-poster.jpg", caption: "Shared video caption" },
    };
    const photo: ViewerMessage = { ...video, id: "photo", content: { ...video.content, mediaType: "photo",
      fileName: "photo.jpg", fileId: undefined, localPath: "/mock-video-poster.jpg", caption: "Shared photo caption" } };
    const state: PlaybackFixture = {
      messages: [photo, video], released: 0, closed: 0, loaded: !broken, audioPaused: 0,
      coordinator: mediaPlaybackCoordinator, sync: () => syncMediaViewerWindow(state.messages, "dark"),
    };
    window.playbackFixture = state;
    document.querySelector("#open")!.addEventListener("click", () => {
      const save = async () => { throw new Error("save denied"); };
      void openMediaViewerWindow({ messages: state.messages, activeMessageId: "video", colorTheme: "dark" },
        save, save, () => { state.closed++; }, undefined, {
          stream: async () => {
            if (delayed) await new Promise<void>(resolve => { state.pending = resolve; });
            return state.loaded ? "/mock-video.mp4" : "/broken-video.mp4";
          },
          suspend: async () => { state.released++; },
        });
    });
  }, { broken, delayed });
  await page.route("**/broken-video.mp4", route => route.fulfill({ contentType: "video/mp4", body: "broken" }));
  const popup = page.waitForEvent("popup");
  await page.click("#open");
  return popup;
}

async function playable(viewer: Page) {
  const video = viewer.locator("video");
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((element: HTMLVideoElement) => { element.loop = true; });
  if (await video.evaluate((element: HTMLVideoElement) => element.paused)) {
    await viewer.getByRole("button", { name: "播放", exact: true }).click();
  }
  await expect(video).toHaveJSProperty("paused", false);
}

test("mixed media navigation keeps one authoritative video element and releases each lease", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(viewer.locator(".media-viewer-caption")).toHaveText("Shared video caption");
  await viewer.getByRole("button", { name: "查看 photo.jpg", exact: true }).click();
  await expect(viewer.locator("video")).toHaveCount(0);
  await expect(viewer.locator(".media-viewer-image")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(1);
  await viewer.getByRole("button", { name: "查看 sample.mp4", exact: true }).click();
  await playable(viewer);
  await viewer.close();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(2);
});

test("audio activation pauses remote video and video play pauses audio", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  await page.evaluate(() => {
    const state = window.playbackFixture;
    state.coordinator.activate("audio", { pause: () => { state.audioPaused++; } });
  });
  await expect(viewer.locator("video")).toHaveJSProperty("paused", true);
  await viewer.getByRole("button", { name: "播放", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.audioPaused)).toBe(1);
  await viewer.close();
});

test("damaged media exposes retry and recovers in the same viewer", async ({ page }) => {
  const viewer = await fixture(page, true);
  await expect(viewer.getByRole("alert")).toContainText(/格式|解码/);
  await page.evaluate(() => { window.playbackFixture.loaded = true; });
  await viewer.getByRole("button", { name: "重试加载", exact: true }).click();
  await playable(viewer);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  await viewer.close();
});

test("closing during acquisition releases the late stream without reopening", async ({ page, context }) => {
  const viewer = await fixture(page, false, true);
  await expect.poll(() => page.evaluate(() => Boolean(window.playbackFixture.pending))).toBe(true);
  await viewer.close();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.closed)).toBe(1);
  await page.evaluate(() => window.playbackFixture.pending!());
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(1);
  expect(context.pages()).toHaveLength(1);
});

test("download completion preserves the active source and its lease until close", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  const source = await viewer.locator("video").getAttribute("src");
  await page.evaluate(() => {
    const state = window.playbackFixture;
    state.messages = state.messages.map(message => message.id === "video"
      ? { ...message, content: { ...message.content, localPath: "/mock-video.mp4", isDownloaded: true } } : message);
    state.sync();
  });
  await expect(viewer.getByRole("button", { name: "下载视频" })).toHaveAttribute("title", "保存到下载目录");
  await expect(viewer.locator("video")).toHaveAttribute("src", source!);
  expect(await page.evaluate(() => window.playbackFixture.released)).toBe(0);
  await viewer.close();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(1);
});

test("download failures are visible in the requesting viewer", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  await viewer.getByRole("button", { name: "下载视频", exact: true }).click();
  await expect(viewer.locator(".media-viewer-action-error")).toHaveText("文件下载失败");
  await viewer.close();
});
