import { localMediaSource } from "./localMediaSource";
import type { ViewerMessage } from "../utils/mediaViewerModel";

export const photoSources = (content: ViewerMessage["content"], thumbnail = false) => {
  const original = localMediaSource(content.localPath);
  const preview = localMediaSource(content.thumbnailPath);
  return [...new Set((thumbnail
    ? [preview, content.previewDataUrl, original]
    : [original, preview, content.previewDataUrl]
  ).filter((source): source is string => Boolean(source)))];
};
