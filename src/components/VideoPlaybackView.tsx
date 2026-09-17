import { isTauri } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LoaderCircle, Maximize2, Minimize2, Pause, PictureInPicture2, Play, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { translate } from "../i18n";
import { bufferedMediaEnd, formatPlaybackTime, nextPlaybackRate } from "../media/mediaPlayback";
import { localMediaSource } from "../media/localMediaSource";
import type { VideoAction, VideoCommand, VideoFailure, VideoPhase, VideoSource, VideoState } from "../media/videoPlayback";
import { videoWindowSize } from "../media/videoWindowBridge";
import { logPerformance } from "../utils/performanceMonitor";
import { MediaViewer, type MediaViewerProps } from "./MediaViewer";

interface Props extends MediaViewerProps {
  source?: VideoSource;
  command?: { command: VideoCommand; revision: number; sequence: number; value?: number };
  initiallyWindowed?: boolean;
  modeRequest?: { windowed: boolean; sequence: number };
  onVideoState: (source: VideoSource, state: VideoState) => void;
  onVideoAction: (source: VideoSource, action: VideoAction, value?: number) => void;
}

const failureText = (failure: VideoFailure) => {
  switch (failure) {
    case "network": return translate("视频网络连接中断，请重试");
    case "decode": return translate("视频无法解码，文件可能损坏");
    case "unsupported": return translate("当前环境不支持此视频格式");
    case "play": return translate("播放未能开始，请点击重试");
    default: return translate("视频来源加载失败");
  }
};

