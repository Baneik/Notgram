import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { adjacentPhotoId, photoMessages } from "./mediaViewerModel";

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
});
