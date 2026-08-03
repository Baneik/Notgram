import { isTauri } from "@tauri-apps/api/core";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Download,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  bufferedMediaEnd,
  formatPlaybackTime,
  hasPlaybackBuffer,
  rememberVideoVolume,
} from "../media/mediaPlayback";
import {
  formatTransferSpeed,
  readMediaStreamStatus,
  updateMediaStreamPlayback,
} from "../media/mediaStream";
import {
  VIDEO_WINDOW_CHANNEL,
  type VideoWindowDescriptor,
  type VideoWindowMessage,
  type VideoWindowState,
} from "../media/videoWindowBridge";
import { logPerformance } from "../utils/performanceMonitor";

const CONTROL_IDLE_TIMEOUT_MS = 1_000;
const READY_RETRY_INTERVAL_MS = 250;
const STREAM_SYNC_INTERVAL_MS = 500;
const MIN_WINDOW_LONG_EDGE = 320;
const MAX_WINDOW_WIDTH = 960;
const MAX_WINDOW_HEIGHT = 720;

interface VideoWindowProps {
  id: string;
}

export function VideoWindow({ id }: VideoWindowProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const descriptorRef = useRef<VideoWindowDescriptor | undefined>(undefined);
  const hideTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const fullscreenRef = useRef(false);
  const closedRef = useRef(false);
  const rebufferingRef = useRef(false);
  const shouldResumeAfterBufferRef = useRef(false);
  const lastStreamSyncAtRef = useRef(0);
  const lastStreamStatusRef = useRef<{ bytes: number; at: number } | undefined>(undefined);
  const [descriptor, setDescriptor] = useState<VideoWindowDescriptor>();
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.2);
  const [muted, setMuted] = useState(true);
  const [fullscreen, setFullscreenState] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);

  const setFullscreen = (next: boolean) => {
    fullscreenRef.current = next;
    setFullscreenState(next);
  };

  const clearHideTimer = () => {
    if (hideTimerRef.current !== undefined) {
      globalThis.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  };

  const revealControls = () => {
    clearHideTimer();
    setControlsVisible(true);
    hideTimerRef.current = globalThis.setTimeout(() => {
      setControlsVisible(false);
      hideTimerRef.current = undefined;
    }, CONTROL_IDLE_TIMEOUT_MS);
  };

  const captureState = (): VideoWindowState => {
    const video = videoRef.current;
    return {
      currentTime: video?.currentTime ?? currentTime,
      duration: Number.isFinite(video?.duration) ? video?.duration ?? duration : duration,
      volume: video?.volume ?? volume,
      muted: video?.muted ?? muted,
      paused: video?.paused ?? !playing,
      fullscreen: fullscreenRef.current,
    };
  };

  const publishState = (type: "state" | "closed" = "state") => {
    channelRef.current?.postMessage({
      type,
      id,
      state: captureState(),
    } satisfies VideoWindowMessage);
  };

  const refreshBufferedState = (video: HTMLVideoElement) => {
    setBufferedEnd(bufferedMediaEnd(video));
  };

  const syncStreamPlayback = (video: HTMLVideoElement, force = false) => {
    const currentDescriptor = descriptorRef.current;
    if (!currentDescriptor?.streaming || currentDescriptor.fileId === undefined) return;
    const now = performance.now();
    if (!force && now - lastStreamSyncAtRef.current < STREAM_SYNC_INTERVAL_MS) return;
    lastStreamSyncAtRef.current = now;
    void updateMediaStreamPlayback(
      currentDescriptor.fileId,
      video.currentTime,
      Number.isFinite(video.duration) ? video.duration : 0,
      video.paused,
    ).catch(() => undefined);
  };

  const resumeWhenBuffered = (video: HTMLVideoElement) => {
    refreshBufferedState(video);
    if (!rebufferingRef.current || !hasPlaybackBuffer(video)) return false;
    rebufferingRef.current = false;
    setBuffering(false);
    if (shouldResumeAfterBufferRef.current) void video.play().catch(() => undefined);
    return true;
  };

  const waitForPlaybackBuffer = (video: HTMLVideoElement) => {
    if (!descriptorRef.current?.streaming) return false;
    rebufferingRef.current = true;
    shouldResumeAfterBufferRef.current = true;
    setBuffering(true);
    if (!video.paused) video.pause();
    syncStreamPlayback(video, true);
    return true;
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      shouldResumeAfterBufferRef.current = true;
      if (descriptorRef.current?.streaming && !hasPlaybackBuffer(video)) {
        waitForPlaybackBuffer(video);
        return;
      }
      await video.play().catch(() => undefined);
    } else {
      shouldResumeAfterBufferRef.current = false;
      rebufferingRef.current = false;
      setBuffering(false);
      video.pause();
    }
  };

  const toggleFullscreen = async () => {
    const next = !fullscreenRef.current;
    const video = videoRef.current;
    if (next && video) {
      video.muted = false;
      setMuted(false);
      shouldResumeAfterBufferRef.current = true;
      if (descriptorRef.current?.streaming && !hasPlaybackBuffer(video)) waitForPlaybackBuffer(video);
      else await video.play().catch(() => undefined);
    }
    try {
      if (isTauri()) {
        await getCurrentWindow().setFullscreen(next);
      } else if (next) {
        await document.documentElement.requestFullscreen?.();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen?.();
      }
    } catch {
      // The dedicated browser popup is still usable if browser fullscreen is denied.
    }
    setFullscreen(next);
    publishState();
  };

  const closeWindow = async () => {
    if (closedRef.current) return;
    closedRef.current = true;
    publishState("closed");
    if (isTauri()) await getCurrentWindow().close();
    else globalThis.close();
  };

  const requestDownload = () => {
    if (!descriptorRef.current?.downloadable) return;
    channelRef.current?.postMessage({
      type: "command",
      id,
      command: "download",
    } satisfies VideoWindowMessage);
  };

  useEffect(() => {
    document.documentElement.classList.add("video-window-page");
    document.body.classList.add("video-window-page");
    shellRef.current?.focus({ preventScroll: true });
    const channel = new BroadcastChannel(VIDEO_WINDOW_CHANNEL);
    channelRef.current = channel;
    let readyTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    const announceReady = () => {
      channel.postMessage({ type: "ready", id } satisfies VideoWindowMessage);
    };
    channel.onmessage = (event: MessageEvent<VideoWindowMessage>) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      if (message.type === "init") {
        if (readyTimer !== undefined) {
          globalThis.clearInterval(readyTimer);
          readyTimer = undefined;
        }
        const initial = message.descriptor;
        descriptorRef.current = initial;
        setDescriptor(initial);
        setCurrentTime(initial.currentTime);
        setDuration(initial.duration);
        setVolume(initial.volume);
        setMuted(initial.mode === "fullscreen" ? false : initial.muted);
        setFullscreen(initial.mode === "fullscreen");
        logPerformance("video_window_descriptor_received", {
          fullscreen: initial.mode === "fullscreen",
        });
        return;
      }
      if (message.type === "command") {
        if (message.command === "toggle") void togglePlayback();
        else if (message.command === "seek" && typeof message.value === "number") seek(message.value);
        else if (message.command === "close") void closeWindow();
      }
    };
    announceReady();
    readyTimer = globalThis.setInterval(announceReady, READY_RETRY_INTERVAL_MS);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      if (event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void toggleFullscreen();
      } else if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void togglePlayback();
      }
    };
    const handleFullscreenChange = () => {
      if (isTauri()) return;
      setFullscreen(document.fullscreenElement !== null);
    };
    const handleBeforeUnload = () => {
      if (!closedRef.current) publishState("closed");
    };
    globalThis.addEventListener("keydown", handleKeyDown, { capture: true });
    globalThis.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      clearHideTimer();
      if (readyTimer !== undefined) globalThis.clearInterval(readyTimer);
      globalThis.removeEventListener("keydown", handleKeyDown, { capture: true });
      globalThis.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      channel.close();
      channelRef.current = undefined;
      document.documentElement.classList.remove("video-window-page");
      document.body.classList.remove("video-window-page");
    };
  }, [id]);

  useEffect(() => {
    if (!descriptor?.streaming || descriptor.fileId === undefined) {
      lastStreamStatusRef.current = undefined;
      setDownloadSpeed(0);
      return;
    }
    let active = true;
    const sample = async () => {
      const status = await readMediaStreamStatus(descriptor.fileId).catch(() => undefined);
      if (!active || !status) return;
      const now = performance.now();
      const previous = lastStreamStatusRef.current;
      if (previous && status.downloadedBytes >= previous.bytes && now > previous.at) {
        const speed = (status.downloadedBytes - previous.bytes) * 1000 / (now - previous.at);
        if (speed > 0) setDownloadSpeed(speed);
        else if (!status.active) setDownloadSpeed(0);
      }
      lastStreamStatusRef.current = { bytes: status.downloadedBytes, at: now };
    };
    void sample();
    const timer = globalThis.setInterval(() => { void sample(); }, STREAM_SYNC_INTERVAL_MS);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [descriptor?.fileId, descriptor?.streaming]);

  useEffect(() => {
    const ratio = descriptor?.aspectRatio;
    if (!isTauri() || fullscreen || !ratio || !Number.isFinite(ratio) || ratio <= 0) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let correcting = false;
    let previous: { width: number; height: number } | undefined;

    void (async () => {
      const initial = await appWindow.innerSize();
      previous = initial;
      unlisten = await appWindow.onResized(async ({ payload }) => {
        if (disposed || correcting || !previous) return;
        const widthDelta = Math.abs(payload.width - previous.width);
        const heightDelta = Math.abs(payload.height - previous.height);
        let nextWidth = payload.width;
        let nextHeight = payload.height;
        if (widthDelta >= heightDelta) nextHeight = nextWidth / ratio;
        else nextWidth = nextHeight * ratio;

        const scaleUp = Math.max(1, MIN_WINDOW_LONG_EDGE / Math.max(nextWidth, nextHeight));
        nextWidth *= scaleUp;
        nextHeight *= scaleUp;
        const scaleDown = Math.min(1, MAX_WINDOW_WIDTH / nextWidth, MAX_WINDOW_HEIGHT / nextHeight);
        nextWidth = Math.max(1, Math.round(nextWidth * scaleDown));
        nextHeight = Math.max(1, Math.round(nextHeight * scaleDown));
        previous = { width: nextWidth, height: nextHeight };
        if (Math.abs(payload.width - nextWidth) <= 1 && Math.abs(payload.height - nextHeight) <= 1) return;
        correcting = true;
        try {
          await appWindow.setSize(new PhysicalSize(nextWidth, nextHeight));
        } finally {
          correcting = false;
        }
      });
    })().catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [descriptor?.aspectRatio, fullscreen]);

  const updateVolume = (nextVolume: number) => {
    const normalized = rememberVideoVolume(nextVolume);
    const video = videoRef.current;
    if (video) {
      video.volume = normalized;
      video.muted = normalized === 0;
    }
    setVolume(normalized);
    setMuted(normalized === 0);
    publishState();
  };

  const toggleMuted = () => {
    const video = videoRef.current;
    const nextMuted = !(video?.muted ?? muted);
    if (video) video.muted = nextMuted;
    setMuted(nextMuted);
    publishState();
  };

  const seek = (nextTime: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = nextTime;
      refreshBufferedState(videoRef.current);
      syncStreamPlayback(videoRef.current, true);
    }
    setCurrentTime(nextTime);
    publishState();
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

  const handleSurfacePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, .video-window-controls")) return;
    if (fullscreenRef.current && isOutsideRenderedVideo(event.clientX, event.clientY)) {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (isTauri() && !fullscreenRef.current) {
      event.preventDefault();
      void getCurrentWindow().startDragging();
    }
  };

  const remainingTime = Math.max(0, duration - currentTime);
  const progressStyle = {
    "--video-progress": `${duration > 0 ? Math.min(100, currentTime / duration * 100) : 0}%`,
    "--video-buffered": `${duration > 0 ? Math.min(100, bufferedEnd / duration * 100) : 0}%`,
  } as CSSProperties;

  return (
    <div
      ref={shellRef}
      className={`video-window ${fullscreen ? "is-fullscreen" : "is-windowed"} ${controlsVisible ? "is-controls-visible" : ""}`}
      tabIndex={-1}
      aria-label={descriptor?.label ?? "视频播放窗口"}
      onPointerMove={revealControls}
      onPointerDown={handleSurfacePointerDown}
    >
      {descriptor ? (
        <video
          ref={videoRef}
          src={descriptor.source}
          poster={descriptor.poster}
          preload={descriptor.streaming ? "auto" : "metadata"}
          playsInline
          aria-label={descriptor.label}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const nextDuration = Number.isFinite(video.duration) ? video.duration : descriptor.duration;
            video.volume = descriptor.volume;
            video.muted = descriptor.mode === "fullscreen" ? false : descriptor.muted;
            if (descriptor.currentTime > 0 && descriptor.currentTime < nextDuration) {
              video.currentTime = descriptor.currentTime;
            }
            setDuration(nextDuration);
            setCurrentTime(video.currentTime);
            refreshBufferedState(video);
            syncStreamPlayback(video, true);
            if (descriptor.autoplay || descriptor.mode === "fullscreen") {
              shouldResumeAfterBufferRef.current = true;
              if (descriptor.streaming && !hasPlaybackBuffer(video)) waitForPlaybackBuffer(video);
              else void video.play().catch(() => undefined);
            }
            publishState();
          }}
          onCanPlay={(event) => {
            refreshBufferedState(event.currentTarget);
            resumeWhenBuffered(event.currentTarget);
          }}
          onPlay={(event) => {
            shouldResumeAfterBufferRef.current = true;
            syncStreamPlayback(event.currentTarget, true);
            setPlaying(true);
            setBuffering(false);
            publishState();
          }}
          onPlaying={() => {
            setPlaying(true);
            setBuffering(false);
          }}
          onPause={(event) => {
            syncStreamPlayback(event.currentTarget, true);
            setPlaying(false);
            publishState();
          }}
          onProgress={(event) => {
            refreshBufferedState(event.currentTarget);
            syncStreamPlayback(event.currentTarget);
            resumeWhenBuffered(event.currentTarget);
          }}
          onWaiting={(event) => {
            if (!waitForPlaybackBuffer(event.currentTarget)) setBuffering(true);
          }}
          onTimeUpdate={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            refreshBufferedState(event.currentTarget);
            syncStreamPlayback(event.currentTarget);
            publishState();
          }}
          onDurationChange={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration);
          }}
          onEnded={() => {
            rebufferingRef.current = false;
            shouldResumeAfterBufferRef.current = false;
            setPlaying(false);
            setBuffering(false);
            setCurrentTime(0);
            setBufferedEnd(0);
            publishState();
          }}
        />
      ) : <div className="video-window-loading" aria-label="正在准备视频" />}

      {buffering && (
        <div className="video-window-buffering" aria-live="polite">
          <LoaderCircle className="spin" size={32} />
          <span>{formatTransferSpeed(downloadSpeed)}</span>
        </div>
      )}

      <div className="video-window-controls video-windowed-controls">
        <div className="video-window-topbar">
          <div className="video-window-volume">
            <button type="button" aria-label={muted ? "打开声音" : "静音"} title={muted ? "打开声音" : "静音"} onClick={toggleMuted}>
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="音量" onChange={(event) => updateVolume(Number(event.currentTarget.value))} />
          </div>
          <div className="video-window-actions">
            <button type="button" aria-label="全屏播放" title="全屏（F）" onClick={() => void toggleFullscreen()}><Maximize2 size={18} /></button>
            <button type="button" aria-label="关闭小窗" title="关闭" onClick={() => void closeWindow()}><X size={20} /></button>
          </div>
        </div>
        {!playing && !buffering && (
          <button className="video-window-center-play" type="button" aria-label="播放" title="播放" onClick={() => void togglePlayback()}>
            <Play size={34} fill="currentColor" />
          </button>
        )}
        <div className="video-window-bottom">
          <span>{formatPlaybackTime(currentTime)}</span>
          <input type="range" min={0} max={duration || 0} step={0.1} value={Math.min(currentTime, duration || 0)} aria-label="小窗播放进度" style={progressStyle} onChange={(event) => seek(Number(event.currentTarget.value))} />
          <span>-{formatPlaybackTime(remainingTime)}</span>
        </div>
      </div>

      <div className="video-window-controls video-fullscreen-controls">
        <div className="video-fullscreen-top">
          <div className="video-window-volume">
            <button type="button" aria-label={muted ? "打开声音" : "静音"} title={muted ? "打开声音" : "静音"} onClick={toggleMuted}>
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="音量" onChange={(event) => updateVolume(Number(event.currentTarget.value))} />
          </div>
          <button className="video-fullscreen-play" type="button" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={() => void togglePlayback()}>
            {buffering
              ? <LoaderCircle className="spin" size={24} />
              : playing
                ? <Pause size={24} fill="currentColor" />
                : <Play size={24} fill="currentColor" />}
          </button>
          <div className="video-window-actions">
            {descriptor?.downloadable && (
              <button type="button" aria-label="下载视频" title="下载视频" onClick={requestDownload}><Download size={18} /></button>
            )}
            <button type="button" aria-label="退出全屏" title="退出全屏（F）" onClick={() => void toggleFullscreen()}><Minimize2 size={18} /></button>
            <button type="button" aria-label="关闭播放窗口" title="关闭" onClick={() => void closeWindow()}><X size={19} /></button>
          </div>
        </div>
        <div className="video-fullscreen-progress">
          <span>{formatPlaybackTime(currentTime)}</span>
          <input type="range" min={0} max={duration || 0} step={0.1} value={Math.min(currentTime, duration || 0)} aria-label="全屏播放进度" style={progressStyle} onChange={(event) => seek(Number(event.currentTarget.value))} />
          <span>-{formatPlaybackTime(remainingTime)}</span>
        </div>
        {descriptor?.streaming && (
          <span className="video-fullscreen-speed">
            {buffering ? "缓冲中" : "加载"} · {formatTransferSpeed(downloadSpeed)}
          </span>
        )}
      </div>
    </div>
  );
}
