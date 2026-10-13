import type { CachedTelegramSnapshot, EmojiPickerAsset, EmojiPickerCatalog, StickerSet, StickerSetSummary } from "../telegram/types";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const asset = (value: unknown): value is EmojiPickerAsset => record(value) && typeof value.id === "string" &&
  (value.kind === "sticker" || value.kind === "animation") && Number.isSafeInteger(value.fileId) &&
  Number(value.fileId) > 0 && typeof value.fileName === "string" &&
  ["remoteId", "remoteUniqueId", "previewRemoteId", "stickerSetId", "emoji", "mimeType", "previewMimeType", "localPath", "previewPath"].every(
    key => value[key] === undefined || typeof value[key] === "string",
  ) && (value.previewFileId === undefined || (Number.isSafeInteger(value.previewFileId) && Number(value.previewFileId) > 0)) &&
  ["width", "height", "duration"].every(key => value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0)) &&
  (value.previewDataUrl === undefined || (typeof value.previewDataUrl === "string" && value.previewDataUrl.length <= 65_536 &&
    (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value.previewDataUrl) ||
      /^data:image\/svg\+xml;charset=utf-8,/.test(value.previewDataUrl))));
const assets = (value: unknown, limit: number) => Array.isArray(value) ? value.filter(asset).slice(0, limit) : [];
const summary = (value: unknown): StickerSetSummary | undefined => {
  if (!record(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.title !== "string" ||
    typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) return undefined;
  return { id: value.id, name: value.name, title: value.title, size: value.size, covers: assets(value.covers, 5),
    isInstalled: value.isInstalled === true, isArchived: value.isArchived === true };
};

/** A corrupt optional picker section must not discard messages or durable drafts. */
export const migrateEmojiPickerCache = (value: Record<string, unknown>): Pick<CachedTelegramSnapshot,
  "emojiPickerCatalog" | "emojiPickerSets" | "emojiPickerPreviews"> => {
  const raw = value.emojiPickerCatalog;
  const catalog: EmojiPickerCatalog | undefined = record(raw) && Array.isArray(raw.recentStickers) &&
    Array.isArray(raw.stickerSets) && Array.isArray(raw.savedAnimations) ? {
      recentStickers: assets(raw.recentStickers, 100), savedAnimations: assets(raw.savedAnimations, 500),
      stickerSets: raw.stickerSets.flatMap(value => summary(value) ?? []).slice(0, 1_000),
    } : undefined;
  const sets: StickerSet[] = Array.isArray(value.emojiPickerSets) ? value.emojiPickerSets.flatMap(value => {
    const set = summary(value);
    return set && record(value) && Array.isArray(value.stickers) ? [{ ...set, stickers: assets(value.stickers, 500) }] : [];
  }).slice(0, 1_128) : [];
  let bytes = 0;
  const previews = Array.isArray(value.emojiPickerPreviews) ? value.emojiPickerPreviews.flatMap(value => {
    if (!record(value) || typeof value.key !== "string" || value.key.length > 1_024 || typeof value.dataUrl !== "string" ||
      value.dataUrl.length > 32_768 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl) ||
      bytes + value.dataUrl.length * 2 > 24 * 1024 * 1024) return [];
    bytes += value.dataUrl.length * 2;
    return [{ key: value.key, dataUrl: value.dataUrl }];
  }) : [];
  return { emojiPickerCatalog: catalog, emojiPickerSets: sets, emojiPickerPreviews: previews };
};
