import { translate } from "../i18n";
import {
  AlertCircle,
  Download,
  LoaderCircle,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo } from "react";
import {
  audioPlaybackController,
  type AudioTrackDescriptor,
  useAudioPlayback,
} from "../media/audioPlayback";
import { formatPlaybackTime } from "../media/mediaPlayback";
import { MediaProgressRing } from "./MediaProgressRing";
import { useStableVisibility } from "../hooks/useStableVisibility";

interface AudioPlayerProps {
  source?: string;
  playbackId: string;
  label: string;
  displayLabel?: ReactNode;
  subtitle?: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  durationHint?: number;
  previousPlaybackId?: string;
  nextPlaybackId?: string;
  downloadProgress?: number;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onRecoverFile?: (fileId: number) => Promise<boolean>;
  onSuspendStream?: () => void;
  onDownload?: () => void;
  onCancelDownload?: () => void;
}

export function AudioPlayer({
  source,
  playbackId,
  label,
  displayLabel,
  subtitle,
  fileId,
  size,
  mimeType,
  durationHint,
  previousPlaybackId,
  nextPlaybackId,
  downloadProgress,
  onRequestStream,
  onRecoverFile,
  onSuspendStream,
  onDownload,
  onCancelDownload,
}: AudioPlayerProps) {
  const playback = useAudioPlayback();
  const track = useMemo<AudioTrackDescriptor>(() => ({
    id: playbackId,
    label,
    source,
    fileId,
    size,
    mimeType,
    durationHint,
    previousId: previousPlaybackId,
    nextId: nextPlaybackId,
    downloadProgress,
    onRequestStream,
    onRecoverFile,
    onSuspendStream,
    onDownload,
    onCancelDownload,
  }), [
    downloadProgress,
    durationHint,
    fileId,
    label,
    mimeType,
    nextPlaybackId,
    onCancelDownload,
    onDownload,
    onRecoverFile,
    onRequestStream,
    onSuspendStream,
    playbackId,
    previousPlaybackId,
    size,
    source,
  ]);

  useEffect(() => audioPlaybackController.registerTrack(track), [track]);

  const active = playback.track?.id === playbackId;
  const playing = active && playback.playing;
  const loading = active && playback.loading;
  const showLoading = useStableVisibility(loading, { minimumVisible: 220 });
  const failed = active && playback.failed;
  const currentTime = active ? playback.currentTime : 0;
  const duration = active ? playback.duration : durationHint ?? 0;
  const playbackRate = active ? playback.playbackRate : 1;
  const muted = playback.muted || playback.volume <= 0;
  const canPlay = Boolean(source || (fileId !== undefined && size && size > 0));
  const playbackLabel = canPlay
    ? playing ? translate("暂停 {{value0}}", { value0: label }) : translate("播放 {{value0}}", { value0: label })
    : translate("{{value0}} 暂不可播放", { value0: label });
  // TDLib exposes size and duration, not the codec bitrate. Keep the estimate explicit.
  const bitrateDuration = durationHint && durationHint > 0 ? durationHint : duration;
  const bitrate = size && size > 0 && bitrateDuration > 0
    ? Math.round(size * 8 / bitrateDuration / 1000)
    : undefined;
  const progress = duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0;
  const volume = muted ? 0 : playback.volume;

  return (
    <div className={`audio-player ${active ? "is-active" : ""} ${playing ? "is-playing" : ""}`} role="group" aria-label={label}>
      <span className="audio-disc" aria-hidden="true"><span className="audio-disc-hub" /></span>
      <div className="audio-player-body">
        <div className="audio-player-title">
          <strong title={label}>{displayLabel ?? label}</strong>
          {bitrate !== undefined && bitrate > 0 && Number.isFinite(bitrate) && (
            <small className="audio-quality" title={translate("估算平均码率：{{value0}} kbps", { value0: bitrate })}>
              ≈{bitrate}K
            </small>
          )}
        </div>
        <span className="audio-player-artist" title={subtitle}>{subtitle || translate("未知艺术家")}</span>
      </div>
      <button
        className="audio-play"
        type="button"
        aria-label={playbackLabel}
        title={canPlay ? playing ? translate("暂停") : translate("播放") : translate("音频文件暂不可用")}
        disabled={!canPlay}
        onClick={() => audioPlaybackController.toggle(track)}
      >
        {showLoading
          ? <LoaderCircle className="spin" size={18} />
          : failed || !canPlay ? <AlertCircle size={18} />
            : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="audio-player-controls">
        <input
          className="audio-seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          style={{ "--audio-progress": `${progress}%` } as CSSProperties}
          aria-label={translate("播放进度")}
          disabled={!active || duration <= 0}
          onChange={(event) => audioPlaybackController.seek(Number(event.currentTarget.value))}
        />
        <div className="audio-player-details">
          <span className="audio-time"><span>{formatPlaybackTime(currentTime)}</span> / {formatPlaybackTime(duration)}</span>
          <div className="audio-player-actions">
            <button
              className="playback-rate"
              type="button"
              aria-label={translate("播放速度 {{value0}} 倍", { value0: playbackRate })}
              title={translate("切换播放速度")}
              disabled={!active}
              onClick={() => audioPlaybackController.cyclePlaybackRate()}
            >
              {playbackRate}x
            </button>
            <div className="audio-inline-volume">
              <button
                type="button"
                aria-label={muted ? translate("取消静音") : translate("静音")}
                title={muted ? translate("取消静音") : translate("静音")}
                disabled={!active}
                onClick={() => audioPlaybackController.toggleMuted()}
              >
                {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                style={{ "--audio-progress": `${volume * 100}%` } as CSSProperties}
                aria-label={translate("音量")}
                disabled={!active}
                onChange={(event) => audioPlaybackController.setVolume(Number(event.currentTarget.value))}
              />
              <span className="audio-volume-value" aria-hidden="true">{Math.round(volume * 100)}%</span>
            </div>
            {onCancelDownload ? (
              <button className="audio-download" type="button" aria-label={translate("取消下载 {{value0}}", { value0: label })} title={translate("取消下载")} onClick={onCancelDownload}>
                <span
                  className="audio-transfer-indicator"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((downloadProgress ?? 0) * 100)}
                >
                  <MediaProgressRing progress={downloadProgress} size={22} />
                  <X className="audio-transfer-cancel" size={12} />
                </span>
              </button>
            ) : onDownload && (
              <button className="audio-download" type="button" aria-label={translate("下载 {{value0}}", { value0: label })} title={translate("下载音频")} onClick={onDownload}>
                <Download size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
