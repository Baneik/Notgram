import { describe, expect, it } from "vitest";
import {
  clampAudioFloatingPosition,
  defaultAudioFloatingPosition,
} from "./audioFloatingPosition";

describe("audio floating controller position", () => {
  const bounds = { left: 340, top: 32, right: 1280, bottom: 800 };
  const size = { width: 336, height: 190 };

  it("starts below the conversation header at the right edge", () => {
    expect(defaultAudioFloatingPosition(bounds, size)).toEqual({ x: 932, y: 104 });
  });

  it("keeps every edge inside the conversation", () => {
    expect(clampAudioFloatingPosition({ x: -500, y: 2_000 }, bounds, size)).toEqual({
      x: 352,
      y: 598,
    });
  });
});
