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
  transfer: (requested: boolean, active?: boolean) => void;
  downloadStarted: number;
  finishDownload?: () => void;
}
declare global {
  interface Window { playbackFixture: PlaybackFixture }
}

// Exercise the real bridge and viewer with deterministic source acquisition.
// Actual TDLib ranges and WebView2 decoding need the native acceptance matrix.
async function fixture(page: Page, broken = false, delayed = false, downloadable = false) {
  await page.route("**/video-fixture", route => route.fulfill({ contentType: "text/html", body: '<button id="open">Open</button>' }));
  await page.goto("/video-fixture");
  await page.evaluate(async ({ broken, delayed, downloadable }) => {
    const bridgePath = "/src/media/mediaViewerWindowBridge.ts";
    const { openMediaViewerWindow, syncMediaViewerWindow } = await import(bridgePath);
    const coordinatorPath = "/src/media/mediaPlayback.ts";
    const { mediaPlaybackCoordinator } = await import(coordinatorPath);
    const mapperPath = "/src/telegram/tdlibMapper.ts";
    const { fileDetails } = await import(mapperPath);
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
      coordinator: mediaPlaybackCoordinator, sync: () => syncMediaViewerWindow(state.messages, "dark"), downloadStarted: 0,
      transfer: (requested, active = true) => {
        const file = fileDetails({ "@type": "file", id: 42, size: 100_000, notgram_download_requested: requested,
          local: { is_downloading_active: active, is_downloading_completed: false, can_be_downloaded: true, downloaded_size: 25_000 } });
        state.messages = state.messages.map(message => message.id === "video" ? { ...message, content: { ...message.content, ...file } } : message);
        state.sync();
      },
    };
    window.playbackFixture = state;
    document.querySelector("#open")!.addEventListener("click", () => {
      const save = async () => { throw new Error("save denied"); };
      const download = async () => {
        state.downloadStarted++;
        state.transfer(true);
        await new Promise<void>(resolve => { state.finishDownload = resolve; });
        state.transfer(false);
      };
      void openMediaViewerWindow({ messages: state.messages, activeMessageId: "video", colorTheme: "dark" },
        downloadable ? download : save, save, () => { state.closed++; }, undefined, {
          stream: async () => {
            if (delayed) await new Promise<void>(resolve => { state.pending = resolve; });
            return state.loaded ? "/mock-video.mp4" : "/broken-video.mp4";
          },
          suspend: async () => { state.released++; },
        });
    });
  }, { broken, delayed, downloadable });
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

