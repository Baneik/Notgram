import { expect, test } from "@playwright/test";
import { horizontalOverflow, revealVirtualMessage } from "./helpers";

test("audio messages continue to the next item in the same conversation", async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as {
      __notgramAudioContext?: { state: string };
      __notgramAudioLifecycle: string[];
    };
    scope.__notgramAudioLifecycle = [];
    class TestAudioContext {
      state = "suspended";
      destination = {};

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 128,
          connect: () => undefined,
          getByteFrequencyData: (values: Uint8Array) => values.fill(0),
        };
      }

      createMediaElementSource() {
        return { connect: () => undefined };
      }

      resume() {
        scope.__notgramAudioLifecycle.push("resume");
        this.state = "running";
        return Promise.resolve();
      }

      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: class extends TestAudioContext {
        constructor() {
          super();
          scope.__notgramAudioContext = this;
        }
      },
    });
  });
  await page.goto("/");
  await expect(page.locator('[data-message-id="p-audio"] audio')).toHaveCount(0);
  const audioEngine = page.locator(".persistent-audio-engine");
  await expect(audioEngine).toHaveCount(1);
  await expect(audioEngine).toHaveAttribute("crossorigin", "anonymous");
  await page.evaluate(() => {
    const scope = window as unknown as {
      __notgramAudioLifecycle: string[];
      __notgramAudioPlayCalls: string[];
    };
    scope.__notgramAudioPlayCalls = [];
    HTMLMediaElement.prototype.play = function play() {
      const playbackId = this.dataset.playbackId;
      if (playbackId) {
        scope.__notgramAudioLifecycle.push("play");
        scope.__notgramAudioPlayCalls.push(playbackId);
      }
      return Promise.resolve();
    };
  });
  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioPlayCalls: string[] }
  ).__notgramAudioPlayCalls)).toContain("chat-product:p-audio");
  await expect(audioEngine).toHaveAttribute("src", /mock-video\.mp4/);
  await expect(audioEngine).toHaveJSProperty("muted", false);
  await expect(audioEngine).toHaveJSProperty("volume", 1);
  expect(await page.evaluate(() => (
    window as unknown as { __notgramAudioLifecycle: string[] }
  ).__notgramAudioLifecycle.slice(0, 2))).toEqual(["resume", "play"]);
  await page.evaluate(() => {
    const scope = window as unknown as {
      __notgramAudioContext?: { state: string };
    };
    if (scope.__notgramAudioContext) scope.__notgramAudioContext.state = "suspended";
    document.querySelector<HTMLAudioElement>(".persistent-audio-engine")
      ?.dispatchEvent(new Event("playing"));
  });
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioLifecycle: string[] }
  ).__notgramAudioLifecycle.filter((event) => event === "resume").length)).toBe(2);
  await audioEngine.evaluate((audio) => audio.dispatchEvent(new Event("ended")));
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioPlayCalls: string[] }
  ).__notgramAudioPlayCalls)).toContain("chat-product:p-audio-next");
});

