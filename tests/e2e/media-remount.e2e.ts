import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Message } from "../../src/telegram/types";

type StoreModule = typeof import("../../src/store/telegramStore");
let server: Server;
let assets: string;
const requests = new Map<string, number>();
const image = readFileSync("tests/fixtures/public/mock-video-poster.jpg");
const video = readFileSync("tests/fixtures/sticker.webm");
const animation = gzipSync(JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 60, w: 180, h: 180, ddd: 0, assets: [], layers: [
  { ddd: 0, ind: 1, ty: 4, sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [90, 90, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, ao: 0,
    shapes: [{ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [160, 160] } }, { ty: "fl", c: { a: 0, k: [0.2, 0.6, 0.9, 1] }, o: { a: 0, k: 100 }, r: 1 }], ip: 0, op: 60, st: 0, bm: 0 },
] }));

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.set(path, (requests.get(path) ?? 0) + 1);
    const body = path.endsWith(".tgs") ? animation : path.endsWith(".webm") ? video : image;
    response.writeHead(200, {
      "Content-Type": path.endsWith(".tgs") ? "application/gzip" : path.endsWith(".webm") ? "video/webm" : "image/jpeg",
      "Content-Length": body.length,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  assets = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

const prepare = async (page: Page, videoSticker = false) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async ({ assets, videoSticker }) => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    const state = telegramStore.getState();
    const seed = state.messages.get("chat-product")!.at(-1)!;
    const userSeed = state.users.values().next().value!;
    const users = new Map(state.users);
    for (let index = 0; index < 4; index++) users.set(`remount-user-${index}`, {
      ...userSeed, id: `remount-user-${index}`, displayName: `Remount ${index}`,
      avatar: { label: String(index), color: "#aabbcc", imagePath: `${assets}/avatar-${index}.jpg` },
    });
    const timestamp = Date.now() + 60_000;
    const rows: Message[] = Array.from({ length: 100 }, (_, index) => ({
      ...seed, id: `remount-history-${index}`, renderKey: undefined, mediaAlbumId: undefined, replyTo: undefined,
      senderId: "u-mia", outgoing: false, sentAt: new Date(timestamp + index * 1000).toISOString(),
      content: { kind: "text", text: `History ${index}: exercise the actual conversation virtual list.` },
    }));
    for (let index = 0; index < 3; index++) rows.push({
      ...seed, id: `remount-media-${index}`, renderKey: undefined, mediaAlbumId: undefined, replyTo: undefined,
      senderId: `remount-user-${index}`, outgoing: false, sentAt: new Date(timestamp + (101 + index) * 1000).toISOString(),
      content: { kind: "media", mediaType: "sticker", fileId: 98000 + index,
        fileName: index === 1 ? videoSticker ? "sticker.webm" : "sticker.tgs" : "sticker.jpg",
        mimeType: index === 1 ? videoSticker ? "video/webm" : "application/x-tgsticker" : "image/jpeg",
        localPath: `${assets}/${index === 1 ? videoSticker ? "sticker.webm" : "sticker.tgs" : `sticker-${index}.jpg`}`,
        width: 180, height: 180, sizeLabel: "1 KB", isDownloaded: true, canDownload: false },
    });
    rows.push({ ...seed, id: "remount-reply", renderKey: undefined, mediaAlbumId: undefined,
      senderId: "remount-user-3", outgoing: false, sentAt: new Date(timestamp + 105_000).toISOString(),
      replyTo: { kind: "message", chatId: "chat-product", messageId: rows[10].id, content: rows[10].content },
      content: { kind: "text", text: "Return here after following this reference" },
    });
    const downloads: string[] = [];
    Object.assign(window, { remountDownloads: downloads });
    telegramStore.setState({ users, messages: new Map(state.messages).set("chat-product", rows),
      cacheFile: async (...args) => { downloads.push("cache"); return state.cacheFile(...args); },
      recoverFile: async (...args) => { downloads.push("recover"); return state.recoverFile(...args); },
      getCachedStickerOutline: () => "M0 0H180V180H0Z", loadStickerOutline: async () => "M0 0H180V180H0Z",
    });
  }, { assets, videoSticker });
  await expect(page.locator('[data-message-id="remount-reply"]')).toBeVisible();
  await expect(page.locator('.message-list [data-message-id^="remount-media-"]')).toHaveCount(3);
  await expect(page.locator('.message-list .sticker-placeholder')).toHaveCount(0);
  await expect.poll(() => page.locator('.message-list .avatar img').evaluateAll(images =>
    images.every(image => image.getAttribute("data-image-state") === "ready"))).toBe(true);
};

