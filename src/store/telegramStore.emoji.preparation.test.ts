import { afterEach, expect, it, vi } from "vitest";
import { createEmojiPickerController } from "./telegramStore.emoji";
import { FileDownloadQueue } from "../telegram/fileDownloadQueue";
import type { TelegramTransport } from "../telegram/transport";
import type { EmojiPickerAsset, EmojiPickerCatalog } from "../telegram/types";

const pixels = "data:image/webp;base64,AAAA";
const sticker = (id: number): EmojiPickerAsset => ({ id: String(id), fileId: id, kind: "sticker", fileName: "sticker.webp" });
const catalog = (assets: EmojiPickerAsset[]): EmojiPickerCatalog => ({ recentStickers: assets, stickerSets: [], savedAnimations: [] });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("prepares local pixels and starts small sticker downloads while archive prefetches are stalled", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", {});
  const downloads: number[] = [];
  const queue = new FileDownloadQueue(async input => {
    downloads.push(Number(input.file_id));
    return { "@type": "file", id: input.file_id, local: { is_downloading_active: true } };
  }, () => undefined);
  for (let id = 1; id <= 9; id++) void queue.cache(id, 16).catch(() => undefined);
  const assets = [sticker(1001), sticker(1002), { ...sticker(1003), localPath: "C:/local.webp" }];
  const controller = createEmojiPickerController({
    transport: { getEmojiPickerCatalog: async () => catalog(assets), loadEmojiAsset: async (asset: EmojiPickerAsset, priority?: number) => {
      await queue.cache(asset.fileId, priority); return "C:/downloaded.webp";
    } } as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }),
    set: () => undefined, onError: (_error, fallback) => fallback, preparePreview: async () => pixels,
  });
  try {
    await controller.loadEmojiPicker(); await flush();
    expect(downloads).toEqual([1, 2, 3, 1001, 1002]);
    expect(controller.getCachedStickerPickerPreview(assets[2])).toBe(pixels);
  } finally { controller.reset(); queue.reset(); await flush(); }
});

it("bounds raster work independently of network waits and batches pixel publications", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", {});
  const assets = Array.from({ length: 6 }, (_, i) => ({ ...sticker(i + 1), localPath: `C:/${i}.webp` }));
  const finish: Array<(value: string) => void> = [];
  const prepare = vi.fn(() => new Promise<string>(resolve => finish.push(resolve)));
  const set = vi.fn();
  const controller = createEmojiPickerController({
    transport: { getEmojiPickerCatalog: async () => catalog(assets) } as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }),
    set, onError: (_error, fallback) => fallback, preparePreview: prepare,
  });
  try {
    await controller.loadEmojiPicker(); await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    const initialPublications = set.mock.calls.length;
    for (let i = 0; i < 3; i++) { for (const resolve of finish.splice(0)) resolve(pixels); await flush(); }
    expect(controller.snapshot().emojiPickerPreviews).toHaveLength(6);
    expect(set).toHaveBeenCalledTimes(initialPublications);
    await vi.advanceTimersByTimeAsync(16);
    expect(set).toHaveBeenCalledTimes(initialPublications + 1);
  } finally { controller.reset(); }
});

it("retries failed previews with backoff, preserves the backoff during warming, and cancels reset work", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", {});
  const asset = sticker(1001);
  const load = vi.fn().mockRejectedValue(new Error("temporary failure"));
  const controller = createEmojiPickerController({
    transport: { getEmojiPickerCatalog: async () => catalog([asset]), loadEmojiAsset: load } as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }),
    set: () => undefined, onError: (_error, fallback) => fallback, preparePreview: async () => pixels,
  });
  try {
    await controller.loadEmojiPicker(); await flush();
    controller.warm(); await flush();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2);
    load.mockResolvedValue("C:/recovered.webp");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getCachedStickerPickerPreview(asset)).toBe(pixels);
    expect(controller.getCachedEmojiAsset(asset)).toBe("C:/recovered.webp");
    controller.reset();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
  } finally { controller.reset(); }
});

it("cancels scheduled retry when the account cache resets", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", {});
  const prepare = vi.fn(async () => pixels);
  const load = vi.fn().mockRejectedValue(new Error("offline"));
  const controller = createEmojiPickerController({
    transport: { getEmojiPickerCatalog: async () => catalog([sticker(1)]), loadEmojiAsset: load } as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }),
    set: () => undefined, onError: (_error, fallback) => fallback, preparePreview: prepare,
  });
  await controller.loadEmojiPicker(); await flush(); controller.reset();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(controller.snapshot().emojiPickerPreviews).toEqual([]);
});

