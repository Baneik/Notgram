import { LoaderCircle, Pause, Play, Volume2, VolumeX } from "lucide-react";
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
  DEFAULT_VIDEO_VOLUME,
  mediaPlaybackCoordinator,
  normalizeVideoVolume,
  readRememberedVideoVolume,
  rememberVideoVolume,
  STREAM_PAUSE_BUFFER_SECONDS,
} from "../media/mediaPlayback";
import {
  closePlaybackWindow,
  createPlaybackWindow,
  createVideoWindowId,
  listenForVideoWindowRequest,
  VIDEO_WINDOW_CHANNEL,
  videoWindowSize,
  type VideoWindowDescriptor,
  type VideoWindowMessage,
  type VideoWindowMode,
  type VideoWindowState,
} from "../media/videoWindowBridge";
import { logPerformance } from "../utils/performanceMonitor";

interface VideoPlayerProps {
  source?: string;
  poster?: string;
  playbackId: string;
  label: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  downloading?: boolean;
  round?: boolean;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number) => Promise<void>;
  onLoadedMetadata: (source: string, width: number, height: number) => void;
  onError: (source: string) => void;
}

interface ExternalPlaybackSession {
  id: string;
  channel: BroadcastChannel;
  initializationTimer?: ReturnType<typeof globalThis.setTimeout>;
  lastState?: VideoWindowState;
}

const SINGLE_CLICK_DELAY_MS = 180;
const PAUSED_STREAM_TIMEOUT_MS = 15_000;
const VIDEO_WINDOW_INITIALIZATION_TIMEOUT_MS = 8_000;

