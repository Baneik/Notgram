import { describe, expect, it } from "vitest";
import { clampImageTransform, emptyWheelNavigation, fitImage, navigateImageWheel, zoomImageAt } from "./imageViewport";

describe("image viewport geometry", () => {
  it("fits landscape and portrait images without upscaling small originals", () => {
    expect(fitImage({ width: 4000, height: 2000 }, { width: 1000, height: 600 })).toEqual({ width: 1000, height: 500 });
    expect(fitImage({ width: 2000, height: 4000 }, { width: 1000, height: 600 })).toEqual({ width: 300, height: 600 });
    expect(fitImage({ width: 100, height: 50 }, { width: 1000, height: 600 })).toEqual({ width: 100, height: 50 });
  });
  it("keeps the image point under the pointer fixed when zooming", () => {
    const before = { zoom: 2, x: 30, y: -20 };
    const point = { x: 140, y: 100 };
    const after = zoomImageAt(before, 3, point);
    expect((point.x - after.x) / after.zoom).toBe((point.x - before.x) / before.zoom);
    expect((point.y - after.y) / after.zoom).toBe((point.y - before.y) / before.zoom);
  });
  it("bounds panning on each axis and recenters dimensions that fit", () => {
    expect(clampImageTransform({ zoom: 2, x: 5000, y: -5000 }, { width: 1000, height: 300 }, { width: 1000, height: 800 }))
      .toEqual({ zoom: 2, x: 500, y: 0 });
    expect(clampImageTransform({ zoom: 1, x: 500, y: -100 }, { width: 1000, height: 500 }, { width: 1000, height: 800 }))
      .toEqual({ zoom: 1, x: 0, y: 0 });
  });
});

describe("wheel navigation intent", () => {
  it("accumulates small deltas and suppresses inertia immediately after a turn", () => {
    const state = emptyWheelNavigation();
    expect(navigateImageWheel(state, 1, 0)).toBeUndefined();
    expect(navigateImageWheel(state, 1, 20)).toBeUndefined();
    expect(navigateImageWheel(state, 1, 40)).toBeUndefined();
    expect(navigateImageWheel(state, 57, 60)).toBe(1);
    expect(navigateImageWheel(state, 240, 100)).toBeUndefined();
    expect(navigateImageWheel(state, 120, 400)).toBe(1);
  });
  it("does not carry distance across a direction change or a new gesture", () => {
    const state = emptyWheelNavigation();
    expect(navigateImageWheel(state, 50, 0)).toBeUndefined();
    expect(navigateImageWheel(state, -20, 20)).toBeUndefined();
    expect(navigateImageWheel(state, -50, 300)).toBeUndefined();
    expect(navigateImageWheel(state, -10, 320)).toBe(-1);
  });
});
