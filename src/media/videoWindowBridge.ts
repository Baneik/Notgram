import { invoke, isTauri } from "@tauri-apps/api/core";

export type VideoWindowMode = "window" | "fullscreen";

export interface VideoWindowDescriptor {
  id: string;
  source: string;
  poster?: string;
  label: string;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  autoplay: boolean;
  mode: VideoWindowMode;
  fileId?: number;
  fileName?: string;
  downloadable?: boolean;
  streaming?: boolean;
  aspectRatio?: number;
}

export interface VideoWindowState {
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  fullscreen: boolean;
}

export type VideoWindowMessage =
  | { type: "ready"; id: string }
  | { type: "init"; id: string; descriptor: VideoWindowDescriptor }
  | { type: "state"; id: string; state: VideoWindowState }
  | { type: "closed"; id: string; state: VideoWindowState }
  | { type: "command"; id: string; command: "toggle" | "close" | "seek" | "download"; value?: number };

export const VIDEO_WINDOW_CHANNEL = "notgram-video-window-v1";
const VIDEO_WINDOW_REQUEST_EVENT = "notgram:open-video-window";

export const createVideoWindowId = () => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

export const videoWindowRoute = (id: string) => (
  `/?videoWindow=${encodeURIComponent(id)}`
);

export const videoWindowSize = (width: number, height: number) => {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 16;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 9;
  const scaleDown = Math.min(1, 960 / safeWidth, 720 / safeHeight);
  let targetWidth = safeWidth * scaleDown;
  let targetHeight = safeHeight * scaleDown;
  const scaleUp = Math.max(1, 320 / Math.max(targetWidth, targetHeight));
  targetWidth *= scaleUp;
  targetHeight *= scaleUp;
  return {
    width: Math.round(targetWidth),
    height: Math.round(targetHeight),
  };
};

export const createPlaybackWindow = async (
  id: string,
  size: { width: number; height: number },
  mode: VideoWindowMode,
) => {
  if (isTauri()) {
    await invoke("notgram_open_video_window", {
      id,
      width: size.width,
      height: size.height,
      fullscreen: mode === "fullscreen",
    });
    return true;
  }
  return Boolean(globalThis.open(
    videoWindowRoute(id),
    `notgram-video-${id}`,
    `popup=yes,width=${size.width},height=${size.height}`,
  ));
};

export const closePlaybackWindow = async (id: string) => {
  if (!isTauri()) return;
  await invoke("notgram_close_video_window", { id });
};

export const requestVideoWindowPlayback = (playbackId: string) => {
  globalThis.dispatchEvent(new CustomEvent(VIDEO_WINDOW_REQUEST_EVENT, {
    detail: { playbackId },
  }));
};

export const listenForVideoWindowRequest = (
  playbackId: string,
  listener: () => void,
) => {
  const handler = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.detail?.playbackId !== playbackId) return;
    listener();
  };
  globalThis.addEventListener(VIDEO_WINDOW_REQUEST_EVENT, handler);
  return () => globalThis.removeEventListener(VIDEO_WINDOW_REQUEST_EVENT, handler);
};
