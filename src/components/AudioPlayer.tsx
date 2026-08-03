import { AlertCircle, Download, LoaderCircle, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  formatPlaybackTime,
  mediaPlaybackCoordinator,
  nextPlaybackRate,
} from "../media/mediaPlayback";

interface AudioPlayerProps {
  source?: string;
  playbackId: string;
  label: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  downloadProgress?: number;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
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
  downloadProgress,
  onRequestStream,
  onDownload,
  onCancelDownload,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingPlayRef = useRef(false);
  const lastRememberedSecondRef = useRef(0);
  const [resolvedSource, setResolvedSource] = useState(source);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    if (!source) return;
    setResolvedSource(source);
    setFailed(false);
  }, [source]);

  useEffect(() => () => {
    const audio = audioRef.current;
    if (!audio) return;
    mediaPlaybackCoordinator.remember(playbackId, audio.currentTime, audio.duration);
    mediaPlaybackCoordinator.release(audio);
  }, [playbackId]);

  const startPlayback = async () => {
    const audio = audioRef.current;
    if (resolvedSource && audio) {
      await audio.play().catch(() => setFailed(true));
      return;
    }
    if (loading || fileId === undefined || !size) return;
    setLoading(true);
    setFailed(false);
    try {
      const streamSource = await onRequestStream(fileId, size, mimeType);
      if (!streamSource) {
        setFailed(true);
        return;
      }
      pendingPlayRef.current = true;
      setResolvedSource(streamSource);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || !resolvedSource) {
      void startPlayback();
      return;
    }
    if (audio.paused) void audio.play().catch(() => setFailed(true));
    else audio.pause();
  };

  const cyclePlaybackRate = () => {
    const next = nextPlaybackRate(playbackRate);
    if (audioRef.current) audioRef.current.playbackRate = next;
    setPlaybackRate(next);
  };

  return (
    <div className="audio-player" role="group" aria-label={label}>
      <audio
        ref={audioRef}
        src={resolvedSource}
        preload={resolvedSource ? "metadata" : "none"}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          const nextDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
          setDuration(nextDuration);
          audio.playbackRate = playbackRate;
          const resume = mediaPlaybackCoordinator.resumePosition(playbackId, nextDuration);
          if (resume > 0) {
            audio.currentTime = resume;
            setCurrentTime(resume);
          }
        }}
        onCanPlay={(event) => {
          if (!pendingPlayRef.current) return;
          pendingPlayRef.current = false;
          void event.currentTarget.play().catch(() => setFailed(true));
        }}
        onPlay={(event) => mediaPlaybackCoordinator.activate(playbackId, event.currentTarget)}
        onPlaying={() => { setPlaying(true); setFailed(false); }}
        onPause={(event) => {
          setPlaying(false);
          mediaPlaybackCoordinator.remember(playbackId, event.currentTarget.currentTime, event.currentTarget.duration);
          mediaPlaybackCoordinator.release(event.currentTarget);
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          setCurrentTime(audio.currentTime);
          const wholeSecond = Math.floor(audio.currentTime);
          if (wholeSecond - lastRememberedSecondRef.current >= 5) {
            lastRememberedSecondRef.current = wholeSecond;
            mediaPlaybackCoordinator.remember(playbackId, audio.currentTime, audio.duration);
          }
        }}
        onEnded={(event) => {
          setPlaying(false);
          setCurrentTime(0);
          mediaPlaybackCoordinator.clear(playbackId);
          mediaPlaybackCoordinator.release(event.currentTarget);
        }}
        onError={() => { setFailed(true); setPlaying(false); }}
      />
      <button className="audio-play" type="button" aria-label={playing ? `暂停 ${label}` : `播放 ${label}`} title={playing ? "暂停" : "播放"} onClick={togglePlayback}>
        {loading
          ? <LoaderCircle className="spin" size={17} />
          : failed ? <AlertCircle size={17} />
            : playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
      </button>
      <span className="audio-time">{formatPlaybackTime(currentTime)}</span>
      <input
        className="audio-seek"
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || 0)}
        aria-label="播放进度"
        onChange={(event) => {
          const nextTime = Number(event.currentTarget.value);
          if (audioRef.current) audioRef.current.currentTime = nextTime;
          setCurrentTime(nextTime);
        }}
      />
      <span className="audio-time">{formatPlaybackTime(duration)}</span>
      <button className="playback-rate" type="button" aria-label={`播放速度 ${playbackRate} 倍`} title="切换播放速度" onClick={cyclePlaybackRate}>
        {playbackRate}x
      </button>
      {onCancelDownload ? (
        <button className="audio-download" type="button" aria-label={`取消下载 ${label}`} title="取消下载" onClick={onCancelDownload}>
          <span className="audio-transfer-indicator">
            <LoaderCircle className="spin" size={22} strokeWidth={1.8} />
            <X className="audio-transfer-cancel" size={12} />
          </span>
        </button>
      ) : onDownload && (
        <button className="audio-download" type="button" aria-label={`下载 ${label}`} title="下载音频" onClick={onDownload}>
          <Download size={15} />
        </button>
      )}
      {!resolvedSource && downloadProgress !== undefined && downloadProgress > 0 && !onCancelDownload && (
        <span className="audio-transfer-indicator" aria-label="音频加载中">
          <LoaderCircle className="spin" size={22} strokeWidth={1.8} />
        </span>
      )}
    </div>
  );
}
