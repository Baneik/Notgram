import { translate } from "../i18n";
import { clearTgsAnimationCache } from "../media/tgsAnimationCache";
import { clearLocalAssetCache } from "../media/localAssetCache";
import { clearMediaPreviewCache } from "../media/mediaPreviewCache";
import { clearPhotoPreviewCache } from "../media/photoPreview";
import { stickerOutlinePath } from "../media/stickerOutline";
import { prepareStickerPickerPreview } from "../media/stickerPickerPreview";
import { emojiAssetPreview } from "../media/emojiAssetPreview";
import type { TelegramTransport } from "../telegram/transport";
import type { CachedTelegramSnapshot, EmojiPickerAsset, EmojiPickerCatalog, MessageFileState, StickerSet, TelegramEvent } from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

const CATALOG_TTL_MS = 5 * 60_000;
const STICKER_SET_TTL_MS = 30 * 60_000;
const MAX_STICKER_SETS = 128;
const MAX_ASSET_PATHS = 2_048;
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
const previewKey = (asset: EmojiPickerAsset) => asset.remoteUniqueId ?? asset.remoteId ?? String(asset.fileId);
type PickerSnapshot = Pick<CachedTelegramSnapshot, "emojiPickerCatalog" | "emojiPickerSets" | "emojiPickerPreviews">;

interface CachedValue<T> {
  value: T;
  loadedAt: number;
}

interface EmojiPickerControllerOptions {
  transport: TelegramTransport;
  get: () => Pick<TelegramState, "authorization" | "activeAccountId">;
  set: (patch: Partial<TelegramState>) => void;
  onError: (error: unknown, fallback: string) => string;
  onCacheChanged?: () => void;
  preparePreview?: typeof prepareStickerPickerPreview;
  canWarm?: () => boolean;
}

const remember = <K, V>(cache: Map<K, V>, key: K, value: V, limit: number) => {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
};

const read = <K, V>(cache: Map<K, V>, key: K) => {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
};

