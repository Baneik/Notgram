import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import {
  MAX_MEDIA_VIEWER_THUMBNAILS,
  adjacentPhotoId,
  photoMessages,
  photoThumbnailWindow,
} from "./mediaViewerModel";

const message = (id: string, kind: "photo" | "text"): Message => ({
  id,
  chatId: "chat",
  senderId: "user",
  outgoing: false,
  sentAt: "2026-08-01T00:00:00Z",
  delivery: "read",
  content: kind === "photo"
    ? { kind: "media", mediaType: "photo", fileName: `${id}.jpg`, sizeLabel: "1 KB" }
    : { kind: "text", text: id },
});

describe("media viewer model", () => {
  it("keeps only photos in conversation order", () => {
    expect(photoMessages([message("one", "photo"), message("skip", "text"), message("two", "photo")])
      .map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("does not wrap navigation at either edge", () => {
    const photos = photoMessages([message("one", "photo"), message("two", "photo")]);
    expect(adjacentPhotoId(photos, "one", -1)).toBeUndefined();
    expect(adjacentPhotoId(photos, "one", 1)).toBe("two");
    expect(adjacentPhotoId(photos, "two", 1)).toBeUndefined();
  });

  it("keeps at most nine thumbnails centered around the active photo", () => {
    const photos = photoMessages(Array.from(
      { length: 15 },
      (_, index) => message(`photo-${index + 1}`, "photo"),
    ));

    expect(photoThumbnailWindow(photos, "photo-8").map((item) => item.id)).toEqual([
      "photo-4",
      "photo-5",
      "photo-6",
      "photo-7",
      "photo-8",
      "photo-9",
      "photo-10",
      "photo-11",
      "photo-12",
    ]);
    expect(photoThumbnailWindow(photos, "photo-1")).toEqual(
      photos.slice(0, MAX_MEDIA_VIEWER_THUMBNAILS),
    );
    expect(photoThumbnailWindow(photos, "photo-15")).toEqual(
      photos.slice(-MAX_MEDIA_VIEWER_THUMBNAILS),
    );
  });
});
