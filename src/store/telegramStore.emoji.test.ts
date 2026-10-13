import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmojiPickerController } from "./telegramStore.emoji";
import { createTelegramStore } from "./telegramStore";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramTransport } from "../telegram/transport";
import type { EmojiPickerAsset, EmojiPickerCatalog, StickerSet } from "../telegram/types";
import { migrateEmojiPickerCache } from "./telegramStore.emojiCache";

const asset: EmojiPickerAsset = {
  id: "sticker:1",
  kind: "sticker",
  fileId: 1,
  fileName: "sticker.webp",
};

const catalog: EmojiPickerCatalog = {
  recentStickers: [asset],
  stickerSets: [],
  savedAnimations: [],
};

const stickerSet: StickerSet = {
  id: "set-1",
  title: "Test",
  name: "test",
  size: 1,
  covers: [asset],
  stickers: [asset],
};

const createHarness = () => {
  const get = vi.fn(() => ({ authorization: { kind: "ready" as const }, activeAccountId: "account-1" }));
  const set = vi.fn();
  const transport = {
    getEmojiPickerCatalog: vi.fn(async () => catalog),
    getStickerSet: vi.fn(async (_id: string) => stickerSet),
    addStickerSet: vi.fn(async () => undefined),
    removeStickerSet: vi.fn(async () => undefined),
    getStickerOutline: vi.fn(async () => "M0 0L512 512Z"),
    loadEmojiAsset: vi.fn(async () => "C:/cache/sticker.webp"),
  };
  const controller = createEmojiPickerController({
    transport: transport as unknown as TelegramTransport,
    get,
    set,
    onError: (_error, fallback) => fallback,
  });
  return { controller, transport, get, set };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => vi.useRealTimers());

