import { describe, expect, it } from "vitest";
import {
  fitMediaLayout,
  MEDIA_READABLE_CARD_WIDTH,
  VIDEO_MIN_CARD_WIDTH,
} from "./mediaLayout";

describe("media layout", () => {
  it("fits portrait media by height without leaving a wide outer shell", () => {
    expect(fitMediaLayout("photo", 900, 1_800)).toMatchObject({
      maxWidth: 390,
      maxHeight: 420,
      width: 210,
      height: 420,
      contentWidth: 210,
      contentHeight: 420,
      aspectRatio: "210 / 420",
    });
  });

  it("fits landscape and square media by width", () => {
    expect(fitMediaLayout("photo", 1_800, 600)).toMatchObject({
      width: 390,
      height: 130,
      contentWidth: 390,
      aspectRatio: "390 / 130",
    });
    expect(fitMediaLayout("photo", 512, 512)).toMatchObject({
      width: 390,
      height: 390,
      contentWidth: 390,
    });
  });

  it("only widens captioned media and never lets short text narrow it", () => {
    expect(fitMediaLayout("photo", 900, 1_800, { hasReadableText: true }))
      .toMatchObject({
        width: MEDIA_READABLE_CARD_WIDTH,
        height: 420,
        contentWidth: 210,
        aspectRatio: "320 / 420",
      });
    expect(fitMediaLayout("photo", 1_800, 600, { hasReadableText: true }))
      .toMatchObject({
        width: 390,
        height: 130,
        contentWidth: 390,
        aspectRatio: "390 / 130",
      });
  });

  it("reserves control width for narrow videos without changing round media", () => {
    expect(fitMediaLayout("video", 720, 1_440)).toMatchObject({
      width: VIDEO_MIN_CARD_WIDTH,
      height: 420,
      contentWidth: 210,
    });
    expect(fitMediaLayout("videoNote", 320, 640, { hasReadableText: true }))
      .toMatchObject({ width: 140, height: 280, contentWidth: 140 });
  });

  it("uses media-specific bounds and tolerates missing dimensions", () => {
    expect(fitMediaLayout("sticker", 512, 512)).toMatchObject({ width: 240, height: 240 });
    expect(fitMediaLayout("videoNote", 640, 640)).toMatchObject({ width: 280, height: 280 });
    expect(fitMediaLayout("photo")).toEqual({
      maxWidth: 390,
      maxHeight: 420,
      width: 390,
      contentWidth: 390,
    });
  });
});
