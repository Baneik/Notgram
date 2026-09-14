import { translate } from "../i18n";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_VIEWER_WINDOW_CHANNEL,
  type MediaViewerWindowDescriptor,
  type MediaViewerWindowMessage,
} from "../media/mediaViewerWindowBridge";
import { MediaViewer } from "./MediaViewer";
import { applyThemeToDocument, themeIdForColorTheme } from "../theme/theme";
import { useStableVisibility } from "../hooks/useStableVisibility";

const READY_RETRY_INTERVAL_MS = 250;

interface MediaViewerWindowProps {
  id: string;
}

export function MediaViewerWindow({ id }: MediaViewerWindowProps) {
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const closedRef = useRef(false);
  const initializedRef = useRef(false);
  const requestSequence = useRef(0);
  const pendingActions = useRef(new Map<number, { resolve: () => void; reject: () => void }>());
  const [descriptor, setDescriptor] = useState<MediaViewerWindowDescriptor>();
  const [activeMessageId, setActiveMessageId] = useState<string>();
  const showPreparing = useStableVisibility(!descriptor || !activeMessageId);

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
        // Ready retries (including StrictMode setup) can produce late duplicate
        // init messages. They must not reset navigation or newer file state.
        if (initializedRef.current) return;
        initializedRef.current = true;
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
      } else if (message.type === "action-result") {
        const pending = pendingActions.current.get(message.requestId);
        pendingActions.current.delete(message.requestId);
        if (message.failed) pending?.reject();
        else pending?.resolve();
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
      for (const pending of pendingActions.current.values()) pending.resolve();
      pendingActions.current.clear();
      document.documentElement.classList.remove("media-viewer-window-page");
      document.documentElement.removeAttribute("data-theme");
      document.body.classList.remove("media-viewer-window-page");
    };
  }, [id]);

  const changeActiveMessage = useCallback((messageId: string) => {
    setActiveMessageId(messageId);
  }, []);
  useEffect(() => {
    if (activeMessageId) channelRef.current?.postMessage({ type: "active", id, messageId: activeMessageId } satisfies MediaViewerWindowMessage);
  }, [activeMessageId, id]);

  const runAction = (action: { type: "save"; sourcePath: string; fileName: string } | { type: "download"; fileId: number; fileName: string }) => new Promise<void>((resolve, reject) => {
    const requestId = ++requestSequence.current;
    pendingActions.current.set(requestId, { resolve, reject: () => reject(new Error("media viewer file action failed")) });
    channelRef.current?.postMessage({ ...action, id, requestId } satisfies MediaViewerWindowMessage);
  });

  if (!descriptor || !activeMessageId) {
    return <div className="media-viewer-window-loading" aria-label={translate("正在准备图片查看器")}>
      {showPreparing ? <LoaderCircle className="spin" size={28} /> : null}
    </div>;
  }

  return (
    <MediaViewer
      messages={descriptor.messages}
      activeMessageId={activeMessageId}
      onActiveMessageChange={changeActiveMessage}
      onClose={() => void closeWindow()}
      allowSave={descriptor.allowSave}
      onDownload={(fileId, fileName) => runAction({ type: "download", fileId, fileName })}
      onSave={(sourcePath, fileName) => runAction({ type: "save", sourcePath, fileName })}
    />
  );
}