const leaveLatest = async (page: Page) => {
  await page.locator('[data-message-id="remount-reply"] .message-reply-preview').click();
  await expect(page.locator('[data-message-id="remount-history-10"]')).toHaveClass(/is-notification-target/);
  await expect(page.locator('.message-list [data-message-id^="remount-media-"]')).toHaveCount(0);
};

const returnFrames = (page: Page) => page.locator(".jump-to-latest").evaluate(async button => {
  const frames: Array<{ avatars: number; fallback: number; stickers: number; outlines: number; empty: number }> = [];
  const originalList = document.querySelector(".message-list");
  (button as HTMLButtonElement).click();
  for (let index = 0; index < 35; index++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const list = document.querySelector(".message-list")!;
    if (list !== originalList) throw new Error("The conversation list was unexpectedly replaced");
    const bounds = list.getBoundingClientRect();
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > bounds.top && box.top < bounds.bottom;
    };
    const painted = (element: Element) => {
      if (element.querySelector(".cached-media-preview > canvas, .cached-media-preview > svg")) return true;
      if ([...element.querySelectorAll<HTMLImageElement>("img")].some(image =>
        image.complete && image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) === 1)) return true;
      if ([...element.querySelectorAll<HTMLVideoElement>("video")].some(video => video.readyState >= 2)) return true;
      return Boolean(element.querySelector(".tgs-sticker svg path"));
    };
    const avatars = [...list.querySelectorAll(".message-group-avatar .avatar")].filter(visible);
    const stickers = [...list.querySelectorAll('[data-message-id^="remount-media-"]')].filter(visible);
    frames.push({ avatars: avatars.length, fallback: avatars.filter(avatar => !painted(avatar)).length,
      stickers: stickers.length, outlines: stickers.filter(sticker => sticker.querySelector(".sticker-placeholder")).length,
      empty: stickers.filter(sticker => !painted(sticker)).length });
  }
  return frames;
});

for (const kind of ["tgs", "metadata eviction", "video"] as const) {
  test(`reply jumps preserve avatar and ${kind} sticker pixels from the first returned frame`, async ({ page }) => {
    await prepare(page, kind === "video");
    const tgsRequests = requests.get("/sticker.tgs");
    for (let iteration = 0; iteration < 2; iteration++) {
      await leaveLatest(page);
      if (kind === "metadata eviction") await page.evaluate(async () => {
        const { rememberDecodedImage } = await import("/src/media/decodedImages.ts" as string) as typeof import("../../src/media/decodedImages");
        for (let index = 0; index < 300; index++) rememberDecodedImage(`evict-${index}`);
      });
      const frames = await returnFrames(page);
      expect(frames.some(frame => frame.avatars >= 3 && frame.stickers === 3), JSON.stringify(frames)).toBe(true);
      expect(frames.filter(frame => frame.fallback || frame.outlines || frame.empty), JSON.stringify(frames)).toEqual([]);
    }
    expect(requests.get("/sticker.tgs")).toBe(tgsRequests);
    expect(await page.evaluate(() => (window as unknown as { remountDownloads: string[] }).remountDownloads)).toEqual([]);
  });
}