test("audio controls remember volume and keep the collapsible player inside the conversation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });

  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  const audioEngine = page.locator(".persistent-audio-engine");
  const controller = page.getByRole("complementary", { name: "正在播放 产品语音.m4a" });
  await expect(controller).toBeVisible();
  const expandedBounds = await controller.boundingBox();

  const volume = controller.getByRole("slider", { name: "音量" });
  await expect(volume).toHaveAttribute("step", "0.01");
  const floatingVolumeBounds = await volume.boundingBox();
  expect(floatingVolumeBounds).not.toBeNull();
  expect(floatingVolumeBounds!.width).toBeGreaterThanOrEqual(84);
  await volume.fill("0.35");
  await expect(audioEngine).toHaveJSProperty("volume", 0.35);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("notgram.audio.volume")))
    .toBe("0.35");
  await controller.getByRole("button", { name: "静音" }).click();
  await expect(audioEngine).toHaveJSProperty("muted", true);
  await expect(controller.getByRole("button", { name: "取消静音" })).toBeVisible();
  await volume.fill("0.55");
  await expect(audioEngine).toHaveJSProperty("muted", false);
  await expect(audioEngine).toHaveJSProperty("volume", 0.55);

  const conversation = page.locator(".conversation");
  await expect(controller.getByRole("button", { name: /拖动播放器/ })).toHaveCount(0);
  const controllerBounds = await controller.boundingBox();
  expect(controllerBounds).not.toBeNull();
  await page.mouse.move(controllerBounds!.x + 12, controllerBounds!.y + controllerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, 0, { steps: 3 });
  await page.mouse.up();

  const topLeft = await controller.boundingBox();
  const conversationBounds = await conversation.boundingBox();
  expect(topLeft).not.toBeNull();
  expect(conversationBounds).not.toBeNull();
  expect(topLeft!.x).toBeGreaterThanOrEqual(conversationBounds!.x + 11);
  expect(topLeft!.y).toBeGreaterThanOrEqual(conversationBounds!.y + 11);

  const movedControllerBounds = await controller.boundingBox();
  await page.mouse.move(
    movedControllerBounds!.x + 12,
    movedControllerBounds!.y + movedControllerBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(2_000, 2_000, { steps: 3 });
  await page.mouse.up();
  const bottomRight = await controller.boundingBox();
  expect(bottomRight!.x + bottomRight!.width)
    .toBeLessThanOrEqual(conversationBounds!.x + conversationBounds!.width - 11);
  expect(bottomRight!.y + bottomRight!.height)
    .toBeLessThanOrEqual(conversationBounds!.y + conversationBounds!.height - 11);

  const movedPlay = controller.getByRole("button", { name: "暂停" });
  const movedPlayBounds = await movedPlay.boundingBox();
  await page.mouse.move(
    movedPlayBounds!.x + movedPlayBounds!.width / 2,
    movedPlayBounds!.y + movedPlayBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    movedPlayBounds!.x - 80,
    movedPlayBounds!.y - 60,
    { steps: 3 },
  );
  await page.mouse.up();
  await expect(movedPlay).toBeVisible();

  await controller.getByRole("button", { name: "缩小播放器" }).click();
  await expect(controller).toHaveClass(/is-compact/);
  await expect(controller.locator(".audio-floating-progress")).toHaveCount(0);
  await expect(controller.locator(".audio-spectrum")).toHaveCount(0);
  await expect(controller.getByRole("button", { name: "暂停" })).toBeVisible();
  await expect(controller.getByRole("button", { name: "展开播放器" })).toBeVisible();
  const compactBounds = await controller.boundingBox();
  expect(compactBounds!.width).toBeLessThan(expandedBounds!.width);
});

test("audio message controls remain inside their bubble at narrow conversation widths", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  const audio = page.getByRole("group", { name: "产品语音.m4a" });
  const bubble = audio.locator("xpath=ancestor::*[contains(@class, 'message-bubble')][1]");
  const volume = audio.getByRole("slider", { name: "音量" });
  await expect(audio).toBeVisible();
  await expect(volume).toHaveAttribute("step", "0.01");
  const volumeBounds = await volume.boundingBox();
  expect(volumeBounds).not.toBeNull();
  expect(volumeBounds!.width).toBeGreaterThanOrEqual(68);
  const geometry = await audio.evaluate((element) => {
    const bubbleElement = element.closest<HTMLElement>(".message-bubble");
    const player = element.getBoundingClientRect();
    const parent = bubbleElement?.getBoundingClientRect();
    return { player, parent };
  });
  expect(geometry.parent).toBeTruthy();
  expect(geometry.player.left).toBeGreaterThanOrEqual(geometry.parent!.left - 0.5);
  expect(geometry.player.right).toBeLessThanOrEqual(geometry.parent!.right + 0.5);
  expect(geometry.player.top).toBeGreaterThanOrEqual(geometry.parent!.top - 0.5);
  expect(geometry.player.bottom).toBeLessThanOrEqual(geometry.parent!.bottom + 0.5);
  expect(geometry.player.width).toBeLessThanOrEqual(geometry.parent!.width);
  await expect(bubble).toHaveCount(1);
});

