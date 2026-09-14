import { describe, expect, it } from "vitest";
import { photoSources } from "./photoSources";
import type { PhotoContent } from "../utils/mediaViewerModel";

const photo: PhotoContent = { kind: "media", mediaType: "photo", fileName: "image.jpg", sizeLabel: "2 MB", localPath: "/original.jpg", thumbnailPath: "/thumbnail.jpg", previewDataUrl: "data:image/jpeg;base64,preview" };
describe("viewer image sources", () => {
  it("uses small sources for the strip and originals for the stage", () => {
    expect(photoSources(photo)).toEqual([photo.localPath, photo.thumbnailPath, photo.previewDataUrl]);
    expect(photoSources(photo, true)).toEqual([photo.thumbnailPath, photo.previewDataUrl, photo.localPath]);
  });
  it("preserves a retained preview when the original is missing and removes duplicate attempts", () => {
    expect(photoSources({ ...photo, localPath: undefined, thumbnailPath: undefined })).toEqual([photo.previewDataUrl]);
    expect(photoSources({ ...photo, thumbnailPath: photo.localPath, previewDataUrl: undefined })).toEqual([photo.localPath]);
  });
});
