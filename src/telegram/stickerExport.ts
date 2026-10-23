import type { EmojiPickerAsset } from "./types";

export const stickerExportExtension = (asset: EmojiPickerAsset) => {
  if (asset.mimeType === "application/x-tgsticker") return "tgs";
  if (asset.mimeType === "video/webm") return "webm";
  if (asset.mimeType === "image/webp") return "webp";
  const extension = asset.fileName.split(".").at(-1)?.toLowerCase();
  if (extension && ["webp", "webm", "tgs"].includes(extension)) return extension;
  throw new Error("Unsupported sticker format");
};

export const stickerExportFileName = (asset: EmojiPickerAsset, name: string, index: number, count: number) =>
  `${Array.from(name).slice(0, 90).join("")}${count > 1 ? `_${String(index + 1).padStart(3, "0")}` : ""}.${stickerExportExtension(asset)}`;