describe("emoji picker cache", () => {
  it("publishes installed-list changes immediately and refreshes stale catalog data", async () => {
    const { controller, transport, set } = createHarness();
    transport.getEmojiPickerCatalog.mockResolvedValueOnce({ ...catalog, stickerSets: [{ ...stickerSet, isInstalled: true }] });
    await controller.loadEmojiPicker();
    await controller.loadStickerSet("set-1");
    controller.handleUpdate({ type: "emoji.catalogChanged", installedStickerSetIds: [] });
    expect(controller.getCachedEmojiPicker()?.stickerSets).toEqual([]);
    expect(controller.getCachedStickerSet("set-1")?.isInstalled).toBe(false);
    expect(set).toHaveBeenLastCalledWith({ emojiRevision: expect.any(Number) });
    await controller.loadEmojiPicker();
    expect(transport.getEmojiPickerCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not let an older pack read overwrite a live update", async () => {
    const { controller, transport } = createHarness();
    const old = deferred<StickerSet>();
    transport.getStickerSet.mockReturnValueOnce(old.promise);
    const loading = controller.loadStickerSet("set-1");
    const updated = { ...stickerSet, title: "Updated", isInstalled: true };
    controller.handleUpdate({ type: "stickerSet.updated", stickerSet: updated });
    old.resolve(stickerSet);
    expect(await loading).toBe(updated);
    expect(controller.getCachedStickerSet("set-1")).toBe(updated);
  });

  it("invalidates stale asset paths when TDLib removes a file", async () => {
    const { controller, transport } = createHarness();
    const cachedAsset = { ...asset, localPath: "C:/old.webp" };
    expect(controller.getCachedEmojiAsset(cachedAsset)).toBe("C:/old.webp");
    controller.updateFile({ fileId: asset.fileId, isDownloaded: false, canDownload: true, sizeLabel: "1 KB" });
    expect(controller.getCachedEmojiAsset(cachedAsset)).toBeUndefined();
    expect(await controller.loadEmojiAsset(cachedAsset)).toBe("C:/cache/sticker.webp");
    expect(transport.loadEmojiAsset).toHaveBeenCalledWith({ ...asset, localPath: undefined });
  });

  it("deduplicates offline outline reads, caches absence, and discards previous-account replies", async () => {
    const { controller, transport } = createHarness();
    await Promise.all([controller.loadStickerOutline(1), controller.loadStickerOutline(1)]);
    expect(controller.getCachedStickerOutline(1)).toBe("M0 0L512 512Z");
    expect(transport.getStickerOutline).toHaveBeenCalledOnce();
    transport.getStickerOutline.mockResolvedValueOnce("");
    await controller.loadStickerOutline(2);
    await controller.loadStickerOutline(2);
    expect(transport.getStickerOutline).toHaveBeenCalledTimes(2);
    const old = deferred<string>();
    transport.getStickerOutline.mockReturnValueOnce(old.promise);
    const loading = controller.loadStickerOutline(3);
    controller.reset();
    old.resolve("M1 1L2 2Z");
    expect(await loading).toBeUndefined();
    expect(controller.getCachedStickerOutline(3)).toBeUndefined();
  });

  it("changes installation state only after the write succeeds", async () => {
    const { controller, transport } = createHarness();
    await controller.loadStickerSet("set-1");
    expect(await controller.addStickerSet("set-1")).toBe(true);
    expect(controller.getCachedStickerSet("set-1")?.isInstalled).toBe(true);
    transport.removeStickerSet.mockRejectedValueOnce(new Error("offline"));
    expect(await controller.removeStickerSet("set-1")).toBe(false);
    expect(controller.getCachedStickerSet("set-1")?.isInstalled).toBe(true);
    expect(await controller.removeStickerSet("set-1")).toBe(true);
    expect(controller.getCachedStickerSet("set-1")?.isInstalled).toBe(false);
  });
  it("reuses the catalog and sticker set after the first load", async () => {
    const { controller, transport } = createHarness();

    await expect(controller.loadEmojiPicker()).resolves.toBe(catalog);
    await expect(controller.loadEmojiPicker()).resolves.toBe(catalog);
    await expect(controller.loadStickerSet("set-1")).resolves.toBe(stickerSet);
    await expect(controller.loadStickerSet("set-1")).resolves.toBe(stickerSet);

    expect(transport.getEmojiPickerCatalog).toHaveBeenCalledTimes(1);
    expect(transport.getStickerSet).toHaveBeenCalledTimes(1);
    expect(controller.getCachedEmojiPicker()).toBe(catalog);
    expect(controller.getCachedStickerSet("set-1")).toBe(stickerSet);
  });

  it("deduplicates concurrent asset loads and serves the cached path", async () => {
    const { controller, transport } = createHarness();

    const first = controller.loadEmojiAsset(asset);
    const second = controller.loadEmojiAsset(asset);
    await expect(Promise.all([first, second])).resolves.toEqual(["C:/cache/sticker.webp", "C:/cache/sticker.webp"]);
    await expect(controller.loadEmojiAsset(asset)).resolves.toBe("C:/cache/sticker.webp");

    expect(transport.loadEmojiAsset).toHaveBeenCalledTimes(1);
    expect(controller.getCachedEmojiAsset({ ...asset, id: "cover:1" })).toBe("C:/cache/sticker.webp");
  });

  it("shares in-flight catalog and pack requests across panel instances", async () => {
    const { controller, transport } = createHarness();
    const pendingCatalog = deferred<EmojiPickerCatalog>();
    const pendingSet = deferred<StickerSet>();
    transport.getEmojiPickerCatalog.mockReturnValueOnce(pendingCatalog.promise);
    transport.getStickerSet.mockReturnValueOnce(pendingSet.promise);
    const firstCatalog = controller.loadEmojiPicker();
    const firstSet = controller.loadStickerSet("set-1");
    expect(controller.loadEmojiPicker()).toBe(firstCatalog);
    expect(controller.loadStickerSet("set-1")).toBe(firstSet);
    pendingCatalog.resolve(catalog);
    pendingSet.resolve(stickerSet);
    await Promise.all([firstCatalog, firstSet]);
  });

  it("remembers paths supplied by TDLib even when no download was needed", async () => {
    const { controller, transport } = createHarness();
    expect(controller.getCachedEmojiAsset({ ...asset, localPath: "C:/cached.webp" })).toBe("C:/cached.webp");
    await expect(controller.loadEmojiAsset({ ...asset, id: "cover:1" })).resolves.toBe("C:/cached.webp");
    expect(transport.loadEmojiAsset).not.toHaveBeenCalled();
  });

  it("keeps stale content available during refresh and retries failed loads", async () => {
    vi.useFakeTimers();
    const { controller, transport, set } = createHarness();
    await controller.loadEmojiPicker();
    await controller.loadStickerSet("set-1");
    vi.advanceTimersByTime(31 * 60_000);
    const refresh = deferred<EmojiPickerCatalog>();
    transport.getEmojiPickerCatalog.mockReturnValueOnce(refresh.promise);
    const reading = controller.loadEmojiPicker();
    expect(controller.getCachedEmojiPicker()).toBe(catalog);
    expect(controller.getCachedStickerSet("set-1")).toBe(stickerSet);
    const updated = { ...catalog, recentStickers: [] };
    refresh.resolve(updated);
    await expect(reading).resolves.toBe(updated);
    transport.getStickerSet.mockRejectedValueOnce(new Error("offline"));
    await expect(controller.loadStickerSet("set-1")).resolves.toBe(stickerSet);
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ operationError: expect.any(String) }));
    await controller.loadStickerSet("set-1");
    expect(transport.getStickerSet).toHaveBeenCalledTimes(3);

    transport.loadEmojiAsset.mockRejectedValueOnce(new Error("download failed"));
    await expect(controller.loadEmojiAsset(asset)).resolves.toBeUndefined();
    await expect(controller.loadEmojiAsset(asset)).resolves.toBe("C:/cache/sticker.webp");
    expect(transport.loadEmojiAsset).toHaveBeenCalledTimes(2);
  });

  it("clears account data and rejects late responses after a reset", async () => {
    const { controller, transport, get } = createHarness();
    const oldCatalog = deferred<EmojiPickerCatalog>();
    const oldSet = deferred<StickerSet>();
    const oldAsset = deferred<string>();
    transport.getEmojiPickerCatalog.mockReturnValueOnce(oldCatalog.promise);
    transport.getStickerSet.mockReturnValueOnce(oldSet.promise);
    transport.loadEmojiAsset.mockReturnValueOnce(oldAsset.promise);
    const oldReads = Promise.all([
      controller.loadEmojiPicker(), controller.loadStickerSet("set-1"), controller.loadEmojiAsset(asset),
    ]);
    controller.reset();
    get.mockReturnValue({ authorization: { kind: "ready" }, activeAccountId: "account-2" });
    expect(controller.getCachedEmojiPicker()).toBeUndefined();
    expect(controller.getCachedStickerSet("set-1")).toBeUndefined();
    expect(controller.getCachedEmojiAsset(asset)).toBeUndefined();
    await controller.loadEmojiAsset(asset);
    oldCatalog.resolve(catalog);
    oldSet.resolve(stickerSet);
    oldAsset.resolve("C:/old-account/sticker.webp");
    await expect(oldReads).resolves.toEqual([undefined, undefined, undefined]);
    expect(controller.getCachedEmojiPicker()).toBeUndefined();
    expect(controller.getCachedStickerSet("set-1")).toBeUndefined();
    expect(controller.getCachedEmojiAsset(asset)).toBe("C:/cache/sticker.webp");
  });

  it("refreshes installed packs and keeps recently sent stickers ahead of older reads", async () => {
    vi.useFakeTimers();
    const { controller, transport } = createHarness();
    await controller.loadEmojiPicker();
    const installed = { ...catalog, stickerSets: [stickerSet] };
    transport.getEmojiPickerCatalog.mockResolvedValueOnce(installed);
    await controller.addStickerSet("set-1");
    await controller.loadEmojiPicker();
    expect(controller.getCachedEmojiPicker()?.stickerSets).toEqual([stickerSet]);

    vi.advanceTimersByTime(6 * 60_000);
    const stale = deferred<EmojiPickerCatalog>();
    transport.getEmojiPickerCatalog.mockReturnValueOnce(stale.promise);
    const reading = controller.loadEmojiPicker();
    const sent = { ...asset, fileId: 2, id: "sticker:2" };
    controller.rememberSentSticker(sent);
    controller.rememberSentSticker(sent);
    stale.resolve(catalog);
    await reading;
    expect(controller.getCachedEmojiPicker()?.recentStickers).toEqual([sent, asset]);
  });

  it("bounds retained pack metadata and asset paths", async () => {
    const { controller } = createHarness();
    for (let index = 0; index < 130; index += 1) await controller.loadStickerSet(String(index));
    expect(controller.getCachedStickerSet("0")).toBeUndefined();
    expect(controller.getCachedStickerSet("129")).toBe(stickerSet);
    for (let index = 0; index < 2_050; index += 1) await controller.loadEmojiAsset({ ...asset, fileId: index });
    expect(controller.getCachedEmojiAsset({ ...asset, fileId: 0 })).toBeUndefined();
    expect(controller.getCachedEmojiAsset({ ...asset, fileId: 2_049 })).toBe("C:/cache/sticker.webp");
  });
});

