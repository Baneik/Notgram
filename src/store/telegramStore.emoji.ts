import { translate } from "../i18n";
import { clearTgsAnimationCache } from "../media/tgsAnimationCache";
import { clearLocalAssetCache } from "../media/localAssetCache";
import type { TelegramTransport } from "../telegram/transport";
import type { EmojiPickerAsset, EmojiPickerCatalog, StickerSet } from "../telegram/types";
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
  let catalogRevision = 0;
  let catalog: CachedValue<EmojiPickerCatalog> | undefined;
  let catalogRequest: Promise<EmojiPickerCatalog | undefined> | undefined;
  const stickerSets = new Map<string, CachedValue<StickerSet>>();
  const stickerSetRequests = new Map<string, Promise<StickerSet | undefined>>();
  const assetPaths = new Map<number, string>();
  const assetRequests = new Map<number, Promise<string | undefined>>();

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
      set({ operationError: undefined });
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
        remember(stickerSets, id, { value, loadedAt: Date.now() }, MAX_STICKER_SETS);
        set({ operationError: undefined });
        return value;
      }).catch((error: unknown) => {
        if (!isCurrent()) return undefined;
        if (!cached) set({ operationError: onError(error, translate("无法读取贴纸包")) });
        return cached?.value;
      }).finally(() => {
        if (stickerSetRequests.get(id) === request) stickerSetRequests.delete(id);
      });
      stickerSetRequests.set(id, request);
      return request;
    },

    addStickerSet: async (id: string) => {
      const isCurrent = currentRequest();
      try {
        await transport.addStickerSet(id);
        if (!isCurrent()) return false;
        invalidateCatalog();
        set({ operationError: undefined });
        void loadEmojiPicker();
        return true;
      } catch (error) {
        if (isCurrent()) set({ operationError: onError(error, translate("添加贴纸包失败")) });
        return false;
      }
    },

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
    },

    getCachedEmojiAsset: (asset: EmojiPickerAsset) => asset.localPath
      ? remember(assetPaths, asset.fileId, asset.localPath, MAX_ASSET_PATHS)
      : read(assetPaths, asset.fileId),
    loadEmojiAsset: (asset: EmojiPickerAsset): Promise<string | undefined> => {
      const path = asset.localPath
        ? remember(assetPaths, asset.fileId, asset.localPath, MAX_ASSET_PATHS)
        : read(assetPaths, asset.fileId);
      if (path) return Promise.resolve(path);
      const pending = assetRequests.get(asset.fileId);
      if (pending) return pending;
      const isCurrent = currentRequest();
      const request = transport.loadEmojiAsset(asset).then((value) => {
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
