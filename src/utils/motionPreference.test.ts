import { describe, expect, it } from "vitest";
import {
  autoplayAllowed,
  effectiveReduceMotion,
  motionScrollBehavior,
} from "./motionPreference";

describe("motion preference policy", () => {
  it("combines the app setting with the operating system preference", () => {
    expect(effectiveReduceMotion({ reduceMotion: false, systemReduceMotion: false })).toBe(false);
    expect(effectiveReduceMotion({ reduceMotion: true, systemReduceMotion: false })).toBe(true);
    expect(effectiveReduceMotion({ reduceMotion: false, systemReduceMotion: true })).toBe(true);
  });

  it("only allows autoplay when both the preference and motion policy allow it", () => {
    expect(autoplayAllowed(true, { reduceMotion: false, systemReduceMotion: false })).toBe(true);
    expect(autoplayAllowed(false, { reduceMotion: false, systemReduceMotion: false })).toBe(false);
    expect(autoplayAllowed(true, { reduceMotion: true, systemReduceMotion: false })).toBe(false);
    expect(autoplayAllowed(true, { reduceMotion: false, systemReduceMotion: true })).toBe(false);
  });

  it("downgrades smooth scroll without changing explicit auto behavior", () => {
    expect(motionScrollBehavior("smooth", { reduceMotion: false, systemReduceMotion: false })).toBe("smooth");
    expect(motionScrollBehavior("smooth", { reduceMotion: true, systemReduceMotion: false })).toBe("auto");
    expect(motionScrollBehavior("auto", { reduceMotion: false, systemReduceMotion: true })).toBe("auto");
  });
});
