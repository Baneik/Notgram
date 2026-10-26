import { describe, expect, it } from "vitest";
import { decodeVoiceWaveform, voiceWaveformPath } from "./voiceWaveform";

describe("voice-note waveforms", () => {
  it("unpacks low-bit-first amplitudes across byte boundaries", () => {
    expect(decodeVoiceWaveform("IIjxISI=")).toEqual([0, 1, 2, 3, 31, 16, 8, 4]);
    expect(decodeVoiceWaveform("/w==")).toEqual([31]);
  });

  it.each([undefined, "", "unavailable!", "A".repeat(1400)])("keeps unavailable waveform data safe (%s)", value => {
    expect(decodeVoiceWaveform(value)).toEqual([]);
    expect(voiceWaveformPath(value)).toBe(voiceWaveformPath());
    expect(voiceWaveformPath(value)).not.toContain("NaN");
  });

  it("keeps narrow peaks when reducing a longer waveform to the message width", () => {
    const bytes = new Uint8Array(100);
    bytes[49] = 255;
    const path = voiceWaveformPath(btoa(String.fromCharCode(...bytes)));
    expect(path.split(" ")).toHaveLength(40);
    expect(path).toMatch(/M[\d.]+,0v32/);
  });
});
