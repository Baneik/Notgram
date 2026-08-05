import { describe, expect, it } from "vitest";
import type { MessageContent } from "../telegram/types";
import {
  nextVisibleMediaFileId,
  shouldAutoDownload,
  type AutoDownloadPolicy,
} from "./autoDownload";

const policy: AutoDownloadPolicy = {
  images: true,
  videos: false,
  audio: true,
  files: false,
  limitMb: 10,
};

const media = (overrides: Partial<Extract<MessageContent, { kind: "media" }>> = {}) => ({
  kind: "media" as const,
  mediaType: "photo" as const,
  fileName: "photo.jpg",
  sizeLabel: "2 MB",
  fileId: 7,
  size: 2 * 1024 * 1024,
  canDownload: true,
  ...overrides,
});

describe("automatic media downloads", () => {
  it("honors media type switches and the size limit", () => {
    expect(shouldAutoDownload(media(), policy)).toBe(true);
    expect(shouldAutoDownload(media({ mediaType: "video" }), policy)).toBe(false);
    expect(shouldAutoDownload(media({ mediaType: "voice" }), policy)).toBe(true);
    expect(shouldAutoDownload(media({ size: 11 * 1024 * 1024 }), policy)).toBe(false);
  });

  it("never requeues completed, active, or unknown-size files", () => {
    expect(shouldAutoDownload(media({ isDownloaded: true }), policy)).toBe(false);
    expect(shouldAutoDownload(media({ isDownloading: true }), policy)).toBe(false);
    expect(shouldAutoDownload(media({ size: undefined }), policy)).toBe(false);
  });

  it("applies the ordinary-file switch independently", () => {
    const file: MessageContent = {
      kind: "file",
      fileName: "archive.zip",
      sizeLabel: "2 MB",
      fileId: 11,
      size: 2 * 1024 * 1024,
      canDownload: true,
    };

    expect(shouldAutoDownload(file, policy)).toBe(false);
    expect(shouldAutoDownload(file, { ...policy, files: true })).toBe(true);
  });

  it("loads a video poster before starting the full visible video download", () => {
    expect(nextVisibleMediaFileId(media({ mediaType: "video" }), 93, 31)).toBe(31);
    expect(nextVisibleMediaFileId(media({ mediaType: "videoNote" }), 94, 32)).toBe(32);
    expect(nextVisibleMediaFileId(media({ mediaType: "photo" }), 95, 33)).toBe(95);
    expect(nextVisibleMediaFileId(media({ mediaType: "video" }), 93, undefined)).toBe(93);
  });
});
