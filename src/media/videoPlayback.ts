import type { ViewerMessage } from "../utils/mediaViewerModel";
import { localMediaSource } from "./localMediaSource";
import { mediaPlaybackCoordinator, readRememberedVideoVolume, rememberVideoVolume } from "./mediaPlayback";
import { updateMediaStreamPlayback } from "./mediaStream";

export type VideoPhase = "preparing" | "playing" | "paused" | "buffering" | "seeking" | "ended" | "failed";
export type VideoFailure = "source" | "network" | "decode" | "unsupported" | "play";

export interface VideoState {
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
  phase: VideoPhase;
  paused: boolean;
}

export interface VideoSource extends VideoState {
  openedAt: number;
  key: string;
  revision: number;
  source?: string;
  streaming: boolean;
  autoplay: boolean;
  failure?: VideoFailure;
}

export type VideoCommand = "play" | "pause" | "toggle" | "seek";
export type VideoAction = "play" | "retry" | "seek";
export interface VideoServices {
  getSource?: () => string | undefined;
  stream?: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  suspend?: (fileId: number, source?: string) => Promise<void>;
  recover?: (fileId: number, priority?: number) => Promise<boolean>;
}

type VideoSession = {
  fileId?: number;
  key: string;
  revision: number;
  active: boolean;
  loading: boolean;
  timer?: ReturnType<typeof globalThis.setTimeout>;
  leased: boolean;
  leasedSource?: string;
  desiredPlay: boolean;
  seekSequence: number;
  pendingSeek?: number;
  message: () => ViewerMessage;
  services: VideoServices;
  snapshot: VideoSource;
  publish: (source: VideoSource) => void;
  command: (command: VideoCommand, revision: number, value?: number) => void;
  remote: { pause: () => void };
  toggle: () => void;
};

/** The application owns acquisition and release; only the viewer owns a media element. */
export class VideoPlaybackController {
  private current?: VideoSession;
  private revision = 0;
  private readonly operations = new Map<number, Promise<void>>();

  private enqueue(fileId: number | undefined, operation: () => Promise<void>) {
    if (fileId === undefined) return operation();
    const result = (this.operations.get(fileId) ?? Promise.resolve()).then(operation);
    const pending = result.catch(() => undefined);
    this.operations.set(fileId, pending);
    void pending.then(() => {
      if (this.operations.get(fileId) === pending) this.operations.delete(fileId);
    });
    return result;
  }

  private async release(session: VideoSession) {
    const fileId = session.fileId;
    if (!session.leased || fileId === undefined) return;
    session.leased = false;
    await session.services.suspend?.(fileId, session.leasedSource);
    session.leasedSource = undefined;
  }

  close() {
    const session = this.current;
    if (!session) return;
    this.current = undefined;
    session.active = false;
    globalThis.clearTimeout(session.timer);
    session.command("pause", session.revision);
    mediaPlaybackCoordinator.release(session.remote);
    mediaPlaybackCoordinator.releaseKeyboardTarget(session.key, session.toggle);
    // Acquisition may still be pending. Its late result must be released before
    // another session of this file can acquire, including after a local upgrade.
    void this.enqueue(session.fileId, () => this.release(session)).catch(() => undefined);
  }

  open(message: () => ViewerMessage, services: VideoServices, publish: VideoSession["publish"], command: VideoSession["command"], openedAt = Date.now()) {
    this.close();
    const value = message();
    const key = `${value.chatId}:${value.id}`;
    const duration = value.content.duration ?? 0;
    const session: VideoSession = {
      key, fileId: value.content.fileId, revision: ++this.revision, active: true, loading: false, leased: false, desiredPlay: true, seekSequence: 0,
      message, services, publish, command,
      snapshot: {
        key, openedAt, revision: this.revision, duration, currentTime: mediaPlaybackCoordinator.resumePosition(key, duration),
        volume: readRememberedVideoVolume(), muted: false, rate: 1, phase: "preparing", paused: true,
        streaming: false, autoplay: true,
      },
      remote: { pause: () => {
        session.desiredPlay = false;
        session.snapshot = { ...session.snapshot, autoplay: false };
        command("pause", session.revision);
      } },
      toggle: () => command("toggle", session.revision),
    };
    this.current = session;
    // Claim during preparation too: later audio activation cancels pending autoplay.
    mediaPlaybackCoordinator.activate(key, session.remote);
    mediaPlaybackCoordinator.claimKeyboardTarget(key, session.toggle);
    this.load(session);
  }

