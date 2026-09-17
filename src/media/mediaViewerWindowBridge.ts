import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ViewerMessage } from "../utils/mediaViewerModel";
import { photoThumbnailWindow } from "../utils/mediaViewerModel";
import { messageCanBeSaved } from "../telegram/messageLifecycle";
import { logPerformance } from "../utils/performanceMonitor";
import { videoPlaybackController, type VideoSource, type VideoState, type VideoCommand, type VideoServices, type VideoAction } from "./videoPlayback";
import { listen } from "@tauri-apps/api/event";

export interface MediaViewerWindowDescriptor {
  id: string;
  messages: ViewerMessage[];
  activeMessageId: string;
  colorTheme: "light" | "dark";
  allowSave?: boolean;
  mode?: "window" | "fullscreen";
}

export type MediaViewerWindowMessage =
  | { type: "ready"; id: string }
  | { type: "active"; id: string; messageId: string }
  | { type: "video-source"; id: string; source: VideoSource }
  | { type: "video-state"; id: string; key: string; revision: number; state: VideoState }
  | { type: "video-action"; id: string; key: string; revision: number; action: VideoAction; value?: number }
  | { type: "video-command"; id: string; command: VideoCommand; revision: number; value?: number }
  | { type: "init"; id: string; descriptor: MediaViewerWindowDescriptor }
  | {
      type: "sync";
      id: string;
      messages: ViewerMessage[];
      colorTheme: MediaViewerWindowDescriptor["colorTheme"];
    }
  | { type: "download"; id: string; fileId: number; fileName: string; requestId?: number }
  | { type: "save"; id: string; sourcePath: string; fileName: string; requestId?: number }
  | { type: "action-result"; id: string; requestId: number; failed: boolean }
  | { type: "closed"; id: string }
  | { type: "focus"; id: string; windowed: boolean }
  | { type: "command"; id: string; command: "close" };

interface MediaViewerSession {
  id: string;
  channel: BroadcastChannel;
  descriptor: MediaViewerWindowDescriptor;
  onClosed?: () => void;
  initializationTimer?: ReturnType<typeof globalThis.setTimeout>;
  cancelInitialization?: () => void;
  syncTimer?: ReturnType<typeof globalThis.setTimeout>;
  prefetchTimer?: ReturnType<typeof globalThis.setTimeout>;
  onCache?: (fileId: number, priority: number) => Promise<void>;
  requestedFiles: Map<number, number>;
  videoKey?: string;
  videoServices?: VideoServices;
  browser?: Window;
  cleanup?: () => void;
  openedAt: number;
  initialSelection: boolean;
}

export const MEDIA_VIEWER_WINDOW_CHANNEL = "notgram-media-viewer-window-v1";
const INITIALIZATION_TIMEOUT_MS = 8_000;
let activeSession: MediaViewerSession | undefined;

const cacheVisiblePhotos = (session: MediaViewerSession) => {
  if (!session.onCache || activeSession !== session) return;
  const { messages, activeMessageId } = session.descriptor;
  const request = (fileId: number, priority: number) => {
    if ((session.requestedFiles.get(fileId) ?? 0) >= priority) return;
    session.requestedFiles.set(fileId, priority);
    void session.onCache!(fileId, priority).catch(() => session.requestedFiles.delete(fileId));
  };
  const active = messages.find(message => message.id === activeMessageId);
  if (active?.content.mediaType === "photo" && messageCanBeSaved(active)) {
    const content = active.content;
    if (content.fileId !== undefined && content.canDownload !== false && !content.isDownloaded) request(content.fileId, 32);
  }
  for (const { content } of photoThumbnailWindow(messages, activeMessageId)) {
    if (content.thumbnailFileId !== undefined && content.thumbnailCanDownload && !content.thumbnailPath) request(content.thumbnailFileId, 8);
  }
};

const scheduleSync = (session: MediaViewerSession) => {
  if (session.syncTimer !== undefined) return;
  // File progress often updates several messages together. Transfer one latest
  // descriptor per batch instead of cloning the entire album for every update.
  session.syncTimer = globalThis.setTimeout(() => {
    session.syncTimer = undefined;
    if (activeSession !== session) return;
    session.channel.postMessage({ type: "sync", id: session.id, messages: session.descriptor.messages, colorTheme: session.descriptor.colorTheme } satisfies MediaViewerWindowMessage);
  }, 32);
};

export const createMediaViewerWindowId = () => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

export const mediaViewerWindowRoute = (id: string) => (
  `/windows/media-viewer-window.html?id=${encodeURIComponent(id)}`
);

