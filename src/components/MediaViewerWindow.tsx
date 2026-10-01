import { translate } from "../i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_VIEWER_WINDOW_CHANNEL,
  type MediaViewerWindowDescriptor,
  type MediaViewerWindowMessage,
} from "../media/mediaViewerWindowBridge";
import { VideoPlaybackView } from "./VideoPlaybackView";
import type { VideoSource, VideoCommand } from "../media/videoPlayback";
import { applyThemeToDocument, themeIdForColorTheme } from "../theme/theme";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { clearViewerImages } from "../media/viewerImages";

const READY_RETRY_INTERVAL_MS = 250;

interface MediaViewerWindowProps {
  id: string;
}

export function MediaViewerWindow({ id }: MediaViewerWindowProps) {
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const closedRef = useRef(false);
  const initializedRef = useRef(false);
  const descriptorRef = useRef<MediaViewerWindowDescriptor | undefined>(undefined);
  const activeRef = useRef<string | undefined>(undefined);
  const previewUrl = useRef<string | undefined>(undefined);
  const descriptorRevision = useRef(-1);
  const requestSequence = useRef(0);
  const pendingActions = useRef(new Map<number, { resolve: () => void; reject: () => void }>());
  const [descriptor, setDescriptor] = useState<MediaViewerWindowDescriptor>();
  const [activeMessageId, setActiveMessageId] = useState<string>();
  const [videoSource, setVideoSource] = useState<VideoSource>();
  const [videoCommand, setVideoCommand] = useState<{ command: VideoCommand; revision: number; sequence: number; value?: number }>();
  const [modeRequest, setModeRequest] = useState<{ windowed: boolean; sequence: number }>();
  const [parked, setParked] = useState(false);
  const [preparedPreview, setPreparedPreview] = useState<{ sourcePath: string; url: string }>();
  const showRequest = useRef<{ revision: number; timer?: ReturnType<typeof setTimeout>; frame?: number } | undefined>(undefined);
  const showPreparing = useStableVisibility(!descriptor || !activeMessageId);

  const applyTheme = (colorTheme: MediaViewerWindowDescriptor["colorTheme"]) => {
    applyThemeToDocument(themeIdForColorTheme(colorTheme));
    if (isTauri()) void getCurrentWindow().setTheme(colorTheme).catch(() => undefined);
  };

  const closeWindow = async () => {
    if (closedRef.current) return;
    closedRef.current = true;
    const current = descriptorRef.current;
    const active = current?.messages.find(message => message.id === activeRef.current);
    if (isTauri() && current?.reusable && active?.content.mediaType === "photo") {
      try {
        await getCurrentWindow().hide();
        setParked(true);
        setDescriptor(undefined);
        descriptorRef.current = undefined;
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = undefined;
        setPreparedPreview(undefined);
        for (const pending of pendingActions.current.values()) pending.resolve();
        pendingActions.current.clear();
        channelRef.current?.postMessage({ type: "parked", id, revision: current.revision ?? 0 } satisfies MediaViewerWindowMessage);
        return;
      } catch { /* A failed hide falls back to destroying the child. */ }
    }
    clearViewerImages();
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
    const applyDescriptor = (next: MediaViewerWindowDescriptor) => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = next.preparedPreview ? URL.createObjectURL(next.preparedPreview.blob) : undefined;
      setPreparedPreview(next.preparedPreview && previewUrl.current
        ? { sourcePath: next.preparedPreview.sourcePath, url: previewUrl.current } : undefined);
      descriptorRef.current = next;
      descriptorRevision.current = next.revision ?? 0;
      activeRef.current = next.activeMessageId;
      closedRef.current = false;
      setParked(false);
      setDescriptor(next);
      setActiveMessageId(next.activeMessageId);
      setVideoSource(undefined);
      setVideoCommand(undefined);
      setModeRequest(undefined);
      applyTheme(next.colorTheme);
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
        applyDescriptor(message.descriptor);
      } else if (message.type === "reopen" && initializedRef.current &&
          (message.descriptor.revision ?? 0) > descriptorRevision.current) {
        applyDescriptor(message.descriptor);
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
        closedRef.current = true;
        clearViewerImages();
        if (isTauri()) void getCurrentWindow().close();
        else globalThis.close();
      } else if (message.type === "action-result") {
        const pending = pendingActions.current.get(message.requestId);
        pendingActions.current.delete(message.requestId);
        if (message.failed) pending?.reject();
        else pending?.resolve();
      } else if (message.type === "video-source") {
        setVideoSource(message.source);
      } else if (message.type === "video-command") {
        setVideoCommand(current => ({ command: message.command, revision: message.revision, value: message.value, sequence: (current?.sequence ?? 0) + 1 }));
      } else if (message.type === "focus") {
        setModeRequest(current => ({ windowed: message.windowed, sequence: (current?.sequence ?? 0) + 1 }));
        if (isTauri()) void getCurrentWindow().setFocus().catch(() => undefined);
        else globalThis.focus();
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
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = undefined;
      document.documentElement.classList.remove("media-viewer-window-page");
      document.documentElement.removeAttribute("data-theme");
      document.body.classList.remove("media-viewer-window-page");
    };
  }, [id]);

  const changeActiveMessage = useCallback((messageId: string) => {
    activeRef.current = messageId;
    setActiveMessageId(messageId);
  }, []);
  useEffect(() => {
    if (activeMessageId && !parked) channelRef.current?.postMessage({ type: "active", id, messageId: activeMessageId } satisfies MediaViewerWindowMessage);
  }, [activeMessageId, id, parked]);

  useEffect(() => { descriptorRef.current = descriptor; activeRef.current = activeMessageId; }, [descriptor, activeMessageId]);

  const revealWindow = useCallback(() => {
    const current = descriptorRef.current;
    if (!isTauri() || !current || closedRef.current) return;
    const revision = current.revision ?? 0;
    if (showRequest.current?.revision === revision) return;
    const request: NonNullable<typeof showRequest.current> = { revision };
    showRequest.current = request;
    const show = () => {
      const latest = descriptorRef.current;
      if (showRequest.current !== request || closedRef.current || !latest || (latest.revision ?? 0) !== revision) return;
      clearTimeout(request.timer);
      if (request.frame !== undefined) cancelAnimationFrame(request.frame);
      void invoke("notgram_show_media_viewer_window", { id, windowed: latest.mode === "window" }).catch(() => undefined);
    };
    request.frame = requestAnimationFrame(show);
    // Hidden WebViews may throttle animation frames. A ready DOM must still open.
    request.timer = setTimeout(show, 32);
  }, [id]);

  useEffect(() => {
    if (!descriptor || parked || !isTauri()) return;
    // Missing/error sources and slow originals still expose actionable viewer chrome.
    const timer = setTimeout(revealWindow, 120);
    return () => clearTimeout(timer);
  }, [Boolean(descriptor), descriptor?.revision, parked, revealWindow]);

  useEffect(() => () => {
    clearTimeout(showRequest.current?.timer);
    if (showRequest.current?.frame !== undefined) cancelAnimationFrame(showRequest.current.frame);
  }, []);

  const runAction = (action: { type: "save"; sourcePath: string; fileName: string } | { type: "download"; fileId: number; fileName: string }) => new Promise<void>((resolve, reject) => {
    const requestId = ++requestSequence.current;
    pendingActions.current.set(requestId, { resolve, reject: () => reject(new Error("media viewer file action failed")) });
    channelRef.current?.postMessage({ ...action, id, requestId } satisfies MediaViewerWindowMessage);
  });

  if (parked) return null;
  if (!descriptor || !activeMessageId) {
    return <div className="media-viewer-window-loading" aria-label={translate("正在准备图片查看器")}>
      {showPreparing ? <LoaderCircle className="spin" size={28} /> : null}
    </div>;
  }

  return (
    <VideoPlaybackView
      messages={descriptor.messages}
      activeMessageId={activeMessageId}
      onActiveMessageChange={changeActiveMessage}
      onClose={() => void closeWindow()}
      allowSave={descriptor.allowSave}
      preparedPreview={preparedPreview}
      onPhotoReady={revealWindow}
      onDownload={(fileId, fileName) => runAction({ type: "download", fileId, fileName })}
      onSave={(sourcePath, fileName) => runAction({ type: "save", sourcePath, fileName })}
      source={videoSource}
      command={videoCommand}
      initiallyWindowed={descriptor.mode === "window"}
      modeRequest={modeRequest}
      onVideoState={(source, state) => channelRef.current?.postMessage({ type: "video-state", id, key: source.key, revision: source.revision, state } satisfies MediaViewerWindowMessage)}
      onVideoAction={(source, action, value) => channelRef.current?.postMessage({ type: "video-action", id, key: source.key, revision: source.revision, action, value } satisfies MediaViewerWindowMessage)}
    />
  );
}
