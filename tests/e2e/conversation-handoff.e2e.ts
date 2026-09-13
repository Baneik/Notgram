import { expect, test, type Page } from "@playwright/test";
import { conversationSwitchRecords } from "./helpers";

const rowSelector = '[data-message-id="handoff-photo"]';
const seedPhoto = async (page: Page, chatId = "chat-product", source = "thumb") => {
  await page.evaluate(async ({ chatId, source }) => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const current = state.messages.get(chatId)!;
    telegramStore.setState({ messages: new Map(state.messages).set(chatId, [...current.filter(message => message.id !== "handoff-photo"), {
      ...current.at(-1)!, chatId, id: "handoff-photo", mediaAlbumId: undefined,
      sentAt: "2027-01-01T00:00:00Z", content: {
        kind: "media", mediaType: "photo", fileName: "handoff.jpg", sizeLabel: "18 KB",
        thumbnailPath: "/mock-video-poster.jpg?thumb", localPath: source === "thumb" ? undefined : `/mock-video-poster.jpg?${source}`,
        width: 480, height: 240, canDownload: false,
      },
    }]) });
  }, { chatId, source });
};

const upgrade = (page: Page, source: string) => page.evaluate(async (source) => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
  const state = telegramStore.getState();
  telegramStore.setState({ messages: new Map(state.messages).set("chat-product",
    state.messages.get("chat-product")!.map((message) => message.id !== "handoff-photo" ? message : ({ ...message,
      content: { ...message.content, localPath: `/mock-video-poster.jpg?${source}` },
    }))) });
}, source);

test("thumbnail stays painted in the same node throughout a delayed original upgrade", async ({ page }) => {
  await page.route("**/mock-video-poster.jpg?original-delay", async (route) => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await seedPhoto(page);
  await expect(page.locator(`${rowSelector} img`)).toHaveCSS("opacity", "1");
  await expect(page.locator(`${rowSelector} .photo-preview`)).toBeInViewport();
  await expect.poll(() => page.locator(".message-list").evaluate(async list => {
    const positions = [];
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      positions.push(list.scrollTop);
    }
    return Math.max(...positions) - Math.min(...positions);
  })).toBe(0);
  await page.evaluate((selector) => {
    const original = document.querySelector<HTMLImageElement>(`${selector} img`)!;
    const frames: Array<{ painted: boolean; oldNode: boolean; top: number; height: number }> = [];
    const started = performance.now();
    const sample = () => {
      const surface = document.querySelector<HTMLElement>(`${selector} .photo-preview`)!;
      const bounds = surface.getBoundingClientRect();
      frames.push({ painted: [...surface.querySelectorAll<HTMLImageElement>("img")].some(image =>
        image.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === "1"),
        oldNode: original.isConnected, top: bounds.top, height: bounds.height });
      if (performance.now() - started < 750) requestAnimationFrame(sample);
    };
    Object.assign(window, { handoffFrames: frames });
    requestAnimationFrame(sample);
  }, rowSelector);
  await upgrade(page, "original-delay");
  await expect(page.locator(`${rowSelector} img[data-image-retained]`)).toHaveCount(1);
  await expect(page.locator(`${rowSelector} img[src$="original-delay"]`)).toHaveAttribute("data-image-state", "ready");
  await page.waitForTimeout(400);
  const frames = await page.evaluate(() => (window as unknown as {
    handoffFrames: Array<{ painted: boolean; oldNode: boolean; top: number; height: number }>;
  }).handoffFrames);
  expect(frames.length).toBeGreaterThan(25);
  expect(frames.every(frame => frame.painted)).toBe(true);
  expect(frames.filter(frame => frame.oldNode).length).toBeGreaterThan(10);
  expect(Math.max(...frames.map(frame => frame.height)) - Math.min(...frames.map(frame => frame.height))).toBeLessThanOrEqual(0.1);
  expect(Math.max(...frames.map(frame => frame.top)) - Math.min(...frames.map(frame => frame.top))).toBeLessThanOrEqual(1);
  await expect(page.locator(`${rowSelector} img`)).toHaveCount(1);
});

