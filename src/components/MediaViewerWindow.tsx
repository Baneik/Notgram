import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import {
  MEDIA_VIEWER_WINDOW_CHANNEL,
  type MediaViewerWindowDescriptor,
  type MediaViewerWindowMessage,
} from "../media/mediaViewerWindowBridge";
import { MediaViewer } from "./MediaViewer";
import { applyThemeToDocument, themeIdForColorTheme } from "../theme/theme";

const READY_RETRY_INTERVAL_MS = 250;

interface MediaViewerWindowProps {
  id: string;
}

export function MediaViewerWindow({ id }: MediaViewerWindowProps) {
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const closedRef = useRef(false);
  const [descriptor, setDescriptor] = useState<MediaViewerWindowDescriptor>();
  const [activeMessageId, setActiveMessageId] = useState<string>();

  const applyTheme = (colorTheme: MediaViewerWindowDescriptor["colorTheme"]) => {
    applyThemeToDocument(themeIdForColorTheme(colorTheme));
    if (isTauri()) void getCurrentWindow().setTheme(colorTheme).catch(() => undefined);
  };

  const closeWindow = async () => {
    if (closedRef.current) return;
    closedRef.current = true;
    channelRef.current?.postMessage({ type: "closed", id } satisfies MediaViewerWindowMessage);
    if (isTauri()) await getCurrentWindow().close();
    else globalThis.close();
  };

  useEffect(() => {
    document.documentElement.classList.add("media-viewer-window-page");
    document.body.classList.add("media-viewer-window-page");
    const channel = new BroadcastChannel(MEDIA_VIEWER_WINDOW_CHANNEL);
    channelRef.current = channel;
    let readyTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    const announceReady = () => {
      channel.postMessage({ type: "ready", id } satisfies MediaViewerWindowMessage);
    };
    channel.onmessage = (event: MessageEvent<MediaViewerWindowMessage>) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      if (message.type === "init") {
        if (readyTimer !== undefined) {
          globalThis.clearInterval(readyTimer);
          readyTimer = undefined;
        }
        closedRef.current = false;
        setDescriptor(message.descriptor);
        setActiveMessageId(message.descriptor.activeMessageId);
        applyTheme(message.descriptor.colorTheme);
      } else if (message.type === "sync") {
        setDescriptor((current) => current
          ? { ...current, messages: message.messages, colorTheme: message.colorTheme }
          : current);
        setActiveMessageId((current) => current && message.messages.some(({ id: messageId }) =>
          messageId === current)
          ? current
          : message.messages[0]?.id);
        applyTheme(message.colorTheme);
      } else if (message.type === "command" && message.command === "close") {
        void closeWindow();
      }
    };
    const handleBeforeUnload = () => {
      if (!closedRef.current) {
        channel.postMessage({ type: "closed", id } satisfies MediaViewerWindowMessage);
      }
    };
    announceReady();
    readyTimer = globalThis.setInterval(announceReady, READY_RETRY_INTERVAL_MS);
    globalThis.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      if (readyTimer !== undefined) globalThis.clearInterval(readyTimer);
      globalThis.removeEventListener("beforeunload", handleBeforeUnload);
      channel.close();
      channelRef.current = undefined;
      document.documentElement.classList.remove("media-viewer-window-page");
      document.documentElement.removeAttribute("data-theme");
      document.body.classList.remove("media-viewer-window-page");
    };
  }, [id]);

  if (!descriptor || !activeMessageId) {
    return <div className="media-viewer-window-loading" aria-label="正在准备图片查看器" />;
  }

  return (
    <MediaViewer
      messages={descriptor.messages}
      activeMessageId={activeMessageId}
      onActiveMessageChange={setActiveMessageId}
      onClose={() => void closeWindow()}
      onDownload={async (fileId, fileName) => {
        channelRef.current?.postMessage({
          type: "download",
          id,
          fileId,
          fileName,
        } satisfies MediaViewerWindowMessage);
      }}
    />
  );
}