test("a cached frame remains painted while the replacement image is still decoding", async ({ page }) => {
  await prepare(page);
  await leaveLatest(page);
  await page.evaluate(async () => {
    const { rememberDecodedImage } = await import("/src/media/decodedImages.ts" as string) as typeof import("../../src/media/decodedImages");
    for (let index = 0; index < 300; index++) rememberDecodedImage(`pressure-${index}`);
    const decode = HTMLImageElement.prototype.decode;
    const releases: Array<() => void> = [];
    HTMLImageElement.prototype.decode = function () {
      if (/avatar-|sticker-/.test(this.src)) return new Promise<void>(resolve => releases.push(() => { void decode.call(this).then(resolve); }));
      return decode.call(this);
    };
    Object.assign(window, { finishRemountDecode: () => {
      HTMLImageElement.prototype.decode = decode;
      releases.forEach(release => release());
    } });
  });
  const frames = await returnFrames(page);
  expect(frames.every(frame => !frame.fallback && !frame.outlines && !frame.empty), JSON.stringify(frames)).toBe(true);
  const cachedAvatar = page.locator(".message-list .message-group-avatar .cached-media-preview canvas");
  await expect(cachedAvatar).toHaveCount(4);
  await page.locator(".message-list").screenshot({ path: "artifacts/media-remount-cached-frames.png" });
  await page.evaluate(() => (window as unknown as { finishRemountDecode: () => void }).finishRemountDecode());
  await expect(page.locator(".message-list .cached-media-preview")).toHaveCount(0);
  await expect.poll(() => page.locator(".message-list .avatar img").evaluateAll(images =>
    images.every(image => getComputedStyle(image).opacity === "1"))).toBe(true);
});

test("unseen and failed sources cannot reuse an unrelated sticker preview", async ({ page }) => {
  await prepare(page);
  await leaveLatest(page);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/unseen-sticker.jpg", async route => {
    await barrier;
    await route.fulfill({ contentType: "image/jpeg", body: image });
  });
  await page.evaluate(async assets => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    const state = telegramStore.getState();
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map(message =>
      message.id === "remount-media-2" ? { ...message, content: { ...message.content, localPath: `${assets}/unseen-sticker.jpg` } as Message["content"] } : message)) });
  }, assets);
  const row = page.locator('.message-list [data-message-id="remount-media-2"]');
  await page.locator(".jump-to-latest").click();
  await expect(row.locator(".sticker-placeholder")).toBeVisible();
  await expect(row.locator(".cached-media-preview")).toHaveCount(0);
  release();
  await expect(row.locator('img[data-image-state="ready"]')).toBeVisible();
  await row.locator("img").evaluate(image => image.dispatchEvent(new Event("error")));
  expect(await page.evaluate(async source => {
    const { hasMediaPreview } = await import("/src/media/mediaPreviewCache.ts" as string) as typeof import("../../src/media/mediaPreviewCache");
    return hasMediaPreview(source);
  }, `${assets}/unseen-sticker.jpg`)).toBe(false);
});

