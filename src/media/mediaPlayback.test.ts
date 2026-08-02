import { describe, expect, it, vi } from "vitest";
import {
  formatPlaybackTime,
  MediaPlaybackCoordinator,
  nextPlaybackRate,
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
});
