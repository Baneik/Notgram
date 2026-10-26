import { useMemo } from "react";
import { translate } from "../i18n";
import { formatPlaybackTime } from "../media/mediaPlayback";
import { voiceWaveformPath } from "../media/voiceWaveform";

interface VoiceWaveformProps {
  waveform?: string;
  currentTime: number;
  duration: number;
  disabled: boolean;
  onSeek: (time: number) => void;
}

export function VoiceWaveform({ waveform, currentTime, duration, disabled, onSeek }: VoiceWaveformProps) {
  const path = useMemo(() => voiceWaveformPath(waveform), [waveform]);
  const progress = duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0;
  return (
    <div className="voice-waveform">
      <svg viewBox="0 0 200 32" preserveAspectRatio="none" aria-hidden="true">
        <path d={path} />
      </svg>
      <svg className="voice-waveform-played" viewBox="0 0 200 32" preserveAspectRatio="none"
        style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }} aria-hidden="true">
        <path d={path} />
      </svg>
      <input type="range" min={0} max={duration || 0} step={0.1}
        value={Math.min(currentTime, duration || 0)} disabled={disabled}
        aria-label={translate("播放进度")} aria-valuetext={`${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`}
        onChange={event => onSeek(Number(event.currentTarget.value))} />
    </div>
  );
}
