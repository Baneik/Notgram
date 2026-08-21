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
  colorTheme: "light" | "dark";
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
  `/video-window.html?id=${encodeURIComponent(id)}`
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

interface VideoPreviewWindowInput {
  source: string;
  label: string;
  width?: number;
  height?: number;
  duration?: number;
  colorTheme: VideoWindowDescriptor["colorTheme"];
}

interface VideoPreviewSession {
  id: string;
  channel: BroadcastChannel;
  descriptor: VideoWindowDescriptor;
  initializationTimer?: ReturnType<typeof globalThis.setTimeout>;
}

const VIDEO_PREVIEW_INITIALIZATION_TIMEOUT_MS = 8_000;
let activeVideoPreviewSession: VideoPreviewSession | undefined;

const disposeVideoPreviewSession = (session: VideoPreviewSession, requestClose: boolean) => {
  if (session.initializationTimer !== undefined) {
    globalThis.clearTimeout(session.initializationTimer);
    session.initializationTimer = undefined;
  }
  if (requestClose) {
    session.channel.postMessage({
      type: "command",
      id: session.id,
      command: "close",
    } satisfies VideoWindowMessage);
    void closePlaybackWindow(session.id).catch(() => undefined);
  }
  session.channel.close();
  if (activeVideoPreviewSession === session) activeVideoPreviewSession = undefined;
};

export const closeVideoPreviewWindow = (id: string) => {
  const session = activeVideoPreviewSession;
  if (!session || session.id !== id) return;
  disposeVideoPreviewSession(session, true);
};

export const openVideoPreviewWindow = async (input: VideoPreviewWindowInput) => {
  if (activeVideoPreviewSession) disposeVideoPreviewSession(activeVideoPreviewSession, true);

  const id = createVideoWindowId();
  const width = input.width && input.width > 0 ? input.width : 16;
  const height = input.height && input.height > 0 ? input.height : 9;
  const descriptor: VideoWindowDescriptor = {
    id,
    source: input.source,
    label: input.label,
    currentTime: 0,
    duration: input.duration ?? 0,
    volume: 0.2,
    muted: false,
    autoplay: true,
    mode: "fullscreen",
    fileName: input.label,
    downloadable: false,
    streaming: false,
    aspectRatio: width / height,
    colorTheme: input.colorTheme,
  };
  const channel = new BroadcastChannel(VIDEO_WINDOW_CHANNEL);
  const session: VideoPreviewSession = { id, channel, descriptor };
  activeVideoPreviewSession = session;
  let resolveInitialized: (() => void) | undefined;
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });

  channel.onmessage = (event: MessageEvent<VideoWindowMessage>) => {
    const message = event.data;
    if (!message || message.id !== id || activeVideoPreviewSession !== session) return;
    if (message.type === "ready") {
      channel.postMessage({ type: "init", id, descriptor } satisfies VideoWindowMessage);
      resolveInitialized?.();
      resolveInitialized = undefined;
    } else if (message.type === "closed") {
      disposeVideoPreviewSession(session, false);
    }
  };

  const initializationTimeout = new Promise<never>((_, reject) => {
    session.initializationTimer = globalThis.setTimeout(() => {
      reject(new Error("video preview window initialization timed out"));
    }, VIDEO_PREVIEW_INITIALIZATION_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        const created = await createPlaybackWindow(id, videoWindowSize(width, height), "fullscreen");
        if (!created) throw new Error("video preview popup was blocked");
        await initialized;
      })(),
      initializationTimeout,
    ]);
    if (session.initializationTimer !== undefined) {
      globalThis.clearTimeout(session.initializationTimer);
      session.initializationTimer = undefined;
    }
    return id;
  } catch {
    if (activeVideoPreviewSession === session) disposeVideoPreviewSession(session, true);
    return undefined;
  }
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
