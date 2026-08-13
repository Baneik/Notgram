import { describe, expect, it, vi } from "vitest";
import {
  bufferedMediaEnd,
  bufferedSecondsAhead,
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_VIDEO_VOLUME,
  formatPlaybackTime,
  hasPlaybackBuffer,
  MediaPlaybackCoordinator,
  nextPlaybackRate,
  normalizeAudioVolume,
  normalizeVideoVolume,
  STREAM_PAUSE_BUFFER_SECONDS,
  STREAM_RESUME_BUFFER_SECONDS,
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

  it("continues only to a registered adjacent audio target", () => {
    const coordinator = new MediaPlaybackCoordinator();
    const play = vi.fn();
    const unregister = coordinator.registerAutoplayTarget("chat:next", play);

    expect(coordinator.requestAutoplay("chat:missing")).toBe(false);
    expect(coordinator.requestAutoplay("chat:next")).toBe(true);
    expect(play).toHaveBeenCalledOnce();
    unregister();
    expect(coordinator.requestAutoplay("chat:next")).toBe(false);
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
    expect(STREAM_RESUME_BUFFER_SECONDS).toBe(5);
    expect(STREAM_PAUSE_BUFFER_SECONDS).toBe(10);
    expect(hasPlaybackBuffer({ buffered, currentTime: 42, duration: 120 })).toBe(true);
    expect(hasPlaybackBuffer({ buffered, currentTime: 42, duration: 120 }, 15)).toBe(false);
    expect(hasPlaybackBuffer({ buffered, currentTime: 42, duration: 55 })).toBe(true);
  });

  it("uses a safe twenty-percent default for remembered video volume", () => {
    expect(DEFAULT_VIDEO_VOLUME).toBe(0.2);
    expect(normalizeVideoVolume(Number.NaN)).toBe(0.2);
    expect(normalizeVideoVolume(-1)).toBe(0);
    expect(normalizeVideoVolume(2)).toBe(1);
  });

  it("keeps audio volume within the native media range", () => {
    expect(DEFAULT_AUDIO_VOLUME).toBe(1);
    expect(normalizeAudioVolume(Number.NaN)).toBe(1);
    expect(normalizeAudioVolume(-1)).toBe(0);
    expect(normalizeAudioVolume(0.42)).toBe(0.42);
    expect(normalizeAudioVolume(2)).toBe(1);
  });
});
