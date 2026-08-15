import { describe, expect, it } from "vitest";
import { videoWindowRoute, videoWindowSize } from "./videoWindowBridge";

it("routes browser playback to the isolated video entry", () => {
  expect(videoWindowRoute("video 1")).toBe("/video-window.html?id=video%201");
});

describe("video playback window sizing", () => {
  it("keeps landscape and portrait videos at their real aspect ratio", () => {
    expect(videoWindowSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(videoWindowSize(1080, 1920)).toEqual({ width: 405, height: 720 });
  });

  it("bounds oversized windows and gives tiny media a usable frame", () => {
    expect(videoWindowSize(3840, 2160)).toEqual({ width: 960, height: 540 });
    expect(videoWindowSize(100, 100)).toEqual({ width: 320, height: 320 });
  });
});