test("cached SVG copies own their references and raster copies contain actual pixels", async ({ page }) => {
  await prepare(page);
  const result = await page.evaluate(async assets => {
    const { cloneMediaPreview, rememberMediaPreview, mediaPreviewGeneration } = await import("/src/media/mediaPreviewCache.ts" as string) as typeof import("../../src/media/mediaPreviewCache");
    const tgs = cloneMediaPreview(`${assets}/sticker.tgs`) as SVGSVGElement;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = '<defs><clipPath id="clip"><rect width="10" height="10"/></clipPath><linearGradient id="gradient"><stop stop-color="red"/></linearGradient></defs><path id="shape" d="M0 0H10V10Z" clip-path="url(#clip)" fill="url(#gradient)"/><use href="#shape"/>';
    rememberMediaPreview("svg-reference-test", svg, mediaPreviewGeneration());
    const first = cloneMediaPreview("svg-reference-test") as SVGSVGElement;
    const second = cloneMediaPreview("svg-reference-test") as SVGSVGElement;
    const ids = [...first.querySelectorAll("[id]"), ...second.querySelectorAll("[id]")].map(node => node.id);
    const localReferences = [first, second].every(copy => [...copy.querySelectorAll("*")].every(node =>
      [...node.attributes].every(attribute => [...attribute.value.matchAll(/#([\w-]+)/g)].every(match => Boolean(copy.querySelector(`[id="${match[1]}"]`))))));
    const source = new Image();
    source.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    await source.decode();
    rememberMediaPreview("pixel-test", source, mediaPreviewGeneration());
    const canvas = cloneMediaPreview("pixel-test") as HTMLCanvasElement;
    return { actualTgsPaths: tgs.querySelectorAll('path[d]').length, uniqueIds: new Set(ids).size === ids.length,
      localReferences, pixel: [...canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data] };
  }, assets);
  expect(result.actualTgsPaths).toBeGreaterThan(0);
  expect(result.uniqueIds).toBe(true);
  expect(result.localReferences).toBe(true);
  expect(result.pixel).toEqual([255, 0, 0, 255]);
});

for (const operation of ["cleanup", "account switch"] as const) {
  test(`preview pixels cannot survive ${operation} or be refilled by an old owner`, async ({ page }) => {
    await prepare(page);
    const result = await page.evaluate(async ({ operation, assets }) => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const { cloneMediaPreview, hasMediaPreview, rememberMediaPreview, mediaPreviewGeneration } = await import("/src/media/mediaPreviewCache.ts" as string) as typeof import("../../src/media/mediaPreviewCache");
      const source = `${assets}/sticker.tgs`;
      const saved = cloneMediaPreview(source) as SVGSVGElement;
      const owner = mediaPreviewGeneration();
      const hadPreview = hasMediaPreview(source);
      const success = operation === "cleanup" ? await telegramStore.getState().clearMediaCache(["image"], 0)
        : await telegramStore.getState().switchAccount("account-secondary");
      rememberMediaPreview(source, saved, owner);
      return { success, hadPreview, hasPreview: hasMediaPreview(source), stale: owner !== mediaPreviewGeneration() };
    }, { operation, assets });
    expect(result).toEqual({ success: true, hadPreview: true, hasPreview: false, stale: true });
  });
}

test("reduced motion and paused sticker playback still restore their cached frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepare(page, true);
  await page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    preferencesStore.setState({ autoplayAnimations: false });
  });
  await leaveLatest(page);
  const frames = await returnFrames(page);
  expect(frames.every(frame => !frame.fallback && !frame.outlines && !frame.empty), JSON.stringify(frames)).toBe(true);
  await expect(page.locator('[data-message-id="remount-media-1"] video')).toHaveAttribute("data-motion-autoplay", "false");
  expect(await page.locator('[data-message-id="remount-media-1"] video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(true);
});

for (const kind of ["tgs", "webm"] as const) {
  test(`returning to a previous ${kind} source while its replacement is pending restores a frame`, async ({ page }) => {
    await prepare(page, kind === "webm");
    let release!: () => void;
    let started!: () => void;
    let finished!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const requestFinished = new Promise<void>(resolve => { finished = resolve; });
    await page.route(`**/pending-sticker.${kind}`, async route => {
      started();
      await barrier;
      try { await route.fulfill({ contentType: kind === "tgs" ? "application/gzip" : "video/webm", body: kind === "tgs" ? animation : video }); }
      finally { finished(); }
    });
    const source = `${assets}/sticker.${kind}`;
    const changeSource = (source: string) => page.evaluate(async source => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
      const state = telegramStore.getState();
      telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map(message =>
        message.id === "remount-media-1" ? { ...message, content: { ...message.content, localPath: source } as Message["content"] } : message)) });
    }, source);
    try {
      await changeSource(`${assets}/pending-sticker.${kind}`);
      await requestStarted;
      await changeSource(source);
      const frames = await page.locator('[data-message-id="remount-media-1"]').evaluate(async row => {
        const samples: boolean[] = [];
        for (let index = 0; index < 20; index++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          samples.push(Boolean(row.querySelector('.cached-media-preview > canvas, .cached-media-preview > svg, .tgs-sticker svg path[d]')) ||
            [...row.querySelectorAll("video")].some(video => video.readyState >= 2));
        }
        return samples;
      });
      expect(frames.every(Boolean), JSON.stringify(frames)).toBe(true);
    } finally { release(); await requestFinished; }
  });
}