test("failed and superseded upgrades cannot erase a decoded thumbnail or the final source", async ({ page }) => {
  await page.route("**/mock-video-poster.jpg?broken", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await seedPhoto(page);
  await expect(page.locator(`${rowSelector} img`)).toHaveCSS("opacity", "1");
  const original = await page.locator(`${rowSelector} img`).elementHandle();
  await upgrade(page, "broken");
  await expect(page.locator(`${rowSelector} img[src$="thumb"]`)).toHaveCSS("opacity", "1");
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (this.currentSrc.endsWith("obsolete")) return new Promise<void>(resolve => Object.assign(window, { releaseHandoffDecode: resolve }));
      return decode.call(this);
    };
  });
  await upgrade(page, "obsolete");
  await page.waitForFunction(() => "releaseHandoffDecode" in window);
  expect(await original!.evaluate(node => node.isConnected && getComputedStyle(node).opacity === "1")).toBe(true);
  await upgrade(page, "final");
  await expect(page.locator(`${rowSelector} img[src$="final"]`)).toHaveAttribute("data-image-state", "ready");
  await page.evaluate(() => (window as unknown as { releaseHandoffDecode: () => void }).releaseHandoffDecode());
  await page.waitForTimeout(100);
  await expect(page.locator(`${rowSelector} img`)).toHaveCount(1);
  await expect(page.locator(`${rowSelector} img`)).toHaveCSS("opacity", "1");
  await expect(page.locator(`${rowSelector} img`)).toHaveAttribute("src", /final$/);
});

test("heavy image snapshots use bounded visible bitmaps and never encode PNG on navigation", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  await seedPhoto(page);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2560; canvas.height = 1440;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let value = 123456;
    for (let i = 0; i < pixels.data.length; i += 4) {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = value & 255; pixels.data[i + 1] = (value >>> 8) & 255;
      pixels.data[i + 2] = (value >>> 16) & 255; pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const source = canvas.toDataURL();
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const base = state.messages.get("chat-product")!.find(message => message.id === "handoff-photo")!;
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", [0, 1, 2].map(index => ({
      ...base, id: `heavy-${index}`, mediaAlbumId: "heavy-album",
      content: { kind: "media", mediaType: "photo", fileName: "noise.png", sizeLabel: "14 MB",
        localPath: source, width: 2560, height: 1440, canDownload: false },
    }))) });
  });
  await expect(page.locator('.media-album-grid img[data-image-state="ready"]')).toHaveCount(3);
  await expect(page.locator('.media-album-grid img').first()).toHaveCSS("opacity", "1");
  const result = await page.evaluate(async () => {
    const snapshots = await import("/src/utils/conversationSwitchSnapshot.ts" as string) as typeof import("../../src/utils/conversationSwitchSnapshot");
    const original = HTMLCanvasElement.prototype.toDataURL;
    let encodes = 0;
    HTMLCanvasElement.prototype.toDataURL = function (...args) { encodes++; return original.apply(this, args); };
    try {
      const start = performance.now();
      const snapshot = snapshots.captureConversationSwitchSnapshot("stress")!;
      const captureMs = performance.now() - start;
      const bitmaps = [...snapshot.content.querySelectorAll<HTMLCanvasElement>('canvas[data-snapshot-media="image"]')]
        .map(canvas => ({ width: canvas.width, height: canvas.height,
          opaque: canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] }));
      snapshots.removeConversationSwitchSnapshot(snapshot);
      const clickedAt = performance.now();
      document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-mia"]')!.click();
      return { captureMs, clickMs: performance.now() - clickedAt, encodes, bitmaps };
    } finally { HTMLCanvasElement.prototype.toDataURL = original; }
  });
  console.log("Heavy-media snapshot", result);
  expect(result.encodes).toBe(0);
  expect(result.bitmaps).toHaveLength(3);
  expect(result.bitmaps.every(bitmap => bitmap.width < 2560 && bitmap.height < 1440 && bitmap.opaque === 255)).toBe(true);
  expect(result.captureMs).toBeLessThan(100);
  expect(result.clickMs).toBeLessThan(100);
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
});