export const createMediaViewerWindow = async (id: string, windowed = false) => {
  if (isTauri()) {
    await invoke("notgram_open_media_viewer_window", { id, windowed });
    return true;
  }
  const browser = globalThis.open(
    mediaViewerWindowRoute(id),
    `notgram-media-viewer-${id}`,
    windowed ? "popup=yes,width=640,height=460" : "popup=yes,width=1280,height=800",
  );
  if (activeSession?.id === id && browser) activeSession.browser = browser;
  return Boolean(browser);
};

export const closeMediaViewerWindow = async (id: string) => {
  if (!isTauri()) return;
  await invoke("notgram_close_media_viewer_window", { id });
};

export const syncMediaViewerWindow = (
  messages: ViewerMessage[],
  colorTheme: MediaViewerWindowDescriptor["colorTheme"],
) => {
  const session = activeSession;
  if (!session || messages.length === 0) return;
  const sessionChatId = session.descriptor.messages[0]?.chatId;
  if (sessionChatId) messages = messages.filter(message => message.chatId === sessionChatId);
  if (messages.length === 0) return;
  if (session.descriptor.messages === messages && session.descriptor.colorTheme === colorTheme) return;
  session.descriptor = { ...session.descriptor, messages, colorTheme };
  scheduleSync(session);
};

export const syncMediaViewerWindowSession = (
  id: string,
  messages: ViewerMessage[],
  colorTheme: MediaViewerWindowDescriptor["colorTheme"],
) => {
  const session = activeSession;
  if (!session || session.id !== id || messages.length === 0) return false;
  session.descriptor = { ...session.descriptor, messages, colorTheme };
  scheduleSync(session);
  return true;
};

const disposeSession = (session: MediaViewerSession, requestClose: boolean) => {
  if (activeSession !== session) return;
  videoPlaybackController.close();
  session.cleanup?.();
  session.cancelInitialization?.();
  if (session.syncTimer !== undefined) globalThis.clearTimeout(session.syncTimer);
  if (session.prefetchTimer !== undefined) globalThis.clearTimeout(session.prefetchTimer);
  if (session.initializationTimer !== undefined) {
    globalThis.clearTimeout(session.initializationTimer);
    session.initializationTimer = undefined;
  }
  if (requestClose) {
    session.channel.postMessage({
      type: "command",
      id: session.id,
      command: "close",
    } satisfies MediaViewerWindowMessage);
    void closeMediaViewerWindow(session.id).catch(() => undefined);
    session.browser?.close?.();
  }
  session.channel.close();
  if (activeSession === session) activeSession = undefined;
  session.onClosed?.();
};

export const closeMediaViewerWindowSession = (id: string) => {
  const session = activeSession;
  if (!session || session.id !== id) return;
  disposeSession(session, true);
};

export const closeActiveMediaViewerWindow = () => {
  if (activeSession) disposeSession(activeSession, true);
};

