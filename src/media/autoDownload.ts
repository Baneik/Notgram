import type { MessageContent } from "../telegram/types";

export interface AutoDownloadPolicy {
  images: boolean;
  videos: boolean;
  audio: boolean;
  files: boolean;
  limitMb: number;
}

const categoryEnabled = (content: MessageContent, policy: AutoDownloadPolicy) => {
  if (content.kind === "file") return policy.files;
  if (content.kind !== "media") return false;
  if (["photo", "sticker", "animation"].includes(content.mediaType)) return policy.images;
  if (["video", "videoNote"].includes(content.mediaType)) return policy.videos;
  return policy.audio;
};

export const shouldAutoDownload = (content: MessageContent, policy: AutoDownloadPolicy) => {
  if (
    (content.kind !== "file" && content.kind !== "media") ||
    content.fileId === undefined ||
    content.canDownload !== true ||
    content.isDownloaded === true ||
    content.isDownloading === true ||
    !categoryEnabled(content, policy) ||
    !content.size
  ) {
    return false;
  }
  const limitBytes = Math.max(1, Math.min(2_048, policy.limitMb)) * 1024 * 1024;
  return content.size <= limitBytes;
};