test("single-clicking a photo opens a dedicated fullscreen viewer with wheel zoom and dragging", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  await revealVirtualMessage(page, "p-5");
  await page.evaluate(async (storePath) => {
    type ViewerMessage = {
      id: string;
      sentAt: string;
      content: { kind: string; fileName?: string; caption?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, ViewerMessage[]> };
        setState: (partial: {
          messages: Map<string, ViewerMessage[]>;
          saveFileToDownloads: (sourcePath: string, fileName: string) => Promise<void>;
          saveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const sourceEntry = [...messages.entries()].find(([, items]) =>
      items.some((message) => message.id === "p-5"));
    if (!sourceEntry) throw new Error("Missing source photo for media viewer test");
    const [sourceChatId, sourceMessages] = sourceEntry;
    const source = sourceMessages.find((message) => message.id === "p-5")!;
    const downloadedSource: ViewerMessage = {
      ...source,
      content: {
        ...source.content,
        localPath: "/mock-video-poster.jpg",
        isDownloaded: true,
        isDownloading: false,
        canDownload: false,
        progress: undefined,
      },
    };
    const additions = Array.from({ length: 8 }, (_, index): ViewerMessage => ({
      ...downloadedSource,
      id: `p-viewer-extra-${index + 1}`,
      sentAt: new Date(Date.parse(source.sentAt) + (index + 1) * 1_000).toISOString(),
      content: {
        ...downloadedSource.content,
        fileName: `查看器补充图片-${index + 1}.jpg`,
        caption: "",
      },
    }));
    messages.set(sourceChatId, [
      ...sourceMessages.map((message) => message.id === source.id ? downloadedSource : message),
      ...additions,
    ]);
    const testWindow = window as unknown as {
      __notgramViewerSavedFiles: Array<[string, string]>;
      __notgramViewerSaveAsFiles: Array<[string, string]>;
    };
    testWindow.__notgramViewerSavedFiles = [];
    testWindow.__notgramViewerSaveAsFiles = [];
    storeModule.telegramStore.setState({
      messages,
      saveFileToDownloads: async (sourcePath, fileName) => {
        testWindow.__notgramViewerSavedFiles.push([sourcePath, fileName]);
      },
      saveFileAs: async (sourcePath, fileName) => {
        testWindow.__notgramViewerSaveAsFiles.push([sourcePath, fileName]);
      },
    });
  }, "/src/store/telegramStore.ts");
  const sourcePhoto = await revealVirtualMessage(page, "p-5");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.focus();
  const popupPromise = page.waitForEvent("popup");
  await sourcePhoto.locator(".photo-open").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await popup.setViewportSize({ width: 1080, height: 720 });

  await expect(page.getByRole("dialog", { name: "图片查看器：界面预览.jpg" })).toHaveCount(0);
  await expect(popup.getByRole("dialog", { name: "图片查看器：界面预览.jpg" })).toBeVisible();
  const viewer = popup.locator(".media-viewer");
  await expect.poll(() => viewer.evaluate((element) => {
    const animations = element.getAnimations({ subtree: false });
    return animations.length > 0 && animations.every((animation) => animation.playState === "finished");
  })).toBe(true);
  const downloadButton = viewer.getByRole("button", { name: "下载图片" });
  await expect(viewer.locator(".media-viewer-toolbar")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "关闭图片查看器" })).toHaveCount(0);
  await expect(downloadButton).toBeVisible();
  await expect(downloadButton).not.toBeFocused();
  await expect.poll(() => popup.evaluate(() => document.activeElement?.classList.contains("media-viewer-stage"))).toBe(true);
  const details = viewer.getByLabel("图片详细信息");
  await expect(details.locator("span")).toHaveText(["数据中心：DC2", "尺寸：512 × 512", "大小：186 KB"]);
  await expect(details).toHaveCSS("text-align", "left");
  const caption = popup.locator(".media-viewer-caption");
  await expect(caption).toHaveText("新的媒体预览样式");
  await expect(caption).toHaveCSS("text-align", "center");
  const viewerBounds = await popup.locator(".media-viewer-backdrop").boundingBox();
  const viewportSize = popup.viewportSize();
  expect(viewerBounds).toEqual({ x: 0, y: 0, width: viewportSize?.width, height: viewportSize?.height });
  const stage = popup.locator(".media-viewer-stage");
  const overlayColor = await popup.locator("html").evaluate(element => getComputedStyle(element).getPropertyValue("--color-overlay").trim());
  await expect(popup.locator(".media-viewer-backdrop")).toHaveCSS("background-color", overlayColor);
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  const thumbnails = viewer.getByRole("navigation", { name: "会话图片预览" });
  await expect(thumbnails.getByRole("button")).toHaveCount(9);
  await expect(thumbnails.locator("img")).toHaveCount(9);
  await expect(thumbnails).toHaveCSS("overflow-x", "hidden");
  await expect(thumbnails).toHaveCSS("scrollbar-width", "none");
  await expect(thumbnails.locator("img").first()).toHaveAttribute("loading", "eager");
  await expect.poll(() => thumbnails.locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(thumbnails.getByRole("button", { name: "查看 界面预览.jpg" })).toHaveAttribute("aria-current", "true");
  const detailsBounds = (await details.boundingBox())!;
  const thumbnailBounds = (await thumbnails.boundingBox())!;
  const captionBounds = (await caption.boundingBox())!;
  expect(detailsBounds.x + detailsBounds.width).toBeLessThanOrEqual(thumbnailBounds.x);
  expect(captionBounds.y + captionBounds.height).toBeLessThan(thumbnailBounds.y);
  const imageViewport = popup.locator(".media-viewer-viewport");
  await imageViewport.hover();
  await popup.keyboard.down("Control"); await popup.mouse.wheel(0, -240); await popup.keyboard.up("Control");
  const surface = popup.locator(".media-viewer-surface");
  await expect(surface).toHaveAttribute("style", /scale\(1\.5\)/);
  await popup.keyboard.press("+");
  await expect(surface).toHaveAttribute("style", /scale\(2\.25\)/);
  const beforePan = await surface.evaluate(element => (element as HTMLElement).style.transform);
  const imageBounds = (await imageViewport.boundingBox())!;
  await popup.mouse.move(imageBounds.x + imageBounds.width / 2, imageBounds.y + imageBounds.height / 2);
  await popup.mouse.down(); await popup.mouse.move(imageBounds.x + imageBounds.width / 2 + 48, imageBounds.y + imageBounds.height / 2 + 32); await popup.mouse.up();
  expect(await surface.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(beforePan);
  const previousNavigationBounds = await viewer.getByRole("button", { name: "上一张" }).boundingBox();
  await popup.keyboard.press("ArrowLeft");
  await expect(viewer).toHaveAttribute("aria-label", "图片查看器：纵向图片.jpg");
  await expect(details.locator("span")).toHaveText(["数据中心：DC4", "尺寸：512 × 512", "大小：220 KB"]);
  await expect(popup.locator(".media-viewer-caption")).toHaveText("纵向图片应该按实际比例收窄，外壳不能留下额外空白。");
  await expect(surface).toHaveAttribute("style", /scale\(1\)/);
  const nextNavigationBounds = await viewer.getByRole("button", { name: "下一张" }).boundingBox();
  expect(nextNavigationBounds!.y).toBeCloseTo(previousNavigationBounds!.y, 0);
  await thumbnails.getByRole("button", { name: "查看 界面预览.jpg" }).click();
  await expect(viewer).toHaveAttribute("aria-label", "图片查看器：界面预览.jpg");
  await expect(popup.locator(".media-viewer-caption")).toHaveText("新的媒体预览样式");
  await downloadButton.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __notgramViewerSavedFiles: Array<[string, string]> }).__notgramViewerSavedFiles)).toEqual([["/mock-video-poster.jpg", "界面预览.jpg"]]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __notgramViewerSaveAsFiles: Array<[string, string]> }).__notgramViewerSaveAsFiles)).toEqual([]);
  const closed = popup.waitForEvent("close");
  const finalStageBounds = await stage.boundingBox();
  await popup.mouse.click(finalStageBounds!.x + 8, finalStageBounds!.y + 8);
  await closed;
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(composer).toBeFocused();
});