/** Playback, zoom and viewer chrome have separate owners. Mode changes keep this element mounted. */
export function VideoPlaybackView({ source, command, initiallyWindowed = false, modeRequest, onVideoState, onVideoAction, ...viewer }: Props) {
  const active = viewer.messages.find(message => message.id === viewer.activeMessageId);
  const isVideo = active && active.content.mediaType !== "photo";
  const currentSource = isVideo && source?.key === `${active.chatId}:${active.id}` ? source : undefined;
  const videoRef = useRef<HTMLVideoElement>(null);
  const latest = useRef({ source: currentSource, onVideoState, onVideoAction });
  latest.current = { source: currentSource, onVideoState, onVideoAction };
  const phaseRef = useRef<VideoPhase>("preparing");
  const autoplayRef = useRef(true);
  const [phase, setPhase] = useState<VideoPhase>("preparing");
  const [failure, setFailure] = useState<VideoFailure>();
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(0.2);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [immersive, setImmersive] = useState(false);
  const [windowed, setWindowed] = useState(initiallyWindowed);
  const [modeError, setModeError] = useState(false);
  const [idle, setIdle] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [controlFocus, setControlFocus] = useState(false);
  const [activity, setActivity] = useState(0);
  const interact = useCallback(() => { setIdle(false); setActivity(performance.now()); }, []);

  useEffect(() => {
    setIdle(false);
    if (dragging || controlFocus || (!windowed && (!immersive || phase !== "playing"))) return;
    const timer = globalThis.setTimeout(() => setIdle(true), 2_000);
    return () => globalThis.clearTimeout(timer);
  }, [phase, dragging, controlFocus, activity, immersive, windowed]);

  const capture = (video: HTMLVideoElement, nextPhase = phaseRef.current): VideoState => ({
    currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : latest.current.source?.duration ?? 0,
    volume: video.volume, muted: video.muted, rate: video.playbackRate, phase: nextPhase, paused: video.paused,
  });
  const requestPlay = () => {
    const next = latest.current.source;
    if (next?.source) latest.current.onVideoAction(next, "play");
  };
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    interact();
    if (video.paused) requestPlay(); else video.pause();
  };
  const fail = (reason: VideoFailure) => {
    phaseRef.current = "failed";
    setPhase("failed"); setFailure(reason); setIdle(false);
    const video = videoRef.current;
    if (video) video.pause();
    logPerformance("media_playback_error", { mediaKind: 1, mediaErrorCode: video?.error?.code ?? 0,
      mediaNetworkState: video?.networkState, mediaReadyState: video?.readyState });
    const next = latest.current.source;
    if (video && next) latest.current.onVideoState(next, capture(video, "failed"));
  };

  useEffect(() => {
    const video = videoRef.current;
    const next = latest.current.source;
    setSize(undefined); setBuffered(0); setFailure(next?.failure);
    setCurrentTime(next?.currentTime ?? 0); setDuration(next?.duration ?? 0);
    setPhase(next?.phase ?? "preparing"); phaseRef.current = next?.phase ?? "preparing";
    if (!video || !next?.source) return;
    autoplayRef.current = next.autoplay;
    let alive = true;
    let firstFrame: number | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let bufferingAt: number | undefined;
    let seekAt: number | undefined;
    let lastStateAt = 0;
    const publish = (force = false) => {
      if (!alive || !force && performance.now() - lastStateAt < 500) return;
      lastStateAt = performance.now();
      latest.current.onVideoState(next, capture(video));
    };
    const settle = (nextPhase: VideoPhase) => {
      if (!alive || phaseRef.current === "failed" && nextPhase === "paused") return;
      phaseRef.current = nextPhase; setPhase(nextPhase); publish(true);
    };
    const clearStall = () => { clearTimeout(stallTimer); stallTimer = undefined; };
    const armStall = () => {
      if (stallTimer !== undefined) return;
      stallTimer = setTimeout(() => {
        stallTimer = undefined;
        if (alive && (video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)) fail("network");
      }, 20_000);
    };
    const wait = () => {
      if (phaseRef.current === "failed" || video.paused && !video.seeking) return;
      // A network stall can occur while already buffered frames keep playing.
      if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      if (bufferingAt === undefined) {
        bufferingAt = performance.now();
        logPerformance("media_buffering_started", { mediaKind: 1 });
      }
      settle(video.seeking ? "seeking" : "buffering");
      armStall();
    };
    const playing = () => {
      clearStall();
      if (bufferingAt !== undefined) {
        logPerformance("media_buffering_recovered", { mediaKind: 1, durationMs: performance.now() - bufferingAt });
        bufferingAt = undefined;
      }
      if (seekAt !== undefined) {
        logPerformance("media_seek_completed", { mediaKind: 1, durationMs: performance.now() - seekAt }); seekAt = undefined;
      }
      setFailure(undefined); settle("playing");
    };
    const metadata = () => {
      setDuration(video.duration); setSize({ width: video.videoWidth, height: video.videoHeight });
      if (next.currentTime > 0 && next.currentTime < video.duration) latest.current.onVideoAction(next, "seek", next.currentTime);
      if (autoplayRef.current) requestPlay(); else { clearStall(); settle("paused"); }
    };
    const progress = () => { setBuffered(bufferedMediaEnd(video)); };
    const time = () => { setCurrentTime(video.currentTime); progress(); publish(); };
    const pause = () => { clearStall(); settle(video.ended ? "ended" : "paused"); };
    const seek = () => { seekAt = performance.now(); settle("seeking"); wait(); };
    const seeked = () => {
      clearStall();
      if (video.paused && seekAt !== undefined) {
        logPerformance("media_seek_completed", { mediaKind: 1, durationMs: performance.now() - seekAt });
        seekAt = undefined;
      }
      if (video.paused) settle("paused");
      else if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) playing();
      else wait();
    };
    const canplay = () => {
      if (video.seeking) return;
      clearStall();
      if (video.paused) settle("paused"); else playing();
    };
    const output = () => { setVolume(video.volume); setMuted(video.muted); setRate(video.playbackRate); publish(true); };
    const error = () => fail(video.error?.code === 2 ? "network" : video.error?.code === 3 ? "decode" : video.error?.code === 4 ? "unsupported" : "source");
    const events: Record<string, EventListener> = {
      loadedmetadata: metadata, playing, pause, ended: pause, waiting: wait, stalled: wait,
      timeupdate: time, progress, seeking: seek, seeked, canplay, volumechange: output, ratechange: output, error,
    };
    Object.entries(events).forEach(([name, handler]) => video.addEventListener(name, handler));
    video.volume = next.volume; video.muted = next.muted; video.playbackRate = next.rate;
    setVolume(next.volume); setMuted(next.muted); setRate(next.rate);
    if (video.requestVideoFrameCallback) firstFrame = video.requestVideoFrameCallback(() => {
      if (alive) logPerformance("media_first_frame", { mediaKind: 1, durationMs: Math.max(0, Date.now() - next.openedAt), streaming: next.streaming });
    });
    video.src = next.source;
    video.load();
    armStall();
    const qualityTimer = setInterval(() => {
      if (video.paused || document.hidden) return;
      const quality = video.getVideoPlaybackQuality?.();
      if (quality) logPerformance("media_frame_quality", { mediaKind: 1, totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames });
    }, 5_000);
    return () => {
      alive = false; clearStall(); clearInterval(qualityTimer);
      if (firstFrame !== undefined) video.cancelVideoFrameCallback(firstFrame);
      Object.entries(events).forEach(([name, handler]) => video.removeEventListener(name, handler));
      latest.current.onVideoState(next, capture(video));
      video.pause(); video.removeAttribute("src"); video.load();
    };
  }, [currentSource?.revision, currentSource?.source, isVideo]);

  useEffect(() => {
    if (!command || command.revision !== currentSource?.revision) return;
    const video = videoRef.current;
    if (!video) return;
    if (command.command === "pause") { autoplayRef.current = false; video.pause(); }
    else if (command.command === "toggle") toggle();
    else if (command.command === "seek" && command.value !== undefined && Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, command.value));
    else if (command.command === "play") void video.play().catch(error => { if (error?.name !== "AbortError" && video === videoRef.current) fail("play"); });
  }, [command]);

  const seekTo = (value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const next = latest.current.source;
    if (!next) return;
    const position = Math.max(0, Math.min(video.duration, value));
    interact(); setCurrentTime(position); setPhase("seeking");
    latest.current.onVideoAction(next, "seek", position);
  };
  useEffect(() => {
    if (!isVideo) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey ||
          event.target instanceof HTMLElement && event.target.matches("input, select, textarea, button")) return;
      if (event.code === "Space") { event.preventDefault(); toggle(); }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); seekTo((videoRef.current?.currentTime ?? 0) + (event.key === "ArrowRight" ? 5 : -5));
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [isVideo]);

  const changeMode = async (next = !windowed) => {
    setModeError(false); interact();
    try {
      if (isTauri()) {
        const window = getCurrentWindow();
        if (next) {
          await window.setFullscreen(false);
          const target = videoWindowSize(size?.width || 640, size?.height || 360);
          await window.setSize(new LogicalSize(target.width, target.height));
        } else await window.setFullscreen(true);
      } else if (next) {
        globalThis.resizeTo?.(640, 360);
      } else globalThis.resizeTo?.(1280, 800);
      setWindowed(next); setImmersive(false);
    } catch { setModeError(true); }
  };
  useEffect(() => {
    if (modeRequest) void changeMode(modeRequest.windowed);
  }, [modeRequest]);
  useEffect(() => {
    if (!isVideo && windowed) void changeMode(false);
  }, [isVideo]);
  const retry = () => {
    const next = latest.current.source;
    if (!next) return;
    if (failure === "play") { setFailure(undefined); requestPlay(); }
    else latest.current.onVideoAction(next, "retry");
  };
  const displayedFailure = failure ?? currentSource?.failure;
  const controls = <div className="media-video-controls" onPointerDown={() => setControlFocus(false)}
    onFocus={event => setControlFocus(event.target.matches(":focus-visible"))}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlFocus(false); }}>
    <div className="media-video-timeline">
      <span>{formatPlaybackTime(currentTime)}</span>
      <input type="range" min={0} max={duration || active?.content.duration || 1} step={0.1} value={currentTime}
        aria-label={translate("视频进度")} aria-valuetext={`${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`}
        disabled={!currentSource?.source || !duration} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
        onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
        onChange={event => seekTo(Number(event.target.value))}
        style={{ backgroundSize: `${duration ? buffered / duration * 100 : 0}% 3px` }} />
      <span>{formatPlaybackTime(duration || active?.content.duration || 0)}</span>
    </div>
    <div className="media-video-buttons">
      <button type="button" onClick={toggle} disabled={!currentSource?.source} aria-label={phase === "playing" || phase === "buffering" ? translate("暂停") : translate("播放")}>
        {phase === "playing" || phase === "buffering" ? <Pause size={21} /> : <Play size={21} />}
      </button>
      <button type="button" aria-label={muted ? translate("取消静音") : translate("静音")} onClick={() => { if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }}>
        {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <input className="media-video-volume" type="range" aria-label={translate("音量")} min={0} max={1} step={0.01} value={volume}
        onChange={event => { if (videoRef.current) { videoRef.current.volume = Number(event.target.value); videoRef.current.muted = false; } }} />
      <button type="button" className="media-video-rate" aria-label={translate("播放速度")} onClick={() => { if (videoRef.current) videoRef.current.playbackRate = nextPlaybackRate(rate); }}>{rate}×</button>
      <span className="media-video-spacer" />
      {!windowed && <button type="button" aria-label={immersive ? translate("退出沉浸播放") : translate("沉浸播放")} onClick={() => { interact(); setImmersive(!immersive); }}>
        {immersive ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>}
      <button type="button" aria-label={windowed ? translate("返回媒体查看器") : translate("小窗播放")} onClick={() => void changeMode()}><PictureInPicture2 size={18} /></button>
      <button type="button" aria-label={translate("关闭")} onClick={viewer.onClose}><X size={20} /></button>
    </div>
    {modeError && <div role="alert">{translate("窗口模式切换失败")}</div>}
  </div>;

  // Reserve the video geometry before the smaller poster or source can load.
  const width = size?.width || active?.content.width || 640;
  const height = size?.height || active?.content.height || 360;

  return <MediaViewer {...viewer} video={isVideo ? {
    controls, immersive, windowed, idle, interact, ...size,
    startDragging: () => {
      interact();
      if (isTauri()) void getCurrentWindow().startDragging().catch(() => setModeError(true));
    },
    surface: <>
      <video key={currentSource?.revision ?? "preparing"} ref={videoRef} playsInline preload="metadata" className="media-viewer-video"
        width={width} height={height}
        style={{ width: `min(${width}px, 100cqw, ${width / height * 100}cqh)`, height: `min(${height}px, 100cqh, ${height / width * 100}cqw)` }}
        poster={localMediaSource(active.content.thumbnailPath) ?? active.content.previewDataUrl}
        aria-label={active.content.fileName} onClick={() => { if (!windowed) toggle(); }}
        onDoubleClick={() => { if (!windowed) { interact(); setImmersive(value => !value); } }} />
      {displayedFailure ? <div className="media-video-status" role="alert"><span>{failureText(displayedFailure)}</span>
        <button type="button" onClick={retry}><RotateCcw size={17} />{translate("重试加载")}</button></div> :
        (phase === "preparing" || phase === "buffering" || phase === "seeking") && <div className="media-video-loading" role="status"
          aria-label={phase === "preparing" ? translate("正在准备视频") : translate("视频正在缓冲")}>
          <LoaderCircle className="spin" size={36} strokeWidth={2} aria-hidden="true" />
        </div>}
    </>,
  } : undefined} />;
}