test("visual handoff gates pointer and keyboard input and records media readiness separately", async ({ page }) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(message => message.chatId === "chat-mia");
        this.snapshot.messages = [...this.snapshot.messages.filter(message => message.chatId !== "chat-mia"), {
          ...base, id:"handoff-photo", mediaAlbumId:undefined, sentAt:"2027-01-01T00:00:00Z",
          content:{kind:"media",mediaType:"photo",fileName:"handoff.jpg",sizeLabel:"18 KB",
            localPath:"/mock-video-poster.jpg?slow-destination",width:480,height:240,canDownload:false}
        }];
        this.snapshot.chats = this.snapshot.chats.map(chat => chat.id === "chat-mia" ? {...chat,unreadCount:0,lastReadInboxMessageId:"handoff-photo"} : chat);
        return connect.call(this, listener);
      };
    }` });
  });
  await page.route("**/mock-video-poster.jpg?slow-destination", async route => {
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const frames = await page.evaluate(async () => {
    const start = performance.now();
    document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-mia"]')!.click();
    const frames = [];
    while (performance.now() - start < 450) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const snapshot = document.querySelector<HTMLElement>("[data-conversation-switch-snapshot]");
      const button = document.querySelector<HTMLButtonElement>(".photo-open");
      if (!button) continue;
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      if (snapshot) button.focus();
      frames.push({ at: performance.now() - start, covered: Boolean(snapshot),
        hitButton: Boolean(hit?.closest(".photo-open")), focused: document.activeElement === button,
        inert: Boolean(button.closest("[inert]")) });
    }
    return frames;
  });
  const covered = frames.filter(frame => frame.covered);
  expect(covered.length).toBeGreaterThan(0);
  expect(covered.every(frame => frame.inert && !frame.hitButton && !frame.focused)).toBe(true);
  expect(frames.at(-1)).toMatchObject({ covered: false, hitButton: true, inert: false });
  const uncoveredAt = frames.find(frame => !frame.covered)!.at;
  await expect.poll(async () => (await conversationSwitchRecords(page)).at(-1)?.firstScreenMediaDurationMs).toBeGreaterThan(550);
  const record = (await conversationSwitchRecords(page)).at(-1)!;
  console.log("Presentation stages", record.titleUpdateDurationMs, record.messagesVisibleDurationMs, record.firstScreenMediaDurationMs);
  expect(record.messagesVisibleDurationMs).toBeGreaterThanOrEqual(uncoveredAt - 20);
  expect(record.messagesVisibleDurationMs).toBeLessThan(450);
  expect(record.titleUpdateDurationMs).toBeLessThan(record.messagesVisibleDurationMs as number);
  expect(record.firstScreenMediaDurationMs).toBeGreaterThan(record.messagesVisibleDurationMs as number);
  expect(record.missingStageMask).toBe(0);
});

test("snapshot freezes a visible video frame and excludes offscreen image pixels", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const video = page.locator(".message-list video").last();
  await video.evaluate(element => {
    const video = element as HTMLVideoElement;
    video.src = "/mock-video.mp4";
    video.preload = "auto";
    video.muted = true;
    video.load();
  });
  await expect.poll(() => video.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const result = await page.evaluate(async () => {
    const { captureConversationSwitchSnapshot, removeConversationSwitchSnapshot } =
      await import("/src/utils/conversationSwitchSnapshot.ts" as string) as typeof import("../../src/utils/conversationSwitchSnapshot");
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const video = list.querySelector<HTMLVideoElement>("video")!;
    const source = video.currentSrc;
    const offscreen = new Image();
    offscreen.src = "/mock-video-poster.jpg";
    await offscreen.decode();
    offscreen.className = "snapshot-test-offscreen";
    Object.assign(offscreen.style, { position: "absolute", top: "-10000px", width: "100px", height: "100px" });
    list.querySelector(".message-list-content")!.append(offscreen);
    const snapshot = captureConversationSwitchSnapshot("video-test")!;
    try {
      const frame = snapshot.content.querySelector<HTMLCanvasElement>('canvas[data-snapshot-media="video"]');
      const skipped = snapshot.content.querySelector<HTMLImageElement>(".snapshot-test-offscreen");
      return { frame: frame ? { width: frame.width, height: frame.height,
        alpha: frame.getContext("2d")!.getImageData(frame.width / 2, frame.height / 2, 1, 1).data[3] } : undefined,
        decoderSources: snapshot.content.querySelectorAll("video[src], video source").length,
        offscreenSource: skipped?.getAttribute("src"), offscreenVisibility: skipped?.style.visibility,
        sourceUnchanged: video.currentSrc === source };
    } finally { removeConversationSwitchSnapshot(snapshot); offscreen.remove(); }
  });
  expect(result.frame?.alpha).toBe(255);
  expect(result.frame!.width).toBeLessThanOrEqual(800);
  expect(result.decoderSources).toBe(0);
  expect(result.offscreenSource).toBeNull();
  expect(result.offscreenVisibility).toBe("hidden");
  expect(result.sourceUnchanged).toBe(true);
});

for (const interrupt of ["resize", "background", "reduced-motion"] as const) {
  test(`handoff releases interaction after ${interrupt}`, async ({ page }) => {
    if (interrupt === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(interrupt => {
      document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-mia"]')!.click();
      if (interrupt === "resize") window.dispatchEvent(new Event("resize"));
      if (interrupt === "background") {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      }
    }, interrupt);
    await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
    await expect(page.locator(".message-list-shell[inert], .conversation-header[inert]")).toHaveCount(0);
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".composer textarea")).toBeFocused();
  });
}
