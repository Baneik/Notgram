import {
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  bufferedSecondsAhead,
  formatPlaybackTime,
  mediaPlaybackCoordinator,
  STREAM_PAUSE_BUFFER_SECONDS,
} from "../media/mediaPlayback";

interface VideoPlayerProps {
  source?: string;
  poster?: string;
  playbackId: string;
  label: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  downloading?: boolean;
  round?: boolean;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number) => Promise<void>;
  onLoadedMetadata: (source: string, width: number, height: number) => void;
  onError: (source: string) => void;
}

const SINGLE_CLICK_DELAY_MS = 180;
const PAUSED_STREAM_TIMEOUT_MS = 15_000;
const CONTROL_IDLE_TIMEOUT_MS = 1_000;

export function VideoPlayer({
  source,
  poster,
  playbackId,
  label,
  fileId,
  size,
  mimeType,
  downloading = false,
  round = false,
  onRequestStream,
  onSuspendStream,
  onLoadedMetadata,
  onError,
}: VideoPlayerProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingPlayRef = useRef(false);
  const streamingRef = useRef(false);
  const suspendingRef = useRef(false);
  const lastRememberedSecondRef = useRef(0);
  const singleClickTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const suspendTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const controlHideTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const keyboardToggleRef = useRef<() => void>(() => undefined);
  const stableKeyboardToggleRef = useRef(() => keyboardToggleRef.current());
  const [resolvedSource, setResolvedSource] = useState(source);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(true);
  const [floating, setFloating] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);

  const clearSingleClick = () => {
    if (singleClickTimerRef.current !== undefined) {
      globalThis.clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = undefined;
    }
  };

  const clearSuspendTimer = () => {
    if (suspendTimerRef.current !== undefined) {
      globalThis.clearTimeout(suspendTimerRef.current);
      suspendTimerRef.current = undefined;
    }
  };

  const clearControlHideTimer = () => {
    if (controlHideTimerRef.current !== undefined) {
      globalThis.clearTimeout(controlHideTimerRef.current);
      controlHideTimerRef.current = undefined;
    }
  };

  const revealControls = () => {
    if (!floating && !fullscreen) return;
    clearControlHideTimer();
    setControlsVisible(true);
    controlHideTimerRef.current = globalThis.setTimeout(() => {
      setControlsVisible(false);
      controlHideTimerRef.current = undefined;
    }, CONTROL_IDLE_TIMEOUT_MS);
  };

  useEffect(() => {
    if (!source) return;
    clearSuspendTimer();
    streamingRef.current = false;
    setResolvedSource(source);
    setFailed(false);
  }, [source]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setFullscreen(document.fullscreenElement === shellRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    clearControlHideTimer();
    if (!floating && !fullscreen) {
      setControlsVisible(false);
      return;
    }
    setControlsVisible(true);
    controlHideTimerRef.current = globalThis.setTimeout(() => {
      setControlsVisible(false);
      controlHideTimerRef.current = undefined;
    }, CONTROL_IDLE_TIMEOUT_MS);
  }, [floating, fullscreen]);

  useEffect(() => () => {
    clearSingleClick();
    clearSuspendTimer();
    clearControlHideTimer();
    mediaPlaybackCoordinator.releaseKeyboardTarget(
      playbackId,
      stableKeyboardToggleRef.current,
    );
    const video = videoRef.current;
    if (video) {
      mediaPlaybackCoordinator.remember(playbackId, video.currentTime, video.duration);
      mediaPlaybackCoordinator.release(video);
    }
    if (streamingRef.current && fileId !== undefined) void onSuspendStream(fileId);
  }, [fileId, onSuspendStream, playbackId]);

  const claimKeyboardTarget = () => {
    mediaPlaybackCoordinator.claimKeyboardTarget(
      playbackId,
      stableKeyboardToggleRef.current,
    );
  };

  const suspendStream = async () => {
    const video = videoRef.current;
    if (!video || !streamingRef.current || fileId === undefined || suspendingRef.current) return;
    suspendingRef.current = true;
    clearSuspendTimer();
    mediaPlaybackCoordinator.remember(playbackId, video.currentTime, video.duration);
    pendingPlayRef.current = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
    streamingRef.current = false;
    setResolvedSource(undefined);
    setBuffering(false);
    setPlaying(false);
    try {
      await onSuspendStream(fileId);
    } finally {
      suspendingRef.current = false;
    }
  };

  const scheduleStreamSuspension = (video: HTMLVideoElement) => {
    clearSuspendTimer();
    if (!streamingRef.current) return;
    if (bufferedSecondsAhead(video) >= STREAM_PAUSE_BUFFER_SECONDS) {
      void suspendStream();
      return;
    }
    suspendTimerRef.current = globalThis.setTimeout(() => {
      void suspendStream();
    }, PAUSED_STREAM_TIMEOUT_MS);
  };

  const startPlayback = async () => {
    const video = videoRef.current;
    clearSuspendTimer();
    if (resolvedSource && video) {
      await video.play().catch(() => setFailed(true));
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
      streamingRef.current = true;
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
    if (video.paused) void video.play().catch(() => setFailed(true));
    else video.pause();
  };
  keyboardToggleRef.current = togglePlayback;

  const togglePlaybackFromControl = () => {
    claimKeyboardTarget();
    togglePlayback();
  };

  const toggleMuted = () => {
    const video = videoRef.current;
    const nextMuted = !muted;
    if (video) video.muted = nextMuted;
    setMuted(nextMuted);
  };

  const updateVolume = (nextVolume: number) => {
    const video = videoRef.current;
    const nextMuted = nextVolume === 0;
    if (video) {
      video.volume = nextVolume;
      video.muted = nextMuted;
    }
    setVolume(nextVolume);
    setMuted(nextMuted);
  };

  const seek = (nextTime: number) => {
    if (videoRef.current) videoRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const toggleFullscreen = async () => {
    claimKeyboardTarget();
    if (document.fullscreenElement === shellRef.current) {
      await document.exitFullscreen?.();
      return;
    }
    await shellRef.current?.requestFullscreen?.();
  };

  const isOutsideRenderedVideo = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
    const bounds = video.getBoundingClientRect();
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const renderedWidth = video.videoWidth * scale;
    const renderedHeight = video.videoHeight * scale;
    const left = bounds.left + (bounds.width - renderedWidth) / 2;
    const top = bounds.top + (bounds.height - renderedHeight) / 2;
    return clientX < left || clientX > left + renderedWidth ||
      clientY < top || clientY > top + renderedHeight;
  };

  const handleSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    claimKeyboardTarget();
    if (fullscreen && isOutsideRenderedVideo(event.clientX, event.clientY)) {
      event.preventDefault();
      clearSingleClick();
      void document.exitFullscreen?.();
      return;
    }
    if (event.altKey) {
      event.preventDefault();
      clearSingleClick();
      setFloating((current) => !current);
      return;
    }
    if (event.detail !== 1) return;
    clearSingleClick();
    singleClickTimerRef.current = globalThis.setTimeout(() => {
      singleClickTimerRef.current = undefined;
      togglePlayback();
    }, SINGLE_CLICK_DELAY_MS);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    clearSingleClick();
    if (fullscreen && isOutsideRenderedVideo(event.clientX, event.clientY)) {
      void document.exitFullscreen?.();
      return;
    }
    void toggleFullscreen();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.blur();
    togglePlaybackFromControl();
  };

  const stopControlClick = (event: MouseEvent) => event.stopPropagation();
  const showStartButton = !playing || loading || buffering || failed || downloading;
  const progressStyle = {
    "--video-progress": `${duration > 0 ? Math.min(100, currentTime / duration * 100) : 0}%`,
  } as CSSProperties;
  const remainingTime = Math.max(0, duration - currentTime);

  return (
    <div
      ref={shellRef}
      className={`video-player ${playing ? "is-playing" : "is-paused"} ${floating ? "is-floating" : ""} ${fullscreen ? "is-fullscreen" : ""} ${controlsVisible ? "is-controls-visible" : ""} ${round ? "is-round" : ""}`}
      role="group"
      aria-label={label}
      tabIndex={0}
      onClick={handleSurfaceClick}
      onDoubleClick={handleDoubleClick}
      onFocus={claimKeyboardTarget}
      onPointerDown={claimKeyboardTarget}
      onMouseMove={revealControls}
      onKeyDown={handleKeyDown}
    >
      <video
        ref={videoRef}
        src={resolvedSource}
        poster={poster}
        preload={resolvedSource ? "metadata" : "none"}
        playsInline
        muted={muted}
        aria-label={label}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
          setDuration(nextDuration);
          video.volume = volume;
          video.muted = muted;
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
          void event.currentTarget.play().catch(() => setFailed(true));
        }}
        onPlay={(event) => {
          claimKeyboardTarget();
          clearSuspendTimer();
          mediaPlaybackCoordinator.activate(playbackId, event.currentTarget);
        }}
        onPlaying={() => {
          setPlaying(true);
          setBuffering(false);
          setFailed(false);
        }}
        onPause={(event) => {
          setPlaying(false);
          mediaPlaybackCoordinator.remember(playbackId, event.currentTarget.currentTime, event.currentTarget.duration);
          mediaPlaybackCoordinator.release(event.currentTarget);
          if (!suspendingRef.current) scheduleStreamSuspension(event.currentTarget);
        }}
        onProgress={(event) => {
          const video = event.currentTarget;
          if (video.paused && streamingRef.current &&
            bufferedSecondsAhead(video) >= STREAM_PAUSE_BUFFER_SECONDS) {
            void suspendStream();
          }
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
          clearSuspendTimer();
          setPlaying(false);
          setCurrentTime(0);
          mediaPlaybackCoordinator.clear(playbackId);
          mediaPlaybackCoordinator.release(event.currentTarget);
        }}
        onError={() => {
          if (suspendingRef.current) return;
          setBuffering(false);
          setFailed(true);
          pendingPlayRef.current = false;
          if (resolvedSource) onError(resolvedSource);
        }}
      />

      <button
        className="video-mute"
        type="button"
        aria-label={muted ? "打开声音" : "静音"}
        title={muted ? "打开声音" : "静音"}
        onClick={(event) => {
          stopControlClick(event);
          claimKeyboardTarget();
          toggleMuted();
        }}
      >
        {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </button>

      {showStartButton && (
        <button
          className="video-start"
          type="button"
          aria-label={failed ? `重试播放 ${label}` : playing ? `暂停 ${label}` : `播放 ${label}`}
          title={failed ? "重试播放" : playing ? "暂停" : "播放"}
          onClick={(event) => {
            stopControlClick(event);
            togglePlaybackFromControl();
          }}
        >
          {loading || buffering || downloading
            ? <LoaderCircle className="spin" size={23} />
            : playing
              ? <Pause size={22} fill="currentColor" />
              : <Play size={22} fill="currentColor" />}
        </button>
      )}

      <input
        className="video-inline-seek"
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || 0)}
        aria-label="播放进度"
        style={progressStyle}
        onClick={stopControlClick}
        onFocus={claimKeyboardTarget}
        onChange={(event) => seek(Number(event.currentTarget.value))}
      />

      <div className="video-floating-controls" onClick={stopControlClick}>
        <div className="video-controls-top">
          <div className="video-controls-volume">
            <button type="button" aria-label={muted ? "打开声音" : "静音"} title={muted ? "打开声音" : "静音"} onClick={toggleMuted}>
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              className="video-floating-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="音量"
              onChange={(event) => updateVolume(Number(event.currentTarget.value))}
            />
          </div>
          <button className="video-controls-play" type="button" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={togglePlaybackFromControl}>
            {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
          </button>
          <div className="video-controls-actions">
            {floating && !fullscreen && (
              <button className="video-return-inline" type="button" aria-label="返回会话播放" title="返回会话" onClick={() => setFloating(false)}>
                <Minimize2 size={18} />
              </button>
            )}
            <button type="button" aria-label={fullscreen ? "退出全屏" : "全屏播放"} title={fullscreen ? "退出全屏" : "全屏"} onClick={() => void toggleFullscreen()}>
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          </div>
        </div>
        <div className="video-controls-progress">
          <span>{formatPlaybackTime(currentTime)}</span>
          <input
            className="video-floating-seek"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            aria-label="浮窗播放进度"
            onChange={(event) => seek(Number(event.currentTarget.value))}
          />
          <span>-{formatPlaybackTime(remainingTime)}</span>
        </div>
      </div>
    </div>
  );
}
