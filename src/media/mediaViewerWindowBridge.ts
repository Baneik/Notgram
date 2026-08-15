import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PhotoMessage } from "../utils/mediaViewerModel";

export interface MediaViewerWindowDescriptor {
  id: string;
  messages: PhotoMessage[];
  activeMessageId: string;
  colorTheme: "light" | "dark";
}

export type MediaViewerWindowMessage =
  | { type: "ready"; id: string }
  | { type: "init"; id: string; descriptor: MediaViewerWindowDescriptor }
  | {
      type: "sync";
      id: string;
      messages: PhotoMessage[];
      colorTheme: MediaViewerWindowDescriptor["colorTheme"];
    }
  | { type: "download"; id: string; fileId: number; fileName: string }
  | { type: "closed"; id: string }
  | { type: "command"; id: string; command: "close" };

interface MediaViewerSession {
  id: string;
  channel: BroadcastChannel;
  descriptor: MediaViewerWindowDescriptor;
  initializationTimer?: ReturnType<typeof globalThis.setTimeout>;
}

export const MEDIA_VIEWER_WINDOW_CHANNEL = "notgram-media-viewer-window-v1";
const INITIALIZATION_TIMEOUT_MS = 8_000;
let activeSession: MediaViewerSession | undefined;

export const createMediaViewerWindowId = () => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

export const mediaViewerWindowRoute = (id: string) => (
  `/media-viewer-window.html?id=${encodeURIComponent(id)}`
);

export const createMediaViewerWindow = async (id: string) => {
  if (isTauri()) {
    await invoke("notgram_open_media_viewer_window", { id });
    return true;
  }
  return Boolean(globalThis.open(
    mediaViewerWindowRoute(id),
    `notgram-media-viewer-${id}`,
    "popup=yes,width=1280,height=800",
  ));
};

export const closeMediaViewerWindow = async (id: string) => {
  if (!isTauri()) return;
  await invoke("notgram_close_media_viewer_window", { id });
};

export const syncMediaViewerWindow = (
  messages: PhotoMessage[],
  colorTheme: MediaViewerWindowDescriptor["colorTheme"],
) => {
  const session = activeSession;
  if (!session || messages.length === 0) return;
  const sessionChatId = session.descriptor.messages[0]?.chatId;
  if (sessionChatId && messages[0]?.chatId !== sessionChatId) return;
  session.descriptor = { ...session.descriptor, messages, colorTheme };
  session.channel.postMessage({
    type: "sync",
    id: session.id,
    messages,
    colorTheme,
  } satisfies MediaViewerWindowMessage);
};

const disposeSession = (session: MediaViewerSession, requestClose: boolean) => {
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
  }
  session.channel.close();
  if (activeSession === session) activeSession = undefined;
};

export const openMediaViewerWindow = async (
  input: Omit<MediaViewerWindowDescriptor, "id">,
  onDownload: (fileId: number, fileName: string) => Promise<void>,
) => {
  if (activeSession) disposeSession(activeSession, true);

  const id = createMediaViewerWindowId();
  const descriptor: MediaViewerWindowDescriptor = { ...input, id };
  const channel = new BroadcastChannel(MEDIA_VIEWER_WINDOW_CHANNEL);
  const session: MediaViewerSession = { id, channel, descriptor };
  activeSession = session;
  let resolveInitialized: (() => void) | undefined;
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
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
      resolveInitialized?.();
      resolveInitialized = undefined;
    } else if (message.type === "download") {
      void onDownload(message.fileId, message.fileName);
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
      (async () => {
        const created = await createMediaViewerWindow(id);
        if (!created) throw new Error("media viewer popup was blocked");
        await initialized;
      })(),
      initializationTimeout,
    ]);
    if (session.initializationTimer !== undefined) {
      globalThis.clearTimeout(session.initializationTimer);
      session.initializationTimer = undefined;
    }
  } catch {
    if (activeSession === session) disposeSession(session, true);
  }
};
