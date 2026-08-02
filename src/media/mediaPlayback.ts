export interface CoordinatedMedia {
  pause: () => void;
}

const MAX_RESUME_ENTRIES = 200;
const MIN_RESUME_SECONDS = 2;
const END_THRESHOLD_SECONDS = 5;
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

export class MediaPlaybackCoordinator {
  private active?: { id: string; media: CoordinatedMedia };
  private readonly resumePositions = new Map<string, number>();

  activate(id: string, media: CoordinatedMedia) {
    if (this.active?.media !== media) this.active?.media.pause();
    this.active = { id, media };
  }

  release(media: CoordinatedMedia) {
    if (this.active?.media === media) this.active = undefined;
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

export const mediaPlaybackCoordinator = new MediaPlaybackCoordinator();
