import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentAlbumFamily,
  classifyOutgoingAttachment,
  inspectOutgoingAttachment,
} from "./outgoingAttachments";

const fileLike = (name: string, type: string, size = 100) => ({ name, type, size });

describe("outgoing attachment classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("captures a cover when video readiness events complete synchronously", async () => {
    class FakeVideo extends EventTarget {
      muted = false;
      preload = "";
      readyState = 0;
      seeking = false;
      duration = 9;
      videoWidth = 1280;
      videoHeight = 720;
      private mediaTime = 0;

      set src(_value: string) {
        this.readyState = 1;
        this.dispatchEvent(new Event("loadedmetadata"));
      }

      set currentTime(value: number) {
        this.mediaTime = value;
        this.readyState = 2;
        this.dispatchEvent(new Event("seeked"));
      }

      get currentTime() {
        return this.mediaTime;
      }

      removeAttribute() {}
      load() {}
    }

    const drawImage = vi.fn();
    const video = new FakeVideo();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) => callback(new Blob(["cover"], { type: "image/jpeg" })),
    };
    vi.stubGlobal("document", {
      createElement: (tag: string) => tag === "video" ? video : canvas,
    });
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:clip",
      revokeObjectURL: vi.fn(),
    });

    const result = await inspectOutgoingAttachment(
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
    );

    expect(result).toMatchObject({
      kind: "video",
      width: 1280,
      height: 720,
      duration: 9,
    });
    expect(result.thumbnail).toMatchObject({ name: "clip-cover.jpg", type: "image/jpeg" });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
  });
});
