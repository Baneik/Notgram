export interface CoordinatedMedia {
  pause: () => void;
}

const MAX_RESUME_ENTRIES = 200;
const MIN_RESUME_SECONDS = 2;
const END_THRESHOLD_SECONDS = 5;
const VIDEO_VOLUME_STORAGE_KEY = "notgram.video.volume";
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export const STREAM_PAUSE_BUFFER_SECONDS = 15;
export const DEFAULT_VIDEO_VOLUME = 0.2;

export const normalizeVideoVolume = (volume: number) => (
  Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_VIDEO_VOLUME
);

export const readRememberedVideoVolume = () => {
  try {
    const stored = globalThis.localStorage?.getItem(VIDEO_VOLUME_STORAGE_KEY);
    return stored === null || stored === undefined
      ? DEFAULT_VIDEO_VOLUME
      : normalizeVideoVolume(Number(stored));
  } catch {
    return DEFAULT_VIDEO_VOLUME;
  }
};

export const rememberVideoVolume = (volume: number) => {
  const normalized = normalizeVideoVolume(volume);
  try {
    globalThis.localStorage?.setItem(VIDEO_VOLUME_STORAGE_KEY, String(normalized));
  } catch {
    // A blocked preference store should not affect video playback.
  }
  return normalized;
};

export class MediaPlaybackCoordinator {
  private active?: { id: string; media: CoordinatedMedia };
  private keyboardTarget?: { id: string; toggle: () => void };
  private readonly resumePositions = new Map<string, number>();

  activate(id: string, media: CoordinatedMedia) {
    if (this.active?.media !== media) this.active?.media.pause();
    this.active = { id, media };
  }

  release(media: CoordinatedMedia) {
    if (this.active?.media === media) this.active = undefined;
  }

  claimKeyboardTarget(id: string, toggle: () => void) {
    this.keyboardTarget = { id, toggle };
  }

  releaseKeyboardTarget(id: string, toggle: () => void) {
    if (this.keyboardTarget?.id === id && this.keyboardTarget.toggle === toggle) {
      this.keyboardTarget = undefined;
    }
  }

  toggleKeyboardTarget() {
    if (!this.keyboardTarget) return false;
    this.keyboardTarget.toggle();
    return true;
  }

  remember(id: string, currentTime: number, duration: number) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return;
    if (currentTime < MIN_RESUME_SECONDS || currentTime >= duration - END_THRESHOLD_SECONDS) {
      this.resumePositions.delete(id);
      return;
    }
    this.resumePositions.delete(id);
    this.resumePositions.set(id, currentTime);
    while (this.resumePositions.size > MAX_RESUME_ENTRIES) {
      const oldest = this.resumePositions.keys().next().value;
      if (oldest === undefined) break;
      this.resumePositions.delete(oldest);
    }
  }

  resumePosition(id: string, duration: number) {
    const position = this.resumePositions.get(id);
    return position !== undefined && Number.isFinite(duration) &&
      position >= MIN_RESUME_SECONDS && position < duration - END_THRESHOLD_SECONDS
      ? position
      : 0;
  }

  clear(id: string) {
    this.resumePositions.delete(id);
  }
}

export const nextPlaybackRate = (current: number) => {
  const index = PLAYBACK_RATES.findIndex((rate) => rate === current);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? PLAYBACK_RATES[0];
};

export const formatPlaybackTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
};

export const bufferedSecondsAhead = (
  media: Pick<HTMLMediaElement, "buffered" | "currentTime">,
) => {
  for (let index = 0; index < media.buffered.length; index += 1) {
    const start = media.buffered.start(index);
    const end = media.buffered.end(index);
    if (media.currentTime >= start && media.currentTime <= end) {
      return Math.max(0, end - media.currentTime);
    }
  }
  return 0;
};

export const mediaPlaybackCoordinator = new MediaPlaybackCoordinator();
