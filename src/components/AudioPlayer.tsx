import { AlertCircle, Download, LoaderCircle, Pause, Play, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  audioPlaybackController,
  type AudioTrackDescriptor,
  useAudioPlayback,
} from "../media/audioPlayback";
import { formatPlaybackTime } from "../media/mediaPlayback";
import { AudioSpectrum } from "./AudioSpectrum";
import { MediaProgressRing } from "./MediaProgressRing";

interface AudioPlayerProps {
  source?: string;
  playbackId: string;
  label: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  durationHint?: number;
  previousPlaybackId?: string;
  nextPlaybackId?: string;
  downloadProgress?: number;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream?: () => void;
  onDownload?: () => void;
  onCancelDownload?: () => void;
}

export function AudioPlayer({
  source,
  playbackId,
  label,
  fileId,
  size,
  mimeType,
  durationHint,
  previousPlaybackId,
  nextPlaybackId,
  downloadProgress,
  onRequestStream,
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
  const failed = active && playback.failed;
  const currentTime = active ? playback.currentTime : 0;
  const duration = active ? playback.duration : durationHint ?? 0;
  const playbackRate = active ? playback.playbackRate : 1;
  const canPlay = Boolean(source || (fileId !== undefined && size && size > 0));
  const playbackLabel = canPlay
    ? playing ? `暂停 ${label}` : `播放 ${label}`
    : `${label} 暂不可播放`;

  return (
    <div className={`audio-player ${active ? "is-active" : ""}`} role="group" aria-label={label}>
      <button
        className="audio-play"
        type="button"
        aria-label={playbackLabel}
        title={canPlay ? playing ? "暂停" : "播放" : "音频文件暂不可用"}
        disabled={!canPlay}
        onClick={() => audioPlaybackController.toggle(track)}
      >
        {loading
          ? <LoaderCircle className="spin" size={18} />
          : failed || !canPlay ? <AlertCircle size={18} />
            : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="audio-waveform-control">
        <AudioSpectrum playbackId={playbackId} playing={playing} bars={30} />
        <input
          className="audio-seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          aria-label="播放进度"
          disabled={!active || duration <= 0}
          onChange={(event) => audioPlaybackController.seek(Number(event.currentTarget.value))}
        />
      </div>
      <span className="audio-time">{formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}</span>
      <button
        className="playback-rate"
        type="button"
        aria-label={`播放速度 ${playbackRate} 倍`}
        title="切换播放速度"
        disabled={!active}
        onClick={() => audioPlaybackController.cyclePlaybackRate()}
      >
        {playbackRate}x
      </button>
      {onCancelDownload ? (
        <button className="audio-download" type="button" aria-label={`取消下载 ${label}`} title="取消下载" onClick={onCancelDownload}>
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
        <button className="audio-download" type="button" aria-label={`下载 ${label}`} title="下载音频" onClick={onDownload}>
          <Download size={16} />
        </button>
      )}
    </div>
  );
}
