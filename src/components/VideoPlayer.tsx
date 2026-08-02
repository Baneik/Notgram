import {
  Download,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  formatPlaybackTime,
  mediaPlaybackCoordinator,
  nextPlaybackRate,
} from "../media/mediaPlayback";

interface VideoPlayerProps {
  source?: string;
  poster?: string;
  playbackId: string;
  label: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  downloadProgress?: number;
  round?: boolean;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onDownload?: () => void;
  onLoadedMetadata: (source: string, width: number, height: number) => void;
  onError: (source: string) => void;
}

export function VideoPlayer({
  source,
  poster,
  playbackId,
  label,
  fileId,
  size,
  mimeType,
  downloadProgress,
  round = false,
  onRequestStream,
  onDownload,
  onLoadedMetadata,
  onError,
}: VideoPlayerProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingPlayRef = useRef(false);
  const lastRememberedSecondRef = useRef(0);
  const [resolvedSource, setResolvedSource] = useState(source);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    if (!source) return;
    setResolvedSource(source);
    setFailed(false);
  }, [source]);

  useEffect(() => () => {
    const video = videoRef.current;
    if (!video) return;
    mediaPlaybackCoordinator.remember(playbackId, video.currentTime, video.duration);
    mediaPlaybackCoordinator.release(video);
  }, [playbackId]);

  const startPlayback = async () => {
    const video = videoRef.current;
    if (resolvedSource && video) {
      await video.play().catch(() => undefined);
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
      setBuffering(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || !resolvedSource) {
      void startPlayback();
      return;
    }
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  const toggleMuted = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const cyclePlaybackRate = () => {
    const next = nextPlaybackRate(playbackRate);
    if (videoRef.current) videoRef.current.playbackRate = next;
    setPlaybackRate(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    togglePlayback();
  };

  const stopControlClick = (event: MouseEvent) => event.stopPropagation();
  const showStartButton = !playing || loading || buffering || failed;

  return (
    <div
      ref={shellRef}
      className={`video-player ${playing ? "is-playing" : "is-paused"} ${round ? "is-round" : ""}`}
      role="group"
      aria-label={label}
      tabIndex={0}
      onClick={togglePlayback}
      onKeyDown={handleKeyDown}
    >
      <video
        ref={videoRef}
        src={resolvedSource}
        poster={poster}
        preload={resolvedSource ? "metadata" : "none"}
        playsInline
        aria-label={label}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
          setDuration(nextDuration);
          video.playbackRate = playbackRate;
          const resume = mediaPlaybackCoordinator.resumePosition(playbackId, nextDuration);
          if (resume > 0) {
            video.currentTime = resume;
            setCurrentTime(resume);
          }
          if (resolvedSource) onLoadedMetadata(resolvedSource, video.videoWidth, video.videoHeight);
        }}
        onCanPlay={(event) => {
          setBuffering(false);
          if (!pendingPlayRef.current) return;
          pendingPlayRef.current = false;
          void event.currentTarget.play().catch(() => undefined);
        }}
        onPlay={(event) => mediaPlaybackCoordinator.activate(playbackId, event.currentTarget)}
        onPlaying={() => { setPlaying(true); setBuffering(false); setFailed(false); }}
        onPause={(event) => {
          setPlaying(false);
          mediaPlaybackCoordinator.remember(playbackId, event.currentTarget.currentTime, event.currentTarget.duration);
          mediaPlaybackCoordinator.release(event.currentTarget);
        }}
        onWaiting={() => setBuffering(true)}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          setCurrentTime(video.currentTime);
          const wholeSecond = Math.floor(video.currentTime);
          if (wholeSecond - lastRememberedSecondRef.current >= 5) {
            lastRememberedSecondRef.current = wholeSecond;
            mediaPlaybackCoordinator.remember(playbackId, video.currentTime, video.duration);
          }
        }}
        onEnded={(event) => {
          setPlaying(false);
          setCurrentTime(0);
          mediaPlaybackCoordinator.clear(playbackId);
          mediaPlaybackCoordinator.release(event.currentTarget);
        }}
        onError={() => {
          setBuffering(false);
          setFailed(true);
          pendingPlayRef.current = false;
          if (resolvedSource) onError(resolvedSource);
        }}
      />

      {showStartButton && (
        <button
          className="video-start"
          type="button"
          aria-label={failed ? `重试播放 ${label}` : playing ? `暂停 ${label}` : `播放 ${label}`}
          title={failed ? "重试播放" : playing ? "暂停" : "播放"}
          onClick={(event) => { stopControlClick(event); togglePlayback(); }}
        >
          {loading || buffering
            ? <LoaderCircle className="spin" size={22} />
            : playing
              ? <Pause size={22} fill="currentColor" />
              : <Play size={22} fill="currentColor" />}
        </button>
      )}

      {!resolvedSource && downloadProgress !== undefined && downloadProgress > 0 && (
        <span className="video-download-progress">{Math.round(downloadProgress * 100)}%</span>
      )}

      <div className="video-controls" onClick={stopControlClick}>
        <button type="button" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={togglePlayback}>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <span className="video-time">{formatPlaybackTime(currentTime)}</span>
        <input
          className="video-seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          aria-label="播放进度"
          onChange={(event) => {
            const nextTime = Number(event.currentTarget.value);
            if (videoRef.current) videoRef.current.currentTime = nextTime;
            setCurrentTime(nextTime);
          }}
        />
        <span className="video-time">{formatPlaybackTime(duration)}</span>
        <button type="button" aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"} onClick={toggleMuted}>
          {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <input
          className="video-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="音量"
          onChange={(event) => {
            const nextVolume = Number(event.currentTarget.value);
            const video = videoRef.current;
            if (video) {
              video.volume = nextVolume;
              video.muted = nextVolume === 0;
            }
            setVolume(nextVolume);
            setMuted(nextVolume === 0);
          }}
        />
        <button className="playback-rate" type="button" aria-label={`播放速度 ${playbackRate} 倍`} title="切换播放速度" onClick={cyclePlaybackRate}>
          {playbackRate}x
        </button>
        {onDownload && (
          <button type="button" aria-label={`下载 ${label}`} title="下载视频" onClick={onDownload}>
            <Download size={16} />
          </button>
        )}
        <button
          type="button"
          aria-label="全屏播放"
          title="全屏"
          onClick={() => void shellRef.current?.requestFullscreen?.()}
        >
          <Maximize2 size={16} />
        </button>
      </div>
    </div>
  );
}
