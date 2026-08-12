import {
  AlertCircle,
  Download,
  LoaderCircle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import {
  audioPlaybackController,
  type AudioPlaybackHostControls,
  type AudioTrackDescriptor,
  useAudioPlayback,
} from "../media/audioPlayback";
import {
  formatPlaybackTime,
  mediaPlaybackCoordinator,
} from "../media/mediaPlayback";
import { AudioSpectrum } from "./AudioSpectrum";
import { MediaProgressRing } from "./MediaProgressRing";

function PersistentAudioEngine() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<AudioTrackDescriptor | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const lastRememberedSecondRef = useRef(0);
  const playbackRateRef = useRef(1);
  const streamingTrackIdRef = useRef<string | undefined>(undefined);
  const recoveryAttemptsRef = useRef(new Set<string>());
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | undefined>(undefined);
  const toggleRef = useRef<() => void>(() => undefined);

  const suspendTrackStream = (track?: AudioTrackDescriptor) => {
    if (!track || streamingTrackIdRef.current !== track.id) return;
    streamingTrackIdRef.current = undefined;
    track.onSuspendStream?.();
  };

  const ensureAudioGraph = async (audio: HTMLAudioElement) => {
    try {
      if (!audioContextRef.current) {
        const AudioContextClass = window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return;
        const context = new AudioContextClass();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.82;
        const source = context.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(context.destination);
        audioContextRef.current = context;
        mediaSourceRef.current = source;
        analyserRef.current = analyser;
        audioPlaybackController.setAnalyser(analyser);
      }
      if (
        audioContextRef.current.state !== "running" &&
        audioContextRef.current.state !== "closed"
      ) {
        await audioContextRef.current.resume();
      }
    } catch {
      audioPlaybackController.setAnalyser(undefined);
    }
  };

  const ensureAudioOutput = (audio: HTMLAudioElement) => {
    audio.defaultMuted = false;
    audio.muted = false;
    if (audio.volume === 0) audio.volume = 1;
    return ensureAudioGraph(audio);
  };

  const setSourceAndPlay = async (
    track: AudioTrackDescriptor,
    source: string,
    generation: number,
  ) => {
    const audio = audioRef.current;
    if (!audio || requestGenerationRef.current !== generation || trackRef.current?.id !== track.id) return;
    audio.crossOrigin = "anonymous";
    audio.dataset.playbackId = track.id;
    audio.src = source;
    audio.playbackRate = playbackRateRef.current;
    audio.load();
    await ensureAudioOutput(audio);
    if (requestGenerationRef.current !== generation || trackRef.current?.id !== track.id) return;
    await audio.play().catch(() => audioPlaybackController.update(track.id, {
      failed: true,
      loading: false,
      playing: false,
    }));
  };

  const play = async (track: AudioTrackDescriptor) => {
    const audio = audioRef.current;
    if (!audio) return;
    // Start Web Audio recovery inside the click call stack, before a remote
    // stream request can consume the browser's transient user activation.
    const audioOutputReady = ensureAudioOutput(audio);
    const current = trackRef.current;
    if (current?.id === track.id && audio.getAttribute("src")) {
      trackRef.current = track;
      audioPlaybackController.registerTrack(track);
      await audioOutputReady;
      await audio.play().catch(() => audioPlaybackController.update(track.id, { failed: true }));
      return;
    }

    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    if (current) {
      mediaPlaybackCoordinator.remember(current.id, audio.currentTime, audio.duration);
      audio.pause();
      mediaPlaybackCoordinator.release(audio);
      suspendTrackStream(current);
    }
    trackRef.current = track;
    lastRememberedSecondRef.current = 0;
    audio.removeAttribute("src");
    audio.load();
    audioPlaybackController.activate(track);

    let source = track.source;
    let streamed = false;
    if (!source && track.fileId !== undefined && track.size && track.size > 0) {
      audioPlaybackController.update(track.id, { loading: true });
      try {
        source = await track.onRequestStream(track.fileId, track.size, track.mimeType);
        streamed = Boolean(source);
      } catch {
        source = undefined;
      }
    }
    if (requestGenerationRef.current !== generation || trackRef.current?.id !== track.id) {
      if (streamed) track.onSuspendStream?.();
      return;
    }
    if (streamed) streamingTrackIdRef.current = track.id;
    audioPlaybackController.update(track.id, { loading: false });
    if (!source) {
      audioPlaybackController.update(track.id, { failed: true });
      return;
    }
    await audioOutputReady;
    await setSourceAndPlay(track, source, generation);
  };

  const toggle = () => {
    const audio = audioRef.current;
    const track = trackRef.current;
    if (!audio || !track) return;
    if (audio.paused) void play(track);
    else audio.pause();
  };
  toggleRef.current = toggle;

  const seek = (time: number) => {
    const audio = audioRef.current;
    const track = trackRef.current;
    if (!audio || !track || !Number.isFinite(time)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || time, time));
    audioPlaybackController.update(track.id, { currentTime: audio.currentTime });
  };

  const setPlaybackRate = (rate: number) => {
    playbackRateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
    const track = trackRef.current;
    if (track) audioPlaybackController.update(track.id, { playbackRate: rate });
  };

  const previous = () => {
    const audio = audioRef.current;
    const current = trackRef.current;
    const track = audioPlaybackController.track(current?.id) ?? current;
    if (!audio || !track) return;
    if (audio.currentTime > 3 || !track.previousId) {
      seek(0);
      return;
    }
    const previousTrack = audioPlaybackController.track(track.previousId);
    if (previousTrack) void play(previousTrack);
  };

  const next = () => {
    const current = trackRef.current;
    const track = audioPlaybackController.track(current?.id) ?? current;
    const nextTrack = audioPlaybackController.track(track?.nextId);
    if (nextTrack) void play(nextTrack);
  };

  const close = () => {
    const audio = audioRef.current;
    const track = trackRef.current;
    requestGenerationRef.current += 1;
    if (audio && track) {
      mediaPlaybackCoordinator.remember(track.id, audio.currentTime, audio.duration);
      audio.pause();
      mediaPlaybackCoordinator.release(audio);
      mediaPlaybackCoordinator.releaseKeyboardTarget(track.id, toggleRef.current);
      audio.removeAttribute("src");
      audio.load();
    }
    suspendTrackStream(track);
    trackRef.current = undefined;
    audioPlaybackController.clear(track?.id);
  };

  useEffect(() => {
    const controls: AudioPlaybackHostControls = {
      play: (track) => { void play(track); },
      toggle,
      seek,
      setPlaybackRate,
      previous,
      next,
      close,
    };
    return audioPlaybackController.attachHost(controls);
  });

  useEffect(() => () => {
    close();
    audioPlaybackController.setAnalyser(undefined);
    void audioContextRef.current?.close().catch(() => undefined);
  }, []);

  useEffect(() => {
    const resumeActiveOutput = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused && !audio.ended) void ensureAudioOutput(audio);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") resumeActiveOutput();
    };
    window.addEventListener("focus", resumeActiveOutput);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", resumeActiveOutput);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return (
    <audio
      ref={audioRef}
      className="persistent-audio-engine"
      crossOrigin="anonymous"
      preload="metadata"
      onLoadedMetadata={(event) => {
        const audio = event.currentTarget;
        const id = audio.dataset.playbackId;
        if (!id) return;
        const duration = Number.isFinite(audio.duration) ? audio.duration : trackRef.current?.durationHint ?? 0;
        const resume = mediaPlaybackCoordinator.resumePosition(id, duration);
        if (resume > 0) audio.currentTime = resume;
        audioPlaybackController.update(id, { duration, currentTime: resume });
      }}
      onPlay={(event) => {
        void ensureAudioOutput(event.currentTarget);
        const id = event.currentTarget.dataset.playbackId;
        if (!id) return;
        mediaPlaybackCoordinator.activate(id, event.currentTarget);
        mediaPlaybackCoordinator.claimKeyboardTarget(id, toggleRef.current);
        audioPlaybackController.update(id, { playing: true, loading: false, failed: false });
      }}
      onPlaying={(event) => {
        void ensureAudioOutput(event.currentTarget);
        const id = event.currentTarget.dataset.playbackId;
        if (id) audioPlaybackController.update(id, {
          playing: true,
          loading: false,
          failed: false,
        });
      }}
      onWaiting={(event) => {
        const id = event.currentTarget.dataset.playbackId;
        if (id) audioPlaybackController.update(id, { loading: true });
      }}
      onPause={(event) => {
        const audio = event.currentTarget;
        const id = audio.dataset.playbackId;
        if (!id) return;
        mediaPlaybackCoordinator.remember(id, audio.currentTime, audio.duration);
        mediaPlaybackCoordinator.release(audio);
        audioPlaybackController.update(id, { playing: false, loading: false });
      }}
      onTimeUpdate={(event) => {
        const audio = event.currentTarget;
        const id = audio.dataset.playbackId;
        if (!id) return;
        audioPlaybackController.update(id, { currentTime: audio.currentTime });
        const wholeSecond = Math.floor(audio.currentTime);
        if (wholeSecond - lastRememberedSecondRef.current >= 5) {
          lastRememberedSecondRef.current = wholeSecond;
          mediaPlaybackCoordinator.remember(id, audio.currentTime, audio.duration);
        }
      }}
      onDurationChange={(event) => {
        const audio = event.currentTarget;
        const id = audio.dataset.playbackId;
        if (id && Number.isFinite(audio.duration)) {
          audioPlaybackController.update(id, { duration: audio.duration });
        }
      }}
      onEnded={(event) => {
        const id = event.currentTarget.dataset.playbackId;
        if (!id) return;
        suspendTrackStream(trackRef.current);
        mediaPlaybackCoordinator.clear(id);
        mediaPlaybackCoordinator.release(event.currentTarget);
        audioPlaybackController.update(id, { playing: false, currentTime: 0 });
        next();
      }}
      onError={(event) => {
        const audio = event.currentTarget;
        if (!audio.getAttribute("src")) return;
        const id = audio.dataset.playbackId;
        if (!id) return;
        const track = trackRef.current;
        const recoveryKey = `${id}:${audio.currentSrc}`;
        if (
          track?.id === id && track.fileId !== undefined && track.onRecoverFile &&
          !recoveryAttemptsRef.current.has(recoveryKey)
        ) {
          recoveryAttemptsRef.current.add(recoveryKey);
          void track.onRecoverFile(track.fileId).then((recovered) => {
            if (!recovered || trackRef.current?.id !== id) return;
            const refreshed = audioPlaybackController.track(id);
            if (refreshed) trackRef.current = refreshed;
            audio.removeAttribute("src");
            audio.load();
            audioPlaybackController.update(id, { failed: false, loading: false, playing: false });
          });
        }
        audioPlaybackController.update(id, {
          failed: true,
          loading: false,
          playing: false,
        });
      }}
    />
  );
}