test("wheel navigation continues through photos and consecutive videos in both directions", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  await page.evaluate(() => {
    const state = window.playbackFixture;
    const [photo, video] = state.messages;
    state.messages.push(
      { ...video!, id: "video-2", content: { ...video!.content, fileId: 43, fileName: "second.mp4" } },
      { ...photo!, id: "photo-2", content: { ...photo!.content, fileName: "last.jpg" } },
    );
    state.sync();
  });
  await expect(viewer.locator(".media-viewer-counter")).toHaveText("2 / 4");
  await viewer.getByRole("button", { name: "查看 photo.jpg", exact: true }).click();
  await expect(viewer.locator(".media-viewer-image")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(1);

  const wheel = async (delta: number, position: number) => {
    const media = viewer.locator(".media-viewer-image, .media-viewer-video");
    await media.hover();
    await viewer.mouse.wheel(0, delta);
    await expect(viewer.locator(".media-viewer-counter")).toHaveText(`${position} / 4`);
  };
  await wheel(120, 2);
  await playable(viewer);
  // The photo zoom shortcut must neither navigate nor apply image zoom to video.
  await viewer.keyboard.down("Control");
  await viewer.mouse.wheel(0, -240);
  await viewer.keyboard.up("Control");
  await expect(viewer.locator(".media-viewer-counter")).toHaveText("2 / 4");
  await expect(viewer.locator(".media-viewer-zoom")).toHaveCount(0);
  await wheel(120, 3);
  await playable(viewer);
  await wheel(120, 4);
  await expect(viewer.locator("video")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(3);
  await wheel(120, 4);
  await wheel(-120, 3);
  await playable(viewer);
  await viewer.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(viewer.locator("video")).toHaveJSProperty("paused", true);
  await wheel(-120, 2);
  await playable(viewer);
  await wheel(-120, 1);
  await expect(viewer.locator("video")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(5);
  await wheel(-120, 1);
  await viewer.close();
});

for (const phase of ["preparing", "failed"] as const) {
  test(`wheel navigation can leave a ${phase} video`, async ({ page }) => {
    const viewer = await fixture(page, phase === "failed", phase === "preparing");
    if (phase === "preparing") {
      await expect.poll(() => page.evaluate(() => Boolean(window.playbackFixture.pending))).toBe(true);
      await expect(viewer.locator(".media-video-loading")).toBeVisible();
    } else {
      await expect(viewer.getByRole("alert")).toContainText(/格式|解码/);
    }
    await viewer.locator(".media-viewer-video-stage").hover();
    await viewer.mouse.wheel(0, -120);
    await expect(viewer.locator(".media-viewer-image")).toBeVisible();
    await expect(viewer.locator("video")).toHaveCount(0);
    if (phase === "preparing") await page.evaluate(() => window.playbackFixture.pending!());
    await expect.poll(() => page.evaluate(() => window.playbackFixture.released)).toBe(1);
    await expect(viewer.locator(".media-viewer-counter")).toHaveText("1 / 2");
    await viewer.close();
  });
}

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

test("stream buffering does not impersonate a download and explicit download stays available", async ({ page }) => {
  const viewer = await fixture(page, false, false, true);
  await playable(viewer);
  const download = viewer.getByRole("button", { name: "下载视频", exact: true });
  await page.evaluate(() => window.playbackFixture.transfer(false));
  await expect(download).toBeEnabled();
  await expect(download).not.toHaveAttribute("aria-busy", "true");
  await expect(viewer.getByRole("progressbar")).toHaveCount(0);
  await download.click();
  await expect.poll(() => page.evaluate(() => window.playbackFixture.downloadStarted)).toBe(1);
  await expect(download).toHaveAttribute("aria-busy", "true");
  await expect(viewer.getByRole("progressbar")).toHaveCount(1);
  await page.evaluate(() => window.playbackFixture.transfer(true, false));
  await expect(viewer.getByRole("progressbar")).toHaveCount(1);
  await page.evaluate(() => window.playbackFixture.finishDownload!());
  await expect(download).toBeEnabled();
  await expect(viewer.getByRole("progressbar")).toHaveCount(0);
  await expect(viewer.locator("video")).toHaveJSProperty("paused", false);
  await viewer.close();
});

test("loading uses only a ring and the poster occupies the final video bounds", async ({ page }) => {
  const viewer = await fixture(page, false, true);
  await viewer.setViewportSize({ width: 1080, height: 900 });
  const loading = viewer.locator(".media-video-loading");
  await expect(loading).toBeVisible();
  await expect(loading).toHaveText("");
  await expect(loading).toHaveAttribute("aria-label", "正在准备视频");
  await expect(loading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const before = (await viewer.locator("video").boundingBox())!;
  expect(before.width).toBe(640);
  expect(before.height).toBe(360);
  await viewer.screenshot({ path: "test-results/video-loading-fixed.png" });
  await page.evaluate(() => window.playbackFixture.pending!());
  await playable(viewer);
  await expect(loading).toHaveCount(0);
  const after = (await viewer.locator("video").boundingBox())!;
  expect(after).toEqual(before);
  await viewer.close();
});

test("buffered seeking and stalled network events recover without a false network failure", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  await viewer.clock.install();
  const video = viewer.locator("video");
  await viewer.getByRole("slider", { name: "视频进度" }).fill("1");
  await expect(viewer.locator(".media-video-loading")).toHaveCount(0);
  // Deterministic event ordering covers a WebView2 seek that emits canplay but
  // no additional playing event, followed by a stalled download of buffered media.
  await video.evaluate((element: HTMLVideoElement) => {
    element.dispatchEvent(new Event("waiting"));
    element.dispatchEvent(new Event("seeking"));
    element.dispatchEvent(new Event("seeked"));
    element.dispatchEvent(new Event("canplay"));
    element.dispatchEvent(new Event("stalled"));
  });
  await viewer.clock.fastForward(21_000);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  await expect(viewer.locator(".media-video-loading")).toHaveCount(0);
  await expect(video).toHaveJSProperty("paused", false);
  await viewer.getByRole("button", { name: "暂停", exact: true }).click();
  const timeline = viewer.getByRole("slider", { name: "视频进度" });
  await timeline.fill("0.4");
  await timeline.fill("1.4");
  await timeline.fill("0.8");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(0.8, 1);
  await expect(viewer.locator(".media-video-loading")).toHaveCount(0);
  await expect(video).toHaveJSProperty("paused", true);
  await viewer.close();
});

test("a tiny poster keeps the same video bounds through loading at narrow and short sizes", async ({ page }) => {
  await page.context().route("**/mock-video-poster.jpg", route => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#455a64"/></svg>' }));
  const viewer = await fixture(page, false, true);
  const video = viewer.locator("video");
  await expect(video).toBeVisible();
  expect(await video.evaluate(async (element: HTMLVideoElement) => {
    const image = new Image(); image.src = element.poster; await image.decode(); return image.naturalWidth;
  })).toBe(160);
  const bounds = [];
  const sizes = [{ width: 1080, height: 900 }, { width: 390, height: 844 }, { width: 1200, height: 500 }];
  for (const size of sizes) {
    await viewer.setViewportSize(size);
    const box = (await video.boundingBox())!;
    expect(box.width).toBeGreaterThan(160);
    expect(box.width / box.height).toBeCloseTo(16 / 9, 2);
    bounds.push(box);
  }
  await page.evaluate(() => window.playbackFixture.pending!());
  await playable(viewer);
  for (const [index, size] of sizes.entries()) {
    await viewer.setViewportSize(size);
    expect(await video.boundingBox()).toEqual(bounds[index]);
  }
  await viewer.close();
});

test("small-window surface invokes native dragging without toggling playback and controls auto-hide", async ({ page }) => {
  const viewer = await fixture(page);
  await playable(viewer);
  await viewer.getByRole("button", { name: "小窗播放", exact: true }).click();
  await viewer.setViewportSize({ width: 640, height: 360 });
  const backdrop = viewer.locator(".media-viewer-backdrop");
  await expect(backdrop).toHaveClass(/is-windowed/);
  await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(viewer.locator(".media-viewer-footer")).toHaveCSS("background-image", "none");
  await expect(viewer.locator(".media-video-controls")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await viewer.evaluate(() => {
    Object.assign(window, { isTauri: true, nativeDragCalls: 0, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "media-test" } },
      convertFileSrc: (path: string) => path,
      invoke: async (command: string) => {
        if (command === "plugin:window|start_dragging") (window as unknown as { nativeDragCalls: number }).nativeDragCalls++;
      },
    } });
  });
  await viewer.mouse.move(100, 100); await viewer.mouse.down();
  await viewer.mouse.move(140, 120, { steps: 5 }); await viewer.mouse.up();
  await expect.poll(() => viewer.evaluate(() => (window as unknown as { nativeDragCalls: number }).nativeDragCalls)).toBe(1);
  await expect(viewer.locator("video")).toHaveJSProperty("paused", false);
  await viewer.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(viewer.locator("video")).toHaveJSProperty("paused", true);
  // Keeping the mouse on the clicked button must not pin the controls open.
  await expect(backdrop).toHaveClass(/is-idle/, { timeout: 5_000 });
  await viewer.mouse.move(120, 80);
  await expect(backdrop).not.toHaveClass(/is-idle/);
  await expect(viewer.locator(".media-viewer-footer")).toHaveCSS("opacity", "1");
  await viewer.screenshot({ path: "test-results/video-small-window-fixed.png" });
  await viewer.getByRole("button", { name: "播放", exact: true }).click();
  await expect(viewer.locator("video")).toHaveJSProperty("paused", false);
  await expect(backdrop).toHaveClass(/is-idle/, { timeout: 5_000 });
  await viewer.mouse.move(120, 90);
  const timeline = (await viewer.getByRole("slider", { name: "视频进度" }).boundingBox())!;
  await viewer.mouse.move(timeline.x + timeline.width * 0.25, timeline.y + timeline.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(timeline.x + timeline.width * 0.65, timeline.y + timeline.height / 2, { steps: 8 });
  await viewer.mouse.up();
  await expect(backdrop).toHaveClass(/is-idle/, { timeout: 5_000 });
  expect(await viewer.evaluate(() => (window as unknown as { nativeDragCalls: number }).nativeDragCalls)).toBe(1);
  await viewer.mouse.move(120, 100);
  await viewer.locator(".media-viewer-stage").focus();
  await viewer.keyboard.press("Tab");
  await expect(viewer.getByRole("slider", { name: "视频进度" })).toBeFocused();
  await viewer.waitForTimeout(2_200);
  await expect(backdrop).not.toHaveClass(/is-idle/);
  await viewer.close();
});