export function VideoPlayer({
  source,
  poster,
  playbackId,
  label,
  fileId,
  size,
  mimeType,
  mediaWidth,
  mediaHeight,
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
  const loadingRef = useRef(false);
  const inlineSoundEnabledRef = useRef(false);
  const lastRememberedSecondRef = useRef(0);
  const singleClickTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const suspendTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const keyboardToggleRef = useRef<() => void>(() => undefined);
  const stableKeyboardToggleRef = useRef(() => keyboardToggleRef.current());
  const externalOpenRef = useRef<(mode: VideoWindowMode) => void>(() => undefined);
  const externalSessionRef = useRef<ExternalPlaybackSession | undefined>(undefined);
  const [resolvedSource, setResolvedSource] = useState(source);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(readRememberedVideoVolume);
  const [muted, setMuted] = useState(true);

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

  useEffect(() => {
    if (!source) return;
    clearSuspendTimer();
    streamingRef.current = false;
    setResolvedSource(source);
    setFailed(false);
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = !inlineSoundEnabledRef.current || volume === 0;
  }, [volume]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      const visibleHeightRatio = entry && entry.boundingClientRect.height > 0
        ? entry.intersectionRect.height / entry.boundingClientRect.height
        : 0;
      const video = videoRef.current;
      if (visibleHeightRatio < 0.5 && video && !video.paused && !externalSessionRef.current) {
        video.pause();
      }
    }, { threshold: [0, 0.5, 1] });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => listenForVideoWindowRequest(
    playbackId,
    () => externalOpenRef.current("window"),
  ), [playbackId]);

  useEffect(() => () => {
    clearSingleClick();
    clearSuspendTimer();
    mediaPlaybackCoordinator.releaseKeyboardTarget(
      playbackId,
      stableKeyboardToggleRef.current,
    );
    const session = externalSessionRef.current;
    if (session) {
      if (session.initializationTimer !== undefined) {
        globalThis.clearTimeout(session.initializationTimer);
      }
      session.channel.postMessage({
        type: "command",
        id: session.id,
        command: "close",
      } satisfies VideoWindowMessage);
      session.channel.close();
      externalSessionRef.current = undefined;
    }
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
    if (!video || externalSessionRef.current || !streamingRef.current ||
      fileId === undefined || suspendingRef.current) return;
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
    if (externalSessionRef.current || !streamingRef.current) return;
    if (bufferedSecondsAhead(video) >= STREAM_PAUSE_BUFFER_SECONDS) {
      void suspendStream();
      return;
    }
    suspendTimerRef.current = globalThis.setTimeout(() => {
      void suspendStream();
    }, PAUSED_STREAM_TIMEOUT_MS);
  };

  const requestStreamSource = async (playInline: boolean) => {
    if (resolvedSource) return resolvedSource;
    if (loadingRef.current || fileId === undefined || !size) return undefined;
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const streamSource = await onRequestStream(fileId, size, mimeType);
      if (!streamSource) {
        setFailed(true);
        return undefined;
      }
      streamingRef.current = true;
      pendingPlayRef.current = playInline;
      setResolvedSource(streamSource);
      setBuffering(playInline);
      return streamSource;
    } catch {
      setFailed(true);
      return undefined;
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const startPlayback = async () => {
    const video = videoRef.current;
    clearSuspendTimer();
    if (resolvedSource && video) {
      await video.play().catch(() => setFailed(true));
      return;
    }
    await requestStreamSource(true);
  };

  const applyExternalState = (state: VideoWindowState, closed: boolean) => {
    const rememberedVolume = closed
      ? rememberVideoVolume(state.volume)
      : normalizeVideoVolume(state.volume);
    setVolume(rememberedVolume);
    setCurrentTime(state.currentTime);
    setDuration(state.duration);
    setPlaying(closed ? false : !state.paused);
    mediaPlaybackCoordinator.remember(playbackId, state.currentTime, state.duration);
    const video = videoRef.current;
    if (!closed || !video) return;
    video.pause();
    if (state.currentTime >= 0 && Number.isFinite(state.currentTime)) {
      video.currentTime = state.currentTime;
    }
    video.volume = rememberedVolume;
    const nextMuted = !inlineSoundEnabledRef.current || rememberedVolume === 0;
    video.muted = nextMuted;
    setMuted(nextMuted);
    scheduleStreamSuspension(video);
  };

  const finishExternalSession = (session: ExternalPlaybackSession, state: VideoWindowState) => {
    if (externalSessionRef.current !== session) return;
    if (session.initializationTimer !== undefined) {
      globalThis.clearTimeout(session.initializationTimer);
    }
    externalSessionRef.current = undefined;
    applyExternalState(state, true);
    session.channel.close();
  };

  const openPlaybackWindow = async (mode: VideoWindowMode) => {
    claimKeyboardTarget();
    let playbackSource = resolvedSource;
    if (!playbackSource) playbackSource = await requestStreamSource(false);
    if (!playbackSource) return;

    const previous = externalSessionRef.current;
    if (previous) {
      if (previous.initializationTimer !== undefined) {
        globalThis.clearTimeout(previous.initializationTimer);
      }
      previous.channel.postMessage({
        type: "command",
        id: previous.id,
        command: "close",
      } satisfies VideoWindowMessage);
      previous.channel.close();
      externalSessionRef.current = undefined;
    }

    const video = videoRef.current;
    const wasPlaying = Boolean(video && !video.paused);
    const initialTime = video?.currentTime ?? currentTime;
    const initialDuration = Number.isFinite(video?.duration) ? video?.duration ?? duration : duration;
    const id = createVideoWindowId();
    const channel = new BroadcastChannel(VIDEO_WINDOW_CHANNEL);
    const session: ExternalPlaybackSession = { id, channel };
    externalSessionRef.current = session;
    clearSuspendTimer();
    video?.pause();
    setPlaying(mode === "fullscreen" || wasPlaying);

    const descriptor: VideoWindowDescriptor = {
      id,
      source: playbackSource,
      poster,
      label,
      currentTime: initialTime,
      duration: initialDuration,
      volume,
      muted: mode === "fullscreen" ? false : muted,
      autoplay: mode === "fullscreen" || wasPlaying,
      mode,
    };
    let resolveInitialized: (() => void) | undefined;
    const initialized = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    channel.onmessage = (event: MessageEvent<VideoWindowMessage>) => {
      const message = event.data;
      if (!message || message.id !== id || externalSessionRef.current !== session) return;
      if (message.type === "ready") {
        channel.postMessage({ type: "init", id, descriptor } satisfies VideoWindowMessage);
        if (resolveInitialized) {
          resolveInitialized();
          resolveInitialized = undefined;
          logPerformance("video_window_initialized", {
            fullscreen: mode === "fullscreen",
          });
        }
      } else if (message.type === "state") {
        session.lastState = message.state;
        applyExternalState(message.state, false);
      } else if (message.type === "closed") {
        session.lastState = message.state;
        finishExternalSession(session, message.state);
      }
    };

    const naturalWidth = video?.videoWidth || mediaWidth || 16;
    const naturalHeight = video?.videoHeight || mediaHeight || 9;
    const initializationTimeout = new Promise<never>((_, reject) => {
      session.initializationTimer = globalThis.setTimeout(() => {
        reject(new Error("video window initialization timed out"));
      }, VIDEO_WINDOW_INITIALIZATION_TIMEOUT_MS);
    });
    logPerformance("video_window_open_started", {
      fullscreen: mode === "fullscreen",
    });
    try {
      await Promise.race([
        (async () => {
          const created = await createPlaybackWindow(
            id,
            videoWindowSize(naturalWidth, naturalHeight),
            mode,
          );
          if (!created) throw new Error("video popup was blocked");
          await initialized;
        })(),
        initializationTimeout,
      ]);
      if (session.initializationTimer !== undefined) {
        globalThis.clearTimeout(session.initializationTimer);
        session.initializationTimer = undefined;
      }
    } catch {
      if (externalSessionRef.current === session) {
        if (session.initializationTimer !== undefined) {
          globalThis.clearTimeout(session.initializationTimer);
        }
        channel.postMessage({
          type: "command",
          id,
          command: "close",
        } satisfies VideoWindowMessage);
        void closePlaybackWindow(id).catch(() => undefined);
        externalSessionRef.current = undefined;
        channel.close();
        setPlaying(false);
        if (video && wasPlaying) void video.play().catch(() => setFailed(true));
        logPerformance("video_window_open_failed", {
          fullscreen: mode === "fullscreen",
        });
      }
    }
  };
  externalOpenRef.current = (mode) => { void openPlaybackWindow(mode); };

  const togglePlayback = () => {
    const session = externalSessionRef.current;
    if (session) {
      session.channel.postMessage({
        type: "command",
        id: session.id,
        command: "toggle",
      } satisfies VideoWindowMessage);
      return;
    }
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
    inlineSoundEnabledRef.current = !nextMuted;
    let nextVolume = volume;
    if (!nextMuted && nextVolume === 0) {
      nextVolume = rememberVideoVolume(DEFAULT_VIDEO_VOLUME);
      setVolume(nextVolume);
    }
    if (video) {
      video.volume = nextVolume;
      video.muted = nextMuted;
    }
    setMuted(nextMuted);
  };

  const seek = (nextTime: number) => {
    const session = externalSessionRef.current;
    if (session) {
      session.channel.postMessage({
        type: "command",
        id: session.id,
        command: "seek",
        value: nextTime,
      } satisfies VideoWindowMessage);
    } else if (videoRef.current) {
      videoRef.current.currentTime = nextTime;
    }
    setCurrentTime(nextTime);
  };

  const handleSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    claimKeyboardTarget();
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
    void openPlaybackWindow("fullscreen");
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

  return (
    <div
      ref={shellRef}
      className={`video-player ${playing ? "is-playing" : "is-paused"} ${round ? "is-round" : ""}`}
      role="group"
      aria-label={label}
      tabIndex={0}
      onClick={handleSurfaceClick}
      onDoubleClick={handleDoubleClick}
      onFocus={claimKeyboardTarget}
      onPointerDown={claimKeyboardTarget}
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
          video.muted = !inlineSoundEnabledRef.current || volume === 0;
          setMuted(video.muted);
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
          if (!externalSessionRef.current) setPlaying(false);
          mediaPlaybackCoordinator.remember(playbackId, event.currentTarget.currentTime, event.currentTarget.duration);
          mediaPlaybackCoordinator.release(event.currentTarget);
          if (!suspendingRef.current) scheduleStreamSuspension(event.currentTarget);
        }}
        onProgress={(event) => {
          const video = event.currentTarget;
          if (!externalSessionRef.current && video.paused && streamingRef.current &&
            bufferedSecondsAhead(video) >= STREAM_PAUSE_BUFFER_SECONDS) {
            void suspendStream();
          }
        }}
        onWaiting={() => setBuffering(true)}
        onTimeUpdate={(event) => {
          if (externalSessionRef.current) return;
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
    </div>
  );
}
