import { translate } from "../i18n";
import { clearTgsAnimationCache } from "../media/tgsAnimationCache";
import { clearLocalAssetCache } from "../media/localAssetCache";
import { stickerOutlinePath } from "../media/stickerOutline";
import type { TelegramTransport } from "../telegram/transport";
import type { EmojiPickerAsset, EmojiPickerCatalog, MessageFileState, StickerSet, TelegramEvent } from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

const CATALOG_TTL_MS = 5 * 60_000;
const STICKER_SET_TTL_MS = 30 * 60_000;
const MAX_STICKER_SETS = 128;
const MAX_ASSET_PATHS = 2_048;

interface CachedValue<T> {
  value: T;
  loadedAt: number;
}

interface EmojiPickerControllerOptions {
  transport: TelegramTransport;
  get: () => Pick<TelegramState, "authorization" | "activeAccountId">;
  set: (patch: Partial<TelegramState>) => void;
  onError: (error: unknown, fallback: string) => string;
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
export const createEmojiPickerController = ({ transport, get, set, onError }: EmojiPickerControllerOptions) => {
  let generation = 0;
  let uiRevision = 0;
  const notify = () => set({ emojiRevision: ++uiRevision });
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

  const currentRequest = () => {
    const startedGeneration = generation;
    const accountId = get().activeAccountId;
    return () => startedGeneration === generation && accountId === get().activeAccountId;
  };

  const loadEmojiPicker = (): Promise<EmojiPickerCatalog | undefined> => {
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
      notify();
      return value;
    }).catch((error: unknown) => {
      if (!isCurrent()) return undefined;
      if (!catalog) set({ operationError: onError(error, translate("无法读取表情与贴纸")) });
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
    remember(stickerSets, value.id, { value, loadedAt: Date.now() }, MAX_STICKER_SETS);
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
    notify();
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

  return {
    reset: () => {
      clearTgsAnimationCache();
      clearLocalAssetCache();
      generation += 1;
      catalog = undefined;
      catalogRequest = undefined;
      stickerSets.clear();
      stickerSetRequests.clear();
      assetPaths.clear();
      assetRequests.clear();
      outlines.clear();
      outlineRequests.clear();
      notify();
    },

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
    loadStickerSet: (id: string): Promise<StickerSet | undefined> => {
      const cached = read(stickerSets, id);
      if (cached && Date.now() - cached.loadedAt < STICKER_SET_TTL_MS) return Promise.resolve(cached.value);
      const pending = stickerSetRequests.get(id);
      if (pending) return pending;
      const isCurrent = currentRequest();
      const request = transport.getStickerSet(id).then((value) => {
        if (!isCurrent()) return undefined;
        if (stickerSetRequests.get(id) !== request) return stickerSets.get(id)?.value;
        remember(stickerSets, id, { value, loadedAt: Date.now() }, MAX_STICKER_SETS);
        notify();
        return value;
      }).catch((error: unknown) => {
        if (!isCurrent()) return undefined;
        if (stickerSetRequests.get(id) !== request) return stickerSets.get(id)?.value;
        if (!cached) set({ operationError: onError(error, translate("无法读取贴纸包")) });
        return cached?.value;
      }).finally(() => {
        if (stickerSetRequests.get(id) === request) stickerSetRequests.delete(id);
      });
      stickerSetRequests.set(id, request);
      return request;
    },

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
