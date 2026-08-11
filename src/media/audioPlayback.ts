import { useSyncExternalStore } from "react";
import { nextPlaybackRate } from "./mediaPlayback";

export interface AudioTrackDescriptor {
  id: string;
  label: string;
  source?: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  durationHint?: number;
  previousId?: string;
  nextId?: string;
  downloadProgress?: number;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onRecoverFile?: (fileId: number) => Promise<boolean>;
  onSuspendStream?: () => void;
  onDownload?: () => void;
  onCancelDownload?: () => void;
}

export interface AudioPlaybackSnapshot {
  track?: AudioTrackDescriptor;
  playing: boolean;
  loading: boolean;
  failed: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
}

export interface AudioPlaybackHostControls {
  play: (track: AudioTrackDescriptor) => void;
  toggle: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  previous: () => void;
  next: () => void;
  close: () => void;
}

const EMPTY_SNAPSHOT: AudioPlaybackSnapshot = {
  playing: false,
  loading: false,
  failed: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
};

const MAX_TRACKS = 500;

export class AudioPlaybackController {
  private snapshot: AudioPlaybackSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly tracks = new Map<string, AudioTrackDescriptor>();
  private host?: AudioPlaybackHostControls;
  private analyser?: AnalyserNode;

  readonly getSnapshot = () => this.snapshot;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attachHost(host: AudioPlaybackHostControls) {
    this.host = host;
    return () => {
      if (this.host === host) this.host = undefined;
    };
  }

  registerTrack(track: AudioTrackDescriptor) {
    this.tracks.delete(track.id);
    this.tracks.set(track.id, track);
    if (this.snapshot.track?.id === track.id) this.patch({ track });
    this.trimTracks();
  }

  registerTracks(tracks: AudioTrackDescriptor[]) {
    for (const track of tracks) this.registerTrack(track);
  }

  track(id?: string) {
    return id ? this.tracks.get(id) : undefined;
  }

  hasTrack(id?: string) {
    return Boolean(id && this.tracks.has(id));
  }

  play(track: AudioTrackDescriptor) {
    this.registerTrack(track);
    this.host?.play(track);
  }

  playById(id?: string) {
    const track = this.track(id);
    if (!track) return false;
    this.host?.play(track);
    return Boolean(this.host);
  }

  toggle(track?: AudioTrackDescriptor) {
    if (track && this.snapshot.track?.id !== track.id) this.play(track);
    else this.host?.toggle();
  }

  seek(time: number) {
    this.host?.seek(time);
  }

  cyclePlaybackRate() {
    const rate = nextPlaybackRate(this.snapshot.playbackRate);
    this.host?.setPlaybackRate(rate);
  }

  previous() {
    this.host?.previous();
  }

  next() {
    this.host?.next();
  }

  close() {
    this.host?.close();
  }

  update(trackId: string, patch: Partial<Omit<AudioPlaybackSnapshot, "track">>) {
    if (this.snapshot.track?.id !== trackId) return;
    this.patch(patch);
  }

  activate(track: AudioTrackDescriptor) {
    this.registerTrack(track);
    this.patch({
      track,
      playing: false,
      loading: false,
      failed: false,
      currentTime: 0,
      duration: track.durationHint ?? 0,
    });
  }

  clear(trackId?: string) {
    if (trackId && this.snapshot.track?.id !== trackId) return;
    this.snapshot = { ...EMPTY_SNAPSHOT, playbackRate: this.snapshot.playbackRate };
    this.emit();
  }

  setAnalyser(analyser?: AnalyserNode) {
    this.analyser = analyser;
  }

  readSpectrum(target: Uint8Array<ArrayBuffer>) {
    if (!this.analyser) {
      target.fill(0);
      return false;
    }
    const raw = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(raw);
    const usefulBins = Math.max(target.length, Math.floor(raw.length * 0.38));
    for (let index = 0; index < target.length; index += 1) {
      const start = Math.floor(index / target.length * usefulBins);
      const end = Math.max(start + 1, Math.floor((index + 1) / target.length * usefulBins));
      let peak = 0;
      for (let bin = start; bin < end; bin += 1) peak = Math.max(peak, raw[bin] ?? 0);
      target[index] = peak;
    }
    return true;
  }

  private patch(patch: Partial<AudioPlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private trimTracks() {
    while (this.tracks.size > MAX_TRACKS) {
      const oldest = this.tracks.keys().next().value;
      if (!oldest) break;
      if (oldest === this.snapshot.track?.id) {
        const active = this.tracks.get(oldest)!;
        this.tracks.delete(oldest);
        this.tracks.set(oldest, active);
      } else {
        this.tracks.delete(oldest);
      }
    }
  }
}

export const audioPlaybackController = new AudioPlaybackController();

export const useAudioPlayback = () => useSyncExternalStore(
  audioPlaybackController.subscribe,
  audioPlaybackController.getSnapshot,
  audioPlaybackController.getSnapshot,
);
