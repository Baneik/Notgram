import { describe, expect, it } from "vitest";
import { attachmentAlbumFamily, classifyOutgoingAttachment } from "./outgoingAttachments";

const fileLike = (name: string, type: string, size = 100) => ({ name, type, size });

describe("outgoing attachment classification", () => {
  it("maps Telegram media kinds from MIME types and extensions", () => {
    expect(classifyOutgoingAttachment(fileLike("photo.jpg", "image/jpeg"))).toBe("photo");
    expect(classifyOutgoingAttachment(fileLike("clip.mp4", ""))).toBe("video");
    expect(classifyOutgoingAttachment(fileLike("song.flac", "audio/flac"))).toBe("audio");
    expect(classifyOutgoingAttachment(fileLike("loop.gif", "image/gif"))).toBe("animation");
    expect(classifyOutgoingAttachment(fileLike("notes.pdf", "application/pdf"))).toBe("document");
  });

  it("falls back to a document for oversized Telegram photos", () => {
    expect(classifyOutgoingAttachment(fileLike(
      "large.png",
      "image/png",
      10 * 1024 * 1024 + 1,
    ))).toBe("document");
  });

  it("allows photos and videos to share a visual album", () => {
    expect(attachmentAlbumFamily("photo")).toBe("visual");
    expect(attachmentAlbumFamily("video")).toBe("visual");
    expect(attachmentAlbumFamily("audio")).toBe("audio");
    expect(attachmentAlbumFamily("animation")).toBe("animation");
  });
});
