import { describe, expect, it } from "vitest";
import { fitMediaLayout } from "./mediaLayout";

describe("media layout", () => {
  it("fits portrait media by height without leaving a wide outer shell", () => {
    expect(fitMediaLayout("photo", 900, 1_800)).toEqual({
      maxWidth: 390,
      maxHeight: 420,
      width: 210,
      height: 420,
      aspectRatio: "900 / 1800",
    });
  });

  it("fits landscape and square media by width", () => {
    expect(fitMediaLayout("photo", 1_800, 600)).toMatchObject({ width: 390, height: 130 });
    expect(fitMediaLayout("photo", 512, 512)).toMatchObject({ width: 390, height: 390 });
  });

  it("uses media-specific bounds and tolerates missing dimensions", () => {
    expect(fitMediaLayout("sticker", 512, 512)).toMatchObject({ width: 240, height: 240 });
    expect(fitMediaLayout("videoNote", 640, 640)).toMatchObject({ width: 280, height: 280 });
    expect(fitMediaLayout("photo")).toEqual({ maxWidth: 390, maxHeight: 420, width: 390 });
  });
});
