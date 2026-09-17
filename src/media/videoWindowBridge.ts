import { createMediaViewerWindowId, openMediaViewerWindow, closeMediaViewerWindowSession } from "./mediaViewerWindowBridge";

const VIDEO_WINDOW_REQUEST_EVENT = "notgram:open-video-window";
export const videoWindowRoute = (id: string) => `/windows/video-window.html?id=${encodeURIComponent(id)}`;

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


export const openVideoPreviewWindow = (input: {
  source: string; label: string; width?: number; height?: number; duration?: number; colorTheme: "light" | "dark";
}, onClosed?: () => void) => {
  const id = createMediaViewerWindowId();
  return openMediaViewerWindow({
    messages: [{ id, chatId: "attachment-video", senderId: "self", outgoing: true, sentAt: "", delivery: "read",
      content: { kind: "media", mediaType: "video", fileName: input.label, sizeLabel: "",
        width: input.width, height: input.height, duration: input.duration } }],
    activeMessageId: id, colorTheme: input.colorTheme, allowSave: false,
  }, async () => undefined, async () => undefined, onClosed, undefined, { getSource: () => input.source });
};

export const closeVideoPreviewWindow = closeMediaViewerWindowSession;

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