test("captioned albums keep descriptions in the fullscreen viewer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const album = page.locator('[data-media-album-id="mock-album-product"]');
  await expect(album).toBeVisible();
  await expect(album.locator(".media-album-captions")).toHaveCount(0);
  await expect(album).not.toContainText("新的媒体预览样式");
  for (const viewport of [
    { width: 1220, height: 780 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await album.scrollIntoViewIfNeeded();
    const geometry = await album.evaluate((element) => ({
      albumHeight: element.getBoundingClientRect().height,
      gridHeight: element.querySelector<HTMLElement>(".media-album-grid")?.getBoundingClientRect().height,
    }));
    expect(geometry.gridHeight).toBeDefined();
    expect(geometry.albumHeight).toBeCloseTo(geometry.gridHeight!, 0);
    expect(await horizontalOverflow(page)).toBe(false);
  }

  const popupPromise = page.waitForEvent("popup");
  await page.locator('[data-message-id="p-5"] .photo-open').click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup.locator(".media-viewer-caption")).toHaveText("新的媒体预览样式");
  await popup.keyboard.press("ArrowLeft");
  await expect(popup.locator(".media-viewer-caption"))
    .toHaveText("纵向图片应该按实际比例收窄，外壳不能留下额外空白。");

  const closed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await closed;
});