/** Account-scoped caches survive composer remounts without keeping hidden players alive. */
export const createEmojiPickerController = ({ transport, get, set, onError, onCacheChanged,
  preparePreview = prepareStickerPickerPreview, canWarm = () => true }: EmojiPickerControllerOptions) => {
  let generation = 0;
  let uiRevision = 0;
  const notify = () => { set({ emojiRevision: ++uiRevision }); onCacheChanged?.(); };
  let catalogRevision = 0;
  let catalog: CachedValue<EmojiPickerCatalog> | undefined;
  let catalogRequest: Promise<EmojiPickerCatalog | undefined> | undefined;
  const stickerSets = new Map<string, CachedValue<StickerSet>>();
  const stickerSetRequests = new Map<string, Promise<StickerSet | undefined>>();
  // An explicit undefined tombstone overrides a stale localPath after file eviction.
  const assetPaths = new Map<number, string | undefined>();
  const assetRequests = new Map<number, Promise<string | undefined>>();
  const outlines = new Map<number, CachedValue<string>>();
  const outlineRequests = new Map<number, Promise<string | undefined>>();
  const previews = new Map<string, string>();
  let previewBytes = 0;
  let previewAbort = new AbortController();
  const previewQueue = new Map<string, EmojiPickerAsset>();
  const previewPending = new Set<string>();
  let preparing = 0;
  let warmingSets: Promise<void> | undefined;

  const rememberPreview = (key: string, dataUrl: string) => {
    if (!/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 32_768) return;
    const bytes = dataUrl.length * 2;
    previewBytes -= (previews.get(key)?.length ?? 0) * 2;
    previews.delete(key);
    while (previewBytes + bytes > MAX_PREVIEW_BYTES && previews.size) {
      const oldest = previews.keys().next().value!;
      previewBytes -= previews.get(oldest)!.length * 2;
      previews.delete(oldest);
    }
    previews.set(key, dataUrl);
    previewBytes += bytes;
  };

  const pumpPreviews = () => {
    if (typeof document === "undefined") return;
    while (preparing < 2 && previewQueue.size && get().authorization.kind === "ready") {
      const [key, asset] = previewQueue.entries().next().value!;
      previewQueue.delete(key);
      const isCurrent = currentRequest();
      const signal = previewAbort.signal;
      preparing++;
      previewPending.add(key);
      void (async () => {
        // Prefer a thumbnail for animations; static stickers retain their detail.
        const animated = asset.mimeType === "application/x-tgsticker" || asset.mimeType === "video/webm";
        const thumbnail = animated ? emojiAssetPreview(asset) : undefined;
        const fullPath = getCachedEmojiAsset(asset);
        const candidates = thumbnail && (!fullPath || getCachedEmojiAsset(thumbnail)) ? [thumbnail, asset] : [asset];
        for (const visual of candidates) {
          try {
            if (!isCurrent() || signal.aborted) return;
            const path = getCachedEmojiAsset(visual) ?? await transport.loadEmojiAsset(visual, 16);
            if (!isCurrent() || signal.aborted) return;
            if (!path) continue;
            const dataUrl = await preparePreview(visual, path, signal);
            if (!isCurrent() || signal.aborted) return;
            if (!dataUrl) continue;
            rememberPreview(key, dataUrl);
            notify();
            return;
          } catch { if (!isCurrent() || signal.aborted) return; }
        }
      })().catch(() => undefined).finally(() => {
        if (!isCurrent()) return;
        preparing--;
        previewPending.delete(key);
        pumpPreviews();
      });
    }
  };
  const queuePreviews = (assets: EmojiPickerAsset[]) => {
    for (const asset of assets) {
      if (asset.kind !== "sticker") continue;
      const key = previewKey(asset);
      if (!previews.has(key) && !previewPending.has(key)) previewQueue.set(key, asset);
    }
    pumpPreviews();
  };
  const warmStickerSets = () => {
    if (warmingSets || !catalog || get().authorization.kind !== "ready") return warmingSets;
    const isCurrent = currentRequest();
    const ids = catalog.value.stickerSets.map(set => set.id);
    const request = Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
      while (ids.length && isCurrent()) {
        const id = ids.shift()!;
        await loadStickerSet(id, true);
      }
    })).then(() => undefined).finally(() => { if (warmingSets === request) warmingSets = undefined; });
    warmingSets = request;
    return request;
  };

  const currentRequest = () => {
    const startedGeneration = generation;
    const accountId = get().activeAccountId;
    return () => startedGeneration === generation && accountId === get().activeAccountId;
  };

  const loadEmojiPicker = (background = false): Promise<EmojiPickerCatalog | undefined> => {
    if (get().authorization.kind !== "ready") return Promise.resolve(undefined);
    if (catalog && Date.now() - catalog.loadedAt < CATALOG_TTL_MS) return Promise.resolve(catalog.value);
    if (catalogRequest) return catalogRequest;
    const isCurrent = currentRequest();
    const revision = catalogRevision;
    const request = transport.getEmojiPickerCatalog().then((value) => {
      if (!isCurrent()) return undefined;
      // Sending/installing while a read is pending must not restore the old catalog.
      if (revision !== catalogRevision) return catalog?.value;
      catalog = { value, loadedAt: Date.now() };
      queuePreviews([...value.recentStickers, ...value.stickerSets.flatMap(set => set.covers)]);
      if (typeof document !== "undefined" && canWarm()) void warmStickerSets();
      notify();
      return value;
    }).catch((error: unknown) => {
      if (!isCurrent()) return undefined;
      if (!catalog && !background) set({ operationError: onError(error, translate("无法读取表情与贴纸")) });
      return catalog?.value;
    }).finally(() => {
      if (catalogRequest === request) catalogRequest = undefined;
    });
    catalogRequest = request;
    return request;
  };

  const invalidateCatalog = () => {
    catalogRevision += 1;
    catalogRequest = undefined;
    if (catalog) catalog = { ...catalog, loadedAt: -Infinity };
  };

  const rememberStickerSet = (value: StickerSet) => {
    stickerSetRequests.delete(value.id);
    stickerSets.delete(value.id);
    stickerSets.set(value.id, { value, loadedAt: Date.now() });
    for (const asset of value.stickers) {
      if (outlines.get(asset.fileId)?.value === "") outlines.delete(asset.fileId);
    }
    invalidateCatalog();
    if (catalog) {
      const sets = catalog.value.stickerSets;
      const next = value.isInstalled === false ? sets.filter((set) => set.id !== value.id)
        : sets.some((set) => set.id === value.id) ? sets.map((set) => set.id === value.id ? value : set)
        : value.isInstalled ? [...sets, value] : sets;
      catalog = { ...catalog, value: { ...catalog.value, stickerSets: next } };
    }
    trimStickerSets();
    notify();
    queuePreviews([...value.covers, ...value.stickers]);
  };

  const setInstalled = async (id: string, installed: boolean) => {
    const isCurrent = currentRequest();
    try {
      if (installed) await transport.addStickerSet(id);
      else await transport.removeStickerSet(id);
      if (!isCurrent()) return false;
      const cached = stickerSets.get(id);
      if (cached) rememberStickerSet({ ...cached.value, isInstalled: installed, isArchived: false });
      else { invalidateCatalog(); notify(); }
      set({ operationError: undefined });
      void loadEmojiPicker();
      return true;
    } catch (error) {
      if (isCurrent()) set({ operationError: onError(error, installed ? translate("添加贴纸包失败") : translate("移除贴纸包失败")) });
      return false;
    }
  };

  const getCachedEmojiAsset = (asset: EmojiPickerAsset) => assetPaths.has(asset.fileId)
    ? read(assetPaths, asset.fileId)
    : asset.localPath ? remember(assetPaths, asset.fileId, asset.localPath, MAX_ASSET_PATHS) : undefined;

  const updateFile = (file: MessageFileState) => {
    if (file.isDownloading && !file.isDownloaded) return;
    const path = file.isDownloaded ? file.localPath : undefined;
    remember(assetPaths, file.fileId, path, MAX_ASSET_PATHS);
    const patchAsset = (asset: EmojiPickerAsset) => {
      if (asset.fileId === file.fileId && asset.localPath !== path) return { ...asset, localPath: path };
      if (asset.previewFileId === file.fileId && asset.previewPath !== path) return { ...asset, previewPath: path };
      return asset;
    };
    const patchAssets = (assets: EmojiPickerAsset[]) => {
      const next = assets.map(patchAsset);
      return next.some((asset, index) => asset !== assets[index]) ? next : assets;
    };
    let changed = false;
    if (catalog) {
      const value = catalog.value;
      const recentStickers = patchAssets(value.recentStickers);
      const savedAnimations = patchAssets(value.savedAnimations);
      const sets = value.stickerSets.map((set) => {
        const covers = patchAssets(set.covers);
        return covers === set.covers ? set : { ...set, covers };
      });
      changed = recentStickers !== value.recentStickers || savedAnimations !== value.savedAnimations || sets.some((set, i) => set !== value.stickerSets[i]);
      if (changed) catalog = { ...catalog, value: { ...value, recentStickers, savedAnimations, stickerSets: sets } };
    }
    for (const [id, cached] of stickerSets) {
      const stickers = patchAssets(cached.value.stickers);
      const covers = patchAssets(cached.value.covers);
      if (stickers === cached.value.stickers && covers === cached.value.covers) continue;
      stickerSets.set(id, { ...cached, value: { ...cached.value, stickers, covers } });
      changed = true;
    }
    if (changed) notify();
  };

  const loadStickerSet = (id: string, background = false): Promise<StickerSet | undefined> => {
    const cached = read(stickerSets, id);
    if (cached && Date.now() - cached.loadedAt < STICKER_SET_TTL_MS) {
      queuePreviews(cached.value.stickers);
      return Promise.resolve(cached.value);
    }
    const pending = stickerSetRequests.get(id);
    if (pending) return pending;
    const isCurrent = currentRequest();
    const request = transport.getStickerSet(id).then((value) => {
      if (!isCurrent()) return undefined;
      if (stickerSetRequests.get(id) !== request) return stickerSets.get(id)?.value;
      // Installed sets stay available even when many other packs are previewed.
      stickerSets.set(id, { value, loadedAt: Date.now() });
      trimStickerSets();
      queuePreviews([...value.covers, ...value.stickers]);
      notify();
      return value;
    }).catch((error: unknown) => {
      if (!isCurrent()) return undefined;
      if (stickerSetRequests.get(id) !== request) return stickerSets.get(id)?.value;
      if (!cached && !background) set({ operationError: onError(error, translate("无法读取贴纸包")) });
      return cached?.value;
    }).finally(() => {
      if (stickerSetRequests.get(id) === request) stickerSetRequests.delete(id);
    });
    stickerSetRequests.set(id, request);
    return request;
  };
  const trimStickerSets = () => {
    const installed = new Set(catalog?.value.stickerSets.map(set => set.id));
    for (const [id, cached] of stickerSets) if (cached.value.isInstalled) installed.add(id);
    const limit = Math.max(MAX_STICKER_SETS, installed.size);
    for (const id of stickerSets.keys()) {
      if (stickerSets.size <= limit) break;
      if (!installed.has(id)) stickerSets.delete(id);
    }
  };

  return {
    reset: () => {
      clearTgsAnimationCache();
      clearLocalAssetCache();
      clearMediaPreviewCache();
      clearPhotoPreviewCache();
      generation += 1;
      catalog = undefined;
      catalogRequest = undefined;
      stickerSets.clear();
      stickerSetRequests.clear();
      assetPaths.clear();
      assetRequests.clear();
      outlines.clear();
      outlineRequests.clear();
      previewAbort.abort();
      previewAbort = new AbortController();
      previews.clear();
      previewBytes = 0;
      previewQueue.clear();
      previewPending.clear();
      preparing = 0;
      warmingSets = undefined;
      notify();
    },

    snapshot: (): PickerSnapshot => ({
      emojiPickerCatalog: catalog?.value,
      emojiPickerSets: [...stickerSets.values()].map(cached => cached.value),
      emojiPickerPreviews: [...previews].map(([key, dataUrl]) => ({ key, dataUrl })),
    }),
    hydrate: (snapshot: PickerSnapshot) => {
      if (!catalog && snapshot.emojiPickerCatalog) catalog = { value: snapshot.emojiPickerCatalog, loadedAt: -Infinity };
      for (const value of snapshot.emojiPickerSets ?? []) {
        if (!stickerSets.has(value.id)) stickerSets.set(value.id, { value, loadedAt: -Infinity });
      }
      for (const { key, dataUrl } of snapshot.emojiPickerPreviews ?? []) if (!previews.has(key)) rememberPreview(key, dataUrl);
      notify();
    },
    warm: () => {
      if (!canWarm() || get().authorization.kind !== "ready") return;
      if (catalog) queuePreviews([...catalog.value.recentStickers, ...catalog.value.stickerSets.flatMap(set => set.covers)]);
      for (const cached of stickerSets.values()) queuePreviews(cached.value.stickers);
      void loadEmojiPicker(true).then(() => warmStickerSets());
    },
    getCachedStickerPickerPreview: (asset: EmojiPickerAsset) => previews.get(previewKey(asset)),

    updateFile,
    rememberStickerSet,
    invalidate: () => { invalidateCatalog(); notify(); },
    handleUpdate: (event: Extract<TelegramEvent, { type: "emoji.catalogChanged" | "stickerSet.updated" }>) => {
      if (event.type === "stickerSet.updated") { rememberStickerSet(event.stickerSet); return; }
      if (event.installedStickerSetIds) {
        stickerSetRequests.clear();
        const installed = new Set(event.installedStickerSetIds);
        for (const [id, cached] of stickerSets) {
          stickerSetRequests.delete(id);
          stickerSets.set(id, { ...cached, value: { ...cached.value, isInstalled: installed.has(id) } });
        }
        if (catalog) {
          const sets = new Map(catalog.value.stickerSets.map((set) => [set.id, set]));
          catalog = { ...catalog, value: { ...catalog.value, stickerSets: event.installedStickerSetIds.flatMap((id) => {
            const set = sets.get(id) ?? stickerSets.get(id)?.value;
            return set ? [{ ...set, isInstalled: true, isArchived: false }] : [];
          }) } };
        }
      }
      invalidateCatalog();
      notify();
    },

    getCachedEmojiPicker: () => catalog?.value,
    loadEmojiPicker,

    getCachedStickerSet: (id: string) => read(stickerSets, id)?.value,
    loadStickerSet,

    addStickerSet: (id: string) => setInstalled(id, true),
    removeStickerSet: (id: string) => setInstalled(id, false),

    rememberSentSticker: (asset: EmojiPickerAsset) => {
      catalogRevision += 1;
      catalogRequest = undefined;
      if (!catalog) return;
      catalog = {
        ...catalog,
        value: {
          ...catalog.value,
          recentStickers: [asset, ...catalog.value.recentStickers.filter((item) => item.fileId !== asset.fileId)].slice(0, 100),
        },
      };
      notify();
    },

    getCachedStickerOutline: (fileId: number) => {
      const cached = read(outlines, fileId);
      return cached && (cached.value || Date.now() - cached.loadedAt < CATALOG_TTL_MS) ? cached.value : undefined;
    },
    loadStickerOutline: (fileId: number): Promise<string | undefined> => {
      const cached = read(outlines, fileId);
      if (cached && (cached.value || Date.now() - cached.loadedAt < CATALOG_TTL_MS)) return Promise.resolve(cached.value);
      const pending = outlineRequests.get(fileId);
      if (pending) return pending;
      const isCurrent = currentRequest();
      const request = transport.getStickerOutline(fileId).then((value) => {
        if (!isCurrent()) return undefined;
        const path = stickerOutlinePath(value);
        remember(outlines, fileId, { value: path, loadedAt: Date.now() }, MAX_ASSET_PATHS);
        return path;
      }).catch(() => undefined).finally(() => {
        if (outlineRequests.get(fileId) === request) outlineRequests.delete(fileId);
      });
      outlineRequests.set(fileId, request);
      return request;
    },
    getCachedEmojiAsset,
    loadEmojiAsset: (asset: EmojiPickerAsset): Promise<string | undefined> => {
      const path = getCachedEmojiAsset(asset);
      if (path) return Promise.resolve(path);
      const pending = assetRequests.get(asset.fileId);
      if (pending) return pending;
      const isCurrent = currentRequest();
      const request = transport.loadEmojiAsset({ ...asset, localPath: undefined }).then((value) => {
        if (!isCurrent()) return undefined;
        if (value) remember(assetPaths, asset.fileId, value, MAX_ASSET_PATHS);
        return value;
      }).catch(() => undefined).finally(() => {
        if (assetRequests.get(asset.fileId) === request) assetRequests.delete(asset.fileId);
      });
      assetRequests.set(asset.fileId, request);
      return request;
    },
  };
};
