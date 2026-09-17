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
  await expect(details.locator("span")).toHaveText(["数据中心：DC2", "尺寸：640 × 360", "大小：186 KB"]);
  await expect(details).toHaveCSS("text-align", "left");
  const caption = popup.locator(".media-viewer-caption");
  await expect(caption).toHaveText("新的媒体预览样式");
  await expect(caption).toHaveCSS("text-align", "center");
  const viewerBounds = await popup.locator(".media-viewer-backdrop").boundingBox();
  const viewportSize = popup.viewportSize();
  expect(viewerBounds).toEqual({ x: 0, y: 0, width: viewportSize?.width, height: viewportSize?.height });
  const stage = popup.locator(".media-viewer-stage");
  const overlayColor = await popup.locator("html").evaluate(element => getComputedStyle(element).getPropertyValue("--color-media-backdrop").trim());
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


async function openVideoViewer(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const card = page.locator('[data-message-id="p-video"] .video-preview');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("img")).toBeVisible();
  await expect(card.locator("video, input")).toHaveCount(0);
  const opened = page.waitForEvent("popup"); await card.click();
  const popup = await opened;
  const video = popup.locator("video");
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(element => { (element as HTMLVideoElement).loop = true; });
  if (await video.evaluate(element => (element as HTMLVideoElement).paused)) await popup.getByRole("button", { name: "播放", exact: true }).click();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  return { popup, video, card };
}

test("video cards open one viewer element and the playback keyboard target survives scrolling", async ({ page }) => {
  const { popup, video, card } = await openVideoViewer(page);
  await expect(page.locator('[data-message-id="p-video"] video')).toHaveCount(0);
  await expect(popup.locator('.media-viewer-caption')).toHaveText('这是昨晚导出的交互录屏，麻烦确认最后一段。');
  await popup.locator('.media-viewer-stage').focus();
  await popup.keyboard.press('Space');
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await popup.keyboard.press('Space');
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  await popup.getByRole('slider', {name:'音量'}).fill('0.35');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('notgram.video.volume'))).toBe('0.35');
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(card).toHaveCount(0);
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  await popup.close();
});

test("video mode changes and reopening a preview retain the same paused element", async ({ page, context }) => {
  const { popup, video, card } = await openVideoViewer(page);
  await popup.getByRole('button', {name:'暂停',exact:true}).click();
  await video.evaluate(element => { (window as unknown as { savedVideo: Element }).savedVideo = element; });
  await popup.getByRole('slider',{name:'视频进度'}).fill('1');
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1);
  await popup.getByRole('button',{name:'沉浸播放',exact:true}).click();
  await expect(popup.locator('.media-viewer-backdrop')).toHaveClass(/is-immersive/);
  await popup.getByRole('button',{name:'小窗播放',exact:true}).click();
  await expect(popup.locator('.media-viewer-backdrop')).toHaveClass(/is-windowed/);
  await card.click();
  await expect(popup.locator('.media-viewer-backdrop')).not.toHaveClass(/is-windowed/);
  expect(context.pages()).toHaveLength(2);
  expect(await video.evaluate(element => element === (window as unknown as {savedVideo: Element}).savedVideo)).toBe(true);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1);
  await popup.close();
});

test("video timeline text stays open and blank viewer backdrop returns typing focus", async ({ page }) => {
  const { popup } = await openVideoViewer(page);
  await popup.locator('.media-video-timeline span').first().click();
  expect(popup.isClosed()).toBe(false);
  const closed = popup.waitForEvent('close');
  await popup.mouse.click(3, 3); await closed;
  await page.bringToFront();
  await expect(page.getByRole('textbox',{name:'消息内容'})).toBeFocused();
});

test("context-menu playback opens the shared viewer directly as a small window", async ({ page }) => {
  await page.goto('/'); await page.getByRole('button',{name:/产品讨论/}).first().click();
  const card = page.locator('[data-message-id="p-video"] .video-preview'); await card.scrollIntoViewIfNeeded();
  await card.click({button:'right'});
  const opened = page.waitForEvent('popup');
  await page.getByRole('menuitem',{name:'以小窗播放',exact:true}).click();
  const popup = await opened;
  await expect(popup.locator('.media-viewer-backdrop')).toHaveClass(/is-windowed/);
  await expect(popup.locator('video')).toHaveAttribute('src', /mock-video/);
  await popup.close();
});