function AudioFloatingController() {
  const playback = useAudioPlayback();
  const track = playback.track;
  if (!track) return null;
  const hasPrevious = audioPlaybackController.hasTrack(track.previousId);
  const hasNext = audioPlaybackController.hasTrack(track.nextId);

  return (
    <aside className="audio-floating-controller" aria-label={`正在播放 ${track.label}`}>
      <header>
        <strong title={track.label}>{track.label}</strong>
        <button className="playback-rate" type="button" aria-label={`播放速度 ${playback.playbackRate} 倍`} title="切换播放速度" onClick={() => audioPlaybackController.cyclePlaybackRate()}>
          {playback.playbackRate}x
        </button>
        <button type="button" aria-label="关闭播放" title="关闭播放" onClick={() => audioPlaybackController.close()}>
          <X size={15} />
        </button>
      </header>
      <AudioSpectrum playbackId={track.id} playing={playback.playing} bars={40} className="is-floating" />
      <div className="audio-floating-progress">
        <input
          type="range"
          min={0}
          max={playback.duration || 0}
          step={0.1}
          value={Math.min(playback.currentTime, playback.duration || 0)}
          aria-label="播放进度"
          onChange={(event) => audioPlaybackController.seek(Number(event.currentTarget.value))}
        />
        <span>{formatPlaybackTime(playback.currentTime)} / {formatPlaybackTime(playback.duration)}</span>
      </div>
      <footer>
        <button type="button" disabled={!hasPrevious && playback.currentTime <= 0} aria-label="上一条音频" title="上一条音频" onClick={() => audioPlaybackController.previous()}>
          <SkipBack size={17} fill="currentColor" />
        </button>
        <button className="audio-floating-play" type="button" aria-label={playback.playing ? "暂停" : "播放"} title={playback.playing ? "暂停" : "播放"} onClick={() => audioPlaybackController.toggle()}>
          {playback.loading
            ? <LoaderCircle className="spin" size={20} />
            : playback.failed ? <AlertCircle size={20} />
              : playback.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <button type="button" disabled={!hasNext} aria-label="下一条音频" title="下一条音频" onClick={() => audioPlaybackController.next()}>
          <SkipForward size={17} fill="currentColor" />
        </button>
        {track.onCancelDownload ? (
          <button type="button" aria-label={`取消下载 ${track.label}`} title="取消下载" onClick={track.onCancelDownload}>
            <span className="audio-floating-transfer">
              <MediaProgressRing progress={track.downloadProgress} size={22} />
              <X size={11} />
            </span>
          </button>
        ) : (
          <button type="button" disabled={!track.onDownload} aria-label={`下载 ${track.label}`} title="下载音频" onClick={track.onDownload}>
            <Download size={16} />
          </button>
        )}
      </footer>
    </aside>
  );
}

export function AudioPlaybackHost() {
  return (
    <>
      <PersistentAudioEngine />
      <AudioFloatingController />
    </>
  );
}