describe("emoji cache store integration", () => {
  it("preloads installed pack metadata before a picker is opened and persists it across a restart", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const catalog = (await store.getState().loadEmojiPicker())!;
    await vi.waitFor(() => expect(catalog.stickerSets.every(set => store.getState().getCachedStickerSet(set.id))).toBe(true));
    await store.getState().rebuildCachedSnapshot();
    const snapshot = (await transport.loadCachedSnapshot())!;
    expect(snapshot.emojiPickerCatalog).toEqual(catalog);
    expect(snapshot.emojiPickerSets?.map(set => set.id)).toEqual(catalog.stickerSets.map(set => set.id));

    const restartedTransport = new MockTelegramTransport();
    vi.spyOn(restartedTransport, "loadCachedSnapshot").mockResolvedValue(snapshot);
    vi.spyOn(restartedTransport, "getEmojiPickerCatalog").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(restartedTransport, "getStickerSet").mockImplementation(() => new Promise(() => undefined));
    const restarted = createTelegramStore(restartedTransport);
    await restarted.getState().initialize();
    expect(restarted.getState().getCachedEmojiPicker()).toEqual(catalog);
    for (const set of snapshot.emojiPickerSets!) expect(restarted.getState().getCachedStickerSet(set.id)).toEqual(set);
  });

  it("does not warm sticker packs in a settings-only window", async () => {
    const transport = new MockTelegramTransport();
    const catalogRead = vi.spyOn(transport, "getEmojiPickerCatalog");
    const store = createTelegramStore(transport);
    await store.getState().initialize({ settingsOnly: true });
    expect(catalogRead).not.toHaveBeenCalled();
  });

  it("ignores another account's persisted picker and tolerates malformed optional sections", async () => {
    const cache = migrateEmojiPickerCache({ emojiPickerCatalog: 42, emojiPickerSets: [null, { id: "broken" }],
      emojiPickerPreviews: [{ key: "1", dataUrl: "https://external.invalid/tracker" }, { key: "2", dataUrl: "data:image/svg+xml;base64,AAAA" }] });
    expect(cache).toEqual({ emojiPickerCatalog: undefined, emojiPickerSets: [], emojiPickerPreviews: [] });
    const transport = new MockTelegramTransport();
    vi.spyOn(transport, "loadCachedSnapshot").mockResolvedValue({
      version: 4, savedAt: new Date().toISOString(), accountId: "foreign-account", currentUserId: "foreign", users: [], folders: [], chats: [], messages: [],
      emojiPickerCatalog: catalog, emojiPickerSets: [stickerSet], emojiPickerPreviews: [{ key: "1", dataUrl: "data:image/webp;base64,AAAA" }],
    });
    vi.spyOn(transport, "getEmojiPickerCatalog").mockImplementation(() => new Promise(() => undefined));
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    expect(store.getState().getCachedEmojiPicker()).toBeUndefined();
    expect(store.getState().getCachedStickerPickerPreview(asset)).toBeUndefined();
  });

  it("restores previews by persistent identity while file IDs change and clears them on account reset", () => {
    const { controller } = createHarness();
    controller.hydrate({ emojiPickerCatalog: catalog, emojiPickerSets: [stickerSet],
      emojiPickerPreviews: [{ key: "stable-file", dataUrl: "data:image/webp;base64,AAAA" }] });
    const restored = { ...asset, fileId: 997, remoteUniqueId: "stable-file" };
    expect(controller.getCachedStickerPickerPreview(restored)).toBe("data:image/webp;base64,AAAA");
    expect(controller.snapshot().emojiPickerPreviews).toHaveLength(1);
    controller.reset();
    expect(controller.getCachedStickerPickerPreview(restored)).toBeUndefined();
    expect(controller.snapshot().emojiPickerPreviews).toEqual([]);
  });

  it("retains every installed pack even after more than 128 packs are loaded", async () => {
    const { controller, transport } = createHarness();
    const sets = Array.from({ length: 140 }, (_, index) => ({ ...stickerSet, id: `installed-${index}` }));
    transport.getEmojiPickerCatalog.mockResolvedValue({ ...catalog, stickerSets: sets });
    transport.getStickerSet.mockImplementation(async id => sets.find(set => set.id === id)!);
    await controller.loadEmojiPicker();
    for (const set of sets) await controller.loadStickerSet(set.id);
    expect(controller.getCachedStickerSet(sets[0].id)).toEqual(sets[0]);
    expect(controller.snapshot().emojiPickerSets).toHaveLength(140);
  });
  it("models actual installation and removal, including same-account updates from another client", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const initial = (await store.getState().loadEmojiPicker())!;
    const id = initial.stickerSets[0].id;
    await store.getState().loadStickerSet(id);
    await transport.removeStickerSet(id);
    expect(store.getState().getCachedStickerSet(id)?.isInstalled).toBe(false);
    expect((await store.getState().loadEmojiPicker())?.stickerSets.some((set) => set.id === id)).toBe(false);
    await store.getState().addStickerSet(id);
    expect((await store.getState().loadEmojiPicker())?.stickerSets.some((set) => set.id === id)).toBe(true);
  });
  it("retains catalog, packs and assets across chats and updates recent stickers after sending", async () => {
    const transport = new MockTelegramTransport();
    const catalogRead = vi.spyOn(transport, "getEmojiPickerCatalog");
    const packRead = vi.spyOn(transport, "getStickerSet");
    const assetRead = vi.spyOn(transport, "loadEmojiAsset");
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const first = (await store.getState().loadEmojiPicker())!;
    const pack = (await store.getState().loadStickerSet(first.stickerSets[0].id))!;
    const sent = pack.stickers.at(-1)!;
    const path = await store.getState().loadEmojiAsset(sent);

    store.getState().selectChat("chat-product");
    store.getState().selectChat("chat-design");
    expect(await store.getState().loadEmojiPicker()).toBe(first);
    expect(await store.getState().loadStickerSet(pack.id)).toBe(pack);
    expect(await store.getState().loadEmojiAsset(sent)).toBe(path);
    expect(catalogRead).toHaveBeenCalledOnce();
    expect(packRead.mock.calls.filter(([id]) => id === pack.id)).toHaveLength(1);
    expect(assetRead).toHaveBeenCalledOnce();

    expect(await store.getState().sendSticker(sent, undefined, undefined, "chat-product")).toBe(true);
    expect(store.getState().getCachedEmojiPicker()?.recentStickers[0]).toBe(sent);
  });

  it.each(["cleanup", "account switch"])("invalidates all picker caches on %s", async (operation) => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const first = (await store.getState().loadEmojiPicker())!;
    const pack = (await store.getState().loadStickerSet(first.stickerSets[0].id))!;
    const sticker = pack.stickers[0];
    await store.getState().loadEmojiAsset(sticker);
    const catalogRead = vi.spyOn(transport, "getEmojiPickerCatalog");
    const packRead = vi.spyOn(transport, "getStickerSet");
    const assetRead = vi.spyOn(transport, "loadEmojiAsset");

    if (operation === "cleanup") {
      expect(await store.getState().clearMediaCache(["image"], 0)).toBe(true);
    } else {
      expect(await store.getState().switchAccount("account-secondary")).toBe(true);
    }
    expect(store.getState().getCachedEmojiPicker()).toBeUndefined();
    expect(store.getState().getCachedStickerSet(pack.id)).toBeUndefined();
    expect(store.getState().getCachedEmojiAsset(sticker)).toBeUndefined();
    if (operation === "account switch") store.setState({ authorization: { kind: "ready" } });
    await store.getState().loadEmojiPicker();
    await store.getState().loadStickerSet(pack.id);
    await store.getState().loadEmojiAsset(sticker);
    expect(catalogRead).toHaveBeenCalledOnce();
    expect(packRead).toHaveBeenCalledOnce();
    expect(assetRead).toHaveBeenCalledOnce();
  });
});