test("video uses synchronized transparent playback windows and owns the playback spacebar", async ({ page }) => {
  await page.context().addInitScript(() => {
    const pausedState = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() {
        return {
          length: 1,
          start: () => 0,
          end: () => Number.isFinite(this.duration) ? Math.min(this.duration, 0.5) : 0.5,
        } as TimeRanges;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return pausedState.get(this) ?? true;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (pausedState.get(this) === false) return Promise.resolve();
        pausedState.set(this, false);
        this.dispatchEvent(new Event("play"));
        this.dispatchEvent(new Event("playing"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (pausedState.get(this) ?? true) return;
        pausedState.set(this, true);
        this.dispatchEvent(new Event("pause"));
      },
    });
  });
  await page.setViewportSize({ width: 1_100, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const row = page.locator('[data-message-id="p-video"]');
  const player = row.locator(".video-player");
  const video = player.locator("video");

  await expect(player).toBeVisible();
  await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
  await expect(video).toHaveAttribute("poster", /mock-video-poster\.jpg/);
  await expect(video).not.toHaveAttribute("controls", "");
  await expect(player.getByRole("slider", { name: "播放进度" })).toBeVisible();
  await expect(player.getByRole("button", { name: "打开声音" })).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.2);

  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect(video).toHaveAttribute("src", /mock-video\.mp4/);
  await expect(video).toHaveAttribute("preload", "auto");
  await video.dispatchEvent("canplay");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await video.dispatchEvent("waiting");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await video.dispatchEvent("playing");
  await expect.poll(() => player.getByRole("slider", { name: "播放进度" }).evaluate(
    (element) => getComputedStyle(element).backgroundSize,
  )).toBe("100% 3px");

  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await settingsButton.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await expect.poll(() => settingsButton.evaluate((element) => document.activeElement !== element))
    .toBe(true);

  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.focus();
  await page.keyboard.press("Space");
  await expect(composer).toHaveJSProperty("value", " ");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await composer.fill("");

  const messageList = page.locator(".message-list");
  await messageList.hover();
  await page.mouse.wheel(0, -240);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await row.click({ button: "right" });
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(actionMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(actionMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await expect(actionMenu.getByRole("menuitem", { name: "以小窗播放" })).toBeVisible();
  await expect(actionMenu.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await actionMenu.getByRole("menuitem", { name: "以小窗播放" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const popupPlayer = popup.locator(".video-window");
  const popupVideo = popupPlayer.locator("video");
  await expect(popupPlayer).toHaveClass(/is-windowed/);
  await expect(popupVideo).toHaveAttribute("src", /mock-video\.mp4/);
  await popupVideo.dispatchEvent("loadedmetadata");
  await expect(player).toBeVisible();
  await expect(player).not.toHaveClass(/is-floating/);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  const windowedControls = popup.locator(".video-windowed-controls");
  await popup.mouse.move(120, 80);
  await expect.poll(() => windowedControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("1");
  await popup.getByRole("slider", { name: "音量" }).fill("0.35");
  await popup.waitForTimeout(1_100);
  await expect.poll(() => windowedControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("0");
  const popupBounds = await popupPlayer.boundingBox();
  await popup.mouse.click(40, popupBounds!.height / 2);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await popup.keyboard.press("f");
  await expect(popupPlayer).toHaveClass(/is-fullscreen/);
  await popupVideo.evaluate((element) => {
    element.style.width = "70%";
    element.style.margin = "0 auto";
  });
  await expect.poll(() => popupVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await popup.mouse.move(550, 360);
  const controls = popup.locator(".video-fullscreen-controls");
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  await expect(popup.getByRole("button", { name: "下载视频" })).toBeVisible();
  const controlsBounds = await controls.boundingBox();
  expect(Math.round(controlsBounds!.width)).toBe(550);
  expect(Math.round(controlsBounds!.height)).toBe(80);
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  const popupOverlayColor = await popup.locator("html").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--color-overlay").trim());
  await expect(popupPlayer).toHaveCSS("background-color", popupOverlayColor);

  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("0");
  const popupClosed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await popupClosed;
  await expect(player).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);
  await page.reload();
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const restoredVideo = page.locator('[data-message-id="p-video"] video');
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
});

test("video fullscreen has a persistent preview layer, playback layer, and mini-window escape", async ({ page }) => {
  await page.setViewportSize({ width: 1_100, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const row = page.locator('[data-message-id="p-video"]');
  const player = row.locator(".video-player");
  const inlineProgress = player.getByRole("slider", { name: "播放进度" });
  await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
  await expect(player).toBeVisible();
  await expect(inlineProgress).toBeVisible();
  const inlineProgressGeometry = await inlineProgress.evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: style.left, bottom: style.bottom, width: style.width, backgroundPosition: style.backgroundPosition };
  });
  expect(inlineProgressGeometry.left).toBe("0px");
  expect(inlineProgressGeometry.bottom).toBe("0px");
  expect(inlineProgressGeometry.width).toBe(`${await player.evaluate((element) => element.getBoundingClientRect().width)}px`);
  expect(inlineProgressGeometry.backgroundPosition).toContain("100%");

  const popupPromise = page.waitForEvent("popup");
  await player.dblclick();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const window = popup.locator(".video-window");
  const controls = popup.locator(".video-fullscreen-controls");
  await expect(window).toHaveClass(/is-fullscreen/);
  await expect(window).toHaveClass(/is-preview/);
  await expect(window).toHaveAttribute("data-video-mode", "preview");
  await expect(popup.getByRole("button", { name: "放大" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "小窗播放" })).toBeVisible();
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  const previewVideoBounds = await popup.locator("video").boundingBox();
  const previewWindowBounds = await window.boundingBox();
  expect(previewVideoBounds?.height).toBeLessThan(previewWindowBounds?.height ?? 0);

  await popup.getByRole("button", { name: "放大" }).click();
  await expect(window).toHaveClass(/is-playback/);
  await expect(window).toHaveAttribute("data-video-mode", "playback");
  await expect(popup.getByRole("button", { name: "缩小" })).toBeVisible();
  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  const controlsBounds = await controls.boundingBox();
  await popup.mouse.move((controlsBounds?.x ?? 0) + (controlsBounds?.width ?? 0) / 2, (controlsBounds?.y ?? 0) + 20);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await popup.getByRole("button", { name: "缩小" }).click();
  await expect(window).toHaveClass(/is-preview/);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await popup.getByRole("button", { name: "小窗播放" }).click();
  await expect(window).toHaveClass(/is-windowed/);
  await expect(window).toHaveAttribute("data-video-mode", "window");
  await expect(popup.locator("video")).toHaveAttribute("data-tauri-drag-region", "");
  await popup.close();
});

test("video fullscreen preview closes from its blank surface", async ({ page }) => {
  await page.setViewportSize({ width: 1_100, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const player = page.locator('[data-message-id="p-video"] .video-player');
  await player.scrollIntoViewIfNeeded();

  const popupPromise = page.waitForEvent("popup");
  await player.dblclick();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const window = popup.locator(".video-window");
  const video = popup.locator("video");
  await expect(window).toHaveAttribute("data-video-mode", "preview");
  await video.evaluate((element) => {
    element.style.width = "70%";
    element.style.margin = "0 auto";
  });
  const videoBounds = await video.boundingBox();
  expect(videoBounds?.x).toBeGreaterThan(0);

  const popupClosed = popup.waitForEvent("close");
  await popup.mouse.click(Math.max(4, (videoBounds?.x ?? 20) / 2), 120);
  await popupClosed;
  await page.bringToFront();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
});
