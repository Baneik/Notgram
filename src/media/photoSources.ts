import { localMediaSource } from "./localMediaSource";
import type { PhotoContent } from "../utils/mediaViewerModel";

export const photoSources = (content: PhotoContent, thumbnail = false) => {
  const original = localMediaSource(content.localPath);
  const preview = localMediaSource(content.thumbnailPath);
  return [...new Set((thumbnail
    ? [preview, content.previewDataUrl, original]
    : [original, preview, content.previewDataUrl]
  ).filter((source): source is string => Boolean(source)))];
};
