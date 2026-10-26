const MAX_WAVEFORM_BYTES = 1024;

export function decodeVoiceWaveform(waveform?: string): number[] {
  if (!waveform || waveform.length > Math.ceil(MAX_WAVEFORM_BYTES / 3) * 4) return [];
  try {
    const bytes = atob(waveform);
    if (bytes.length > MAX_WAVEFORM_BYTES) return [];
    // Telegram packs consecutive 5-bit amplitudes from the low bits of each byte.
    return Array.from({ length: Math.floor(bytes.length * 8 / 5) }, (_, index) => {
      const bit = index * 5;
      const offset = bit >> 3;
      const pair = bytes.charCodeAt(offset) | ((bytes.charCodeAt(offset + 1) || 0) << 8);
      return (pair >> (bit & 7)) & 31;
    });
  } catch {
    return [];
  }
}

export function voiceWaveformPath(waveform?: string): string {
  const samples = decodeVoiceWaveform(waveform);
  const bars = 40;
  return Array.from({ length: bars }, (_, index) => {
    const start = Math.floor(index * samples.length / bars);
    const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / bars));
    let peak = 0;
    for (let sample = start; sample < end; sample += 1) peak = Math.max(peak, samples[sample] ?? 0);
    // Unknown waveforms stay flat rather than implying fabricated audio data.
    const height = 4 + peak / 31 * 28;
    return `M${index * 5 + 2.5},${(32 - height) / 2}v${height}`;
  }).join(" ");
}