export const openMediaViewerWindow = async (
  input: Omit<MediaViewerWindowDescriptor, "id">,
  onDownload: (fileId: number, fileName: string) => Promise<void>,
  onSave: (sourcePath: string, fileName: string) => Promise<void>,
  onClosed?: () => void,
  onCache?: (fileId: number, priority: number) => Promise<void>,
  videoServices?: VideoServices,
) => {
  const existing = activeSession;
  const active = input.messages.find(message => message.id === input.activeMessageId);
  if (existing && active && existing.videoKey === `${active.chatId}:${active.id}`) {
    existing.onClosed = onClosed;
    existing.descriptor = { ...existing.descriptor, messages: input.messages, colorTheme: input.colorTheme };
    scheduleSync(existing);
    existing.channel.postMessage({ type: "focus", id: existing.id, windowed: input.mode === "window" } satisfies MediaViewerWindowMessage);
    existing.browser?.focus?.();
    return existing.id;
  }
  if (activeSession) disposeSession(activeSession, true);

  const id = createMediaViewerWindowId();
  const descriptor: MediaViewerWindowDescriptor = { ...input, id };
  const channel = new BroadcastChannel(MEDIA_VIEWER_WINDOW_CHANNEL);
  const startedAt = performance.now();
  const session: MediaViewerSession = { id, channel, descriptor, onClosed, onCache, videoServices, requestedFiles: new Map(), openedAt: Date.now(), initialSelection: true };
  activeSession = session;
  // Native destruction and browser handles cover exits where beforeunload or
  // the channel notification cannot run (including a crashed child WebView).
  if (isTauri()) {
    void listen<string>("notgram:media-viewer-closed", event => {
      if (event.payload === id) disposeSession(session, false);
    }).then(unlisten => {
      if (activeSession === session) session.cleanup = unlisten;
      else unlisten();
    });
  } else {
    const timer = globalThis.setInterval(() => {
      if (session.browser?.closed) disposeSession(session, false);
    }, 500);
    session.cleanup = () => globalThis.clearInterval(timer);
  }
  let resolveInitialized: (() => void) | undefined;
  const initialized = new Promise<void>((resolve, reject) => {
    resolveInitialized = resolve;
    session.cancelInitialization = () => reject(new Error("media viewer initialization cancelled"));
  });

  channel.onmessage = (event: MessageEvent<MediaViewerWindowMessage>) => {
    const message = event.data;
    if (!message || message.id !== id || activeSession !== session) return;
    if (message.type === "ready") {
      channel.postMessage({
        type: "init",
        id,
        descriptor: session.descriptor,
      } satisfies MediaViewerWindowMessage);
      if (resolveInitialized) logPerformance("ui_media_viewer_initialized", { durationMs: performance.now() - startedAt });
      resolveInitialized?.();
      resolveInitialized = undefined;
    } else if (message.type === "active") {
      if (!session.descriptor.messages.some(photo => photo.id === message.messageId)) return;
      const openedAt = session.initialSelection ? session.openedAt : Date.now();
      session.initialSelection = false;
      session.descriptor = { ...session.descriptor, activeMessageId: message.messageId };
      const active = session.descriptor.messages.find(item => item.id === message.messageId)!;
      const key = active.content.mediaType === "photo" ? undefined : `${active.chatId}:${active.id}`;
      if (session.videoKey !== key) {
        session.videoKey = key;
        videoPlaybackController.close();
        if (key) videoPlaybackController.open(
          () => session.descriptor.messages.find(item => item.id === active.id) ?? active,
          session.videoServices ?? {},
          source => { if (activeSession === session) channel.postMessage({ type: "video-source", id, source } satisfies MediaViewerWindowMessage); },
          (command, revision, value) => { if (activeSession === session) channel.postMessage({ type: "video-command", id, command, revision, value } satisfies MediaViewerWindowMessage); },
          openedAt,
        );
      }
      if (session.prefetchTimer !== undefined) globalThis.clearTimeout(session.prefetchTimer);
      session.prefetchTimer = globalThis.setTimeout(() => cacheVisiblePhotos(session), 100);
    } else if (message.type === "video-state") {
      videoPlaybackController.state(message.key, message.revision, message.state);
    } else if (message.type === "video-action") {
      if (message.action === "play") videoPlaybackController.requestPlay(message.key, message.revision);
      else if (message.action === "seek" && message.value !== undefined) void videoPlaybackController.seek(message.key, message.revision, message.value);
      else videoPlaybackController.retry(message.key, message.revision);
    } else if (message.type === "download" || message.type === "save") {
      const reply = (failed: boolean) => {
        if (activeSession === session && message.requestId !== undefined) channel.postMessage({ type: "action-result", id, requestId: message.requestId, failed } satisfies MediaViewerWindowMessage);
      };
      // Resolve actions in their owning window and report failures back to the
      // viewer, where the user is waiting, rather than dropping rejections.
      const action = Promise.resolve().then(() => message.type === "download" ? onDownload(message.fileId, message.fileName) : onSave(message.sourcePath, message.fileName));
      void action.then(() => reply(false), () => reply(true));
    } else if (message.type === "closed") {
      disposeSession(session, false);
    }
  };

  const initializationTimeout = new Promise<never>((_, reject) => {
    session.initializationTimer = globalThis.setTimeout(() => {
      reject(new Error("media viewer window initialization timed out"));
    }, INITIALIZATION_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.all([
        createMediaViewerWindow(id, input.mode === "window").then((created) => {
          if (!created) throw new Error("media viewer popup was blocked");
          // Native window creation can finish after an account switch or a
          // replacement viewer has already cancelled this opening request.
          if (activeSession !== session) {
            void closeMediaViewerWindow(id).catch(() => undefined);
            throw new Error("media viewer initialization cancelled");
          }
        }),
        initialized,
      ]),
      initializationTimeout,
    ]);
    session.cancelInitialization = undefined;
    if (session.initializationTimer !== undefined) {
      globalThis.clearTimeout(session.initializationTimer);
      session.initializationTimer = undefined;
    }
    return id;
  } catch {
    if (activeSession === session) disposeSession(session, true);
    return undefined;
  }
};
