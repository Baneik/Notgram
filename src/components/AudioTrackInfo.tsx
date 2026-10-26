import type { ReactNode } from "react";
import { Mic } from "lucide-react";
import { translate } from "../i18n";

interface AudioTrackInfoProps {
  label: string;
  title?: string;
  subtitle?: string;
  displayTitle?: ReactNode;
  size?: number;
  duration?: number;
  durationHint?: number;
  playing: boolean;
  mediaType?: "audio" | "voice";
}

export function AudioTrackInfo({
  label, title, subtitle, displayTitle, size, duration = 0, durationHint, playing, mediaType,
}: AudioTrackInfoProps) {
  // TDLib exposes size and duration, not the codec bitrate. Keep the estimate explicit.
  const bitrateDuration = durationHint && durationHint > 0 ? durationHint : duration;
  const bitrate = size && size > 0 && bitrateDuration > 0
    ? Math.round(size * 8 / bitrateDuration / 1000)
    : undefined;

  return (
    <>
      {mediaType === "voice"
        ? <span className="audio-voice-symbol" aria-hidden="true"><Mic size={23} /></span>
        : <span className={`audio-disc ${playing ? "is-spinning" : ""}`} aria-hidden="true"><span className="audio-disc-hub" /></span>}
      <div className="audio-player-body">
        <div className="audio-player-title">
          <strong title={label}>{displayTitle ?? title ?? label}</strong>
          {mediaType !== "voice" && bitrate !== undefined && bitrate > 0 && Number.isFinite(bitrate) && (
            <small className="audio-quality" title={translate("估算平均码率：{{value0}} kbps", { value0: bitrate })}>
              ≈{bitrate}K
            </small>
          )}
        </div>
        <span className="audio-player-artist" title={subtitle}>{subtitle || (mediaType === "voice" ? translate("语音消息") : translate("未知艺术家"))}</span>
      </div>
    </>
  );
}
