import { describe, expect, it } from "vitest";
import type { MessageContent } from "./types";
import { messageContentText, messagePreviewText } from "./messageContent";

const media = (mediaType: Extract<MessageContent, { kind: "media" }>["mediaType"], fileName: string, caption?: string): MessageContent => ({
  kind: "media",
  mediaType,
  fileName,
  sizeLabel: "媒体",
  caption,
});

describe("message preview text", () => {
  it("uses media labels instead of transport file names", () => {
    expect(messagePreviewText(media("video", "clip.mp4"))).toBe("视频");
    expect(messagePreviewText(media("animation", "animation.mp4"))).toBe("动图");
    expect(messagePreviewText(media("sticker", "sticker.webp"))).toBe("贴纸");
    expect(messagePreviewText(media("photo", "photo.jpg"))).toBe("图片");
  });

  it("keeps captions and actual document names in previews", () => {
    expect(messagePreviewText(media("photo", "photo.jpg", "旅行照片"))).toBe("旅行照片");
    const document: MessageContent = {
      kind: "file",
      fileName: "archive.zip",
      sizeLabel: "1 KB",
    };
    expect(messagePreviewText(document)).toBe("archive.zip");
    expect(messageContentText(media("video", "clip.mp4"))).toBe("clip.mp4");
  });
});
