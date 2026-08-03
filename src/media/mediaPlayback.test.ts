import { describe, expect, it, vi } from "vitest";
import {
  bufferedMediaEnd,
  bufferedSecondsAhead,
  DEFAULT_VIDEO_VOLUME,
  formatPlaybackTime,
  hasPlaybackBuffer,
  MediaPlaybackCoordinator,
  nextPlaybackRate,
  normalizeVideoVolume,
} from "./mediaPlayback";

describe("media playback coordination", () => {
  it("pauses the previous medium before activating another", () => {
    const coordinator = new MediaPlaybackCoordinator();
    const first = { pause: vi.fn() };
    const second = { pause: vi.fn() };

    coordinator.activate("first", first);
    coordinator.activate("second", second);
    coordinator.activate("second", second);

    expect(first.pause).toHaveBeenCalledOnce();
    expect(second.pause).not.toHaveBeenCalled();
  });

  it("routes the global spacebar only to the claimed playback target", () => {
    const coordinator = new MediaPlaybackCoordinator();
    const toggle = vi.fn();

    expect(coordinator.toggleKeyboardTarget()).toBe(false);
    coordinator.claimKeyboardTarget("video", toggle);
    expect(coordinator.toggleKeyboardTarget()).toBe(true);
    expect(toggle).toHaveBeenCalledOnce();
    coordinator.releaseKeyboardTarget("other", toggle);
    expect(coordinator.toggleKeyboardTarget()).toBe(true);
    coordinator.releaseKeyboardTarget("video", toggle);
    expect(coordinator.toggleKeyboardTarget()).toBe(false);
  });

  it("resumes meaningful positions and clears near either edge", () => {
    const coordinator = new MediaPlaybackCoordinator();
    coordinator.remember("track", 42, 120);
    expect(coordinator.resumePosition("track", 120)).toBe(42);
    coordinator.remember("track", 118, 120);
    expect(coordinator.resumePosition("track", 120)).toBe(0);
    coordinator.remember("track", 1, 120);
    expect(coordinator.resumePosition("track", 120)).toBe(0);
  });

  it("cycles supported playback rates and formats long durations", () => {
    expect([1, 1.25, 1.5, 2].map(nextPlaybackRate)).toEqual([1.25, 1.5, 2, 1]);
    expect(formatPlaybackTime(3_661.9)).toBe("61:01");
  });

  it("measures buffered media ahead of the current playhead", () => {
    const buffered = {
      length: 2,
      start: (index: number) => [0, 30][index],
      end: (index: number) => [10, 55][index],
    } as TimeRanges;

    expect(bufferedSecondsAhead({ buffered, currentTime: 42 })).toBe(13);
    expect(bufferedSecondsAhead({ buffered, currentTime: 20 })).toBe(0);
    expect(bufferedMediaEnd({ buffered, currentTime: 42 })).toBe(55);
    expect(hasPlaybackBuffer({ buffered, currentTime: 42, duration: 120 })).toBe(false);
    expect(hasPlaybackBuffer({ buffered, currentTime: 42, duration: 55 })).toBe(true);
  });

  it("uses a safe twenty-percent default for remembered video volume", () => {
    expect(DEFAULT_VIDEO_VOLUME).toBe(0.2);
    expect(normalizeVideoVolume(Number.NaN)).toBe(0.2);
    expect(normalizeVideoVolume(-1)).toBe(0);
    expect(normalizeVideoVolume(2)).toBe(1);
  });
});