it("reserves a network slot for small previews when a full animation is stalled", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", {});
  const animation = (id: number) => ({ ...sticker(id), mimeType: "application/x-tgsticker" });
  const load = vi.fn(() => new Promise<string>(() => undefined));
  const controller = createEmojiPickerController({
    transport: { getEmojiPickerCatalog: async () => catalog([animation(1), animation(2), sticker(3)]), loadEmojiAsset: load } as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }),
    set: () => undefined, onError: (_error, fallback) => fallback,
  });
  try {
    await controller.loadEmojiPicker(); await flush();
    expect(load.mock.calls).toMatchObject([[{ fileId: 1 }, 16], [{ fileId: 3 }, 19]]);
  } finally { controller.reset(); }
});

it("discards queued and in-flight raster results after an account reset", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", {});
  const finish: Array<(value: string) => void> = [];
  const prepare = vi.fn(() => new Promise<string>(resolve => finish.push(resolve)));
  const controller = createEmojiPickerController({
    transport: { getEmojiPickerCatalog: async () => catalog([1, 2, 3].map(id => ({ ...sticker(id), localPath: `C:/${id}.webp` }))) } as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }),
    set: () => undefined, onError: (_error, fallback) => fallback, preparePreview: prepare,
  });
  await controller.loadEmojiPicker(); await flush();
  expect(prepare).toHaveBeenCalledTimes(2);
  controller.reset();
  for (const resolve of finish) resolve(pixels);
  await flush();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(controller.snapshot().emojiPickerPreviews).toEqual([]);
});

it("publishes stickers before GIFs, keeps saved GIFs during refresh, and ignores late catalog results after reset", async () => {
  let ready!: (value: EmojiPickerCatalog) => void;
  let finish!: (value: EmojiPickerCatalog) => void;
  const transport = { getEmojiPickerCatalog: vi.fn((partial: typeof ready) => {
    ready = partial; return new Promise<EmojiPickerCatalog>(resolve => { finish = resolve; });
  }) };
  const old = { ...sticker(99), kind: "animation" as const };
  const controller = createEmojiPickerController({ transport: transport as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }), set: () => undefined,
    onError: (_error, fallback) => fallback });
  controller.hydrate({ emojiPickerCatalog: { ...catalog([]), savedAnimations: [old] } });
  const loading = controller.loadEmojiPicker(); ready(catalog([sticker(1)]));
  expect((await loading)?.recentStickers).toHaveLength(1);
  expect(controller.getCachedEmojiPicker()?.savedAnimations).toEqual([old]);
  controller.reset(); finish(catalog([sticker(2)])); await flush();
  expect(controller.getCachedEmojiPicker()).toBeUndefined();
});

it.each(["sent sticker", "pack update", "saved GIF update", "newer request"])("merges a delayed GIF section safely after %s", async change => {
  const finishes: Array<(value: EmojiPickerCatalog) => void> = [];
  const transport = { getEmojiPickerCatalog: (partial: (value: EmojiPickerCatalog) => void) => {
    partial(catalog([sticker(1)]));
    return new Promise<EmojiPickerCatalog>(resolve => finishes.push(resolve));
  } };
  const controller = createEmojiPickerController({ transport: transport as unknown as TelegramTransport,
    get: () => ({ authorization: { kind: "ready" }, activeAccountId: "audit" }), set: () => undefined,
    onError: (_error, fallback) => fallback });
  await controller.loadEmojiPicker();
  const sent = sticker(2);
  if (change === "sent sticker") controller.rememberSentSticker(sent);
  if (change === "pack update") controller.rememberStickerSet({ id: "pack", title: "Updated", name: "updated", size: 0, covers: [], stickers: [], isInstalled: true });
  if (change === "saved GIF update") controller.handleUpdate({ type: "emoji.catalogChanged", section: "animations" });
  if (change === "newer request") {
    controller.invalidate();
    await controller.loadEmojiPicker();
    finishes[1]({ ...catalog([sticker(3)]), savedAnimations: [{ ...sticker(100), kind: "animation" }] });
    await flush();
  }
  finishes[0]({ ...catalog([sticker(1)]), savedAnimations: [{ ...sticker(99), kind: "animation" }] });
  await flush();
  const result = controller.getCachedEmojiPicker()!;
  if (change === "sent sticker") expect(result.recentStickers[0]).toEqual(sent);
  if (change === "pack update") expect(result.stickerSets[0].title).toBe("Updated");
  expect(result.savedAnimations.map(asset => asset.fileId)).toEqual(change === "saved GIF update" ? [] : change === "newer request" ? [100] : [99]);
  controller.reset();
});