  requestPlay(key: string, revision: number) {
    const session = this.current;
    if (!session || session.key !== key || session.revision !== revision) return;
    session.desiredPlay = true;
    mediaPlaybackCoordinator.activate(session.key, session.remote);
    mediaPlaybackCoordinator.claimKeyboardTarget(session.key, session.toggle);
    session.command("play", revision);
  }

  state(key: string, revision: number, state: VideoState) {
    const session = this.current;
    if (!session || session.key !== key || session.revision !== revision) return;
    session.snapshot = { ...session.snapshot, ...state };
    mediaPlaybackCoordinator.remember(key, state.currentTime, state.duration);
    rememberVideoVolume(state.volume);
    if (state.paused && state.phase !== "preparing") mediaPlaybackCoordinator.release(session.remote);
    if (session.pendingSeek !== undefined && Math.abs(state.currentTime - session.pendingSeek) < 0.5) session.pendingSeek = undefined;
    if (session.leased && session.pendingSeek === undefined) {
      void updateMediaStreamPlayback(session.fileId, state.currentTime, state.duration, state.paused, session.leasedSource).catch(() => undefined);
    }
  }

  async seek(key: string, revision: number, value: number) {
    const session = this.current;
    if (!session || session.key !== key || session.revision !== revision || !Number.isFinite(value)) return;
    const position = Math.max(0, Math.min(session.snapshot.duration || value, value));
    const sequence = ++session.seekSequence;
    session.pendingSeek = position;
    try {
      // Revoke old native requests before the media element can issue ranges at
      // its new position. A seeking event alone arrives too late for that order.
      if (session.leased) await updateMediaStreamPlayback(session.fileId, position, session.snapshot.duration, session.snapshot.paused, session.leasedSource, true);
      if (session.active && session.revision === revision && session.seekSequence === sequence) session.command("seek", revision, position);
    } catch {
      if (session.active && session.seekSequence === sequence) {
        session.pendingSeek = undefined;
        session.command("pause", revision);
        session.publish({ ...session.snapshot, phase: "failed", failure: "network" });
      }
    }
  }

  retry(key: string, revision: number) {
    const session = this.current;
    if (session?.key === key && session.revision === revision && !session.loading) this.load(session, true);
  }

  private load(session: VideoSession, retry = false) {
    const fileId = session.fileId;
    const failedLocal = retry && Boolean(session.snapshot.source) && !session.snapshot.streaming;
    session.loading = true;
    session.revision = ++this.revision;
    session.snapshot = { ...session.snapshot, openedAt: retry ? Date.now() : session.snapshot.openedAt, revision: session.revision, source: undefined, streaming: false, phase: "preparing", failure: undefined };
    session.publish(session.snapshot);
    let valid = true;
    const timer = globalThis.setTimeout(() => {
      valid = false;
      if (session.active && session.loading) {
        session.loading = false;
        session.snapshot = { ...session.snapshot, phase: "failed", failure: "network" };
        session.publish(session.snapshot);
      }
    }, 15_000);
    session.timer = timer;
    void this.enqueue(fileId, async () => {
      try {
        await this.release(session);
        if (!session.active || !valid) return;
        const recoverLocal = failedLocal && fileId !== undefined && Boolean(session.services.recover);
        if (recoverLocal && !await session.services.recover!(fileId!, 32)) throw new Error("Video recovery failed");
        if (!session.active || !valid) return;
        const content = session.message().content;
        // Store/window synchronization can lag recovery. Do not reopen the stale
        // local path that just failed; the fresh lease can read recovered bytes.
        let source = recoverLocal ? undefined : session.services.getSource?.() ?? localMediaSource(content.localPath);
        const streaming = !source;
        if (fileId !== undefined && content.size && session.services.stream) {
          // A downloaded file needs the same cache lease as a streamed file.
          // Keep the local URL for playback; registration only protects its lifetime.
          session.leasedSource = await session.services.stream(fileId, content.size, content.mimeType);
          session.leased = Boolean(session.leasedSource);
          source ??= session.leasedSource;
        }
        if (!session.active || !valid) { await this.release(session); return; }
        session.snapshot = { ...session.snapshot, source, streaming: streaming && session.leased, autoplay: session.desiredPlay,
          phase: source ? "preparing" : "failed", failure: source ? undefined : "source" };
      } catch {
        if (valid) session.snapshot = { ...session.snapshot, phase: "failed", failure: "source" };
      } finally {
        globalThis.clearTimeout(timer);
        if (session.timer === timer) session.timer = undefined;
        if (valid) {
          session.loading = false;
          if (session.active) session.publish(session.snapshot);
        }
      }
    }).catch(() => undefined);
  }
}

export const videoPlaybackController = new VideoPlaybackController();
