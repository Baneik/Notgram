import type { EmojiPickerAsset } from "../telegram/types";

/** A thumbnail is its own file; never download a full animation just to paint a pack cover. */
export const emojiAssetPreview = (asset: EmojiPickerAsset): EmojiPickerAsset | undefined => asset.previewFileId === undefined ? undefined : ({
  id: `preview:${asset.previewFileId}`,
  kind: "sticker",
  fileId: asset.previewFileId,
  remoteId: asset.previewRemoteId,
  localPath: asset.previewPath,
  fileName: "thumbnail",
  mimeType: asset.previewMimeType,
});
