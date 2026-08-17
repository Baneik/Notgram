import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImageOff,
  LoaderCircle,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { usePreferencesStore } from "../store/preferencesStore";
import {
  adjacentPhotoId,
  type PhotoMessage,
} from "../utils/mediaViewerModel";
import { writeClipboardImage } from "../utils/clipboard";
import { MediaProgressRing } from "./MediaProgressRing";
import { StableImage } from "./StableImage";

interface MediaViewerProps {
  messages: PhotoMessage[];
  activeMessageId: string;
  onActiveMessageChange: (messageId: string) => void;
  onClose: () => void;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
}

const sourceFromPath = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

interface MediaViewerThumbnailProps {
  message: PhotoMessage;
  selected: boolean;
  onSelect: () => void;
}

const MediaViewerThumbnail = forwardRef<HTMLButtonElement, MediaViewerThumbnailProps>(function MediaViewerThumbnail({
  message,
  selected,
  onSelect,
}, ref) {
  const sources = useMemo(() => [
    sourceFromPath(message.content.localPath),
    sourceFromPath(message.content.thumbnailPath),
    message.content.previewDataUrl,
  ].filter((value): value is string => Boolean(value)), [
    message.content.localPath,
    message.content.thumbnailPath,
    message.content.previewDataUrl,
  ]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const source = sources[sourceIndex];

  useEffect(() => setSourceIndex(0), [sources]);

  return (
    <button
      ref={ref}
      className={selected ? "is-active" : undefined}
      type="button"
      aria-label={`查看 ${message.content.fileName}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      {source
        ? <StableImage
            src={source}
            alt=""
            loading="eager"
            decoding="async"
            onError={() => setSourceIndex((current) => current + 1)}
          />
        : <ImageOff size={18} strokeWidth={1.6} />}
      {message.content.isDownloading && (
        <span
          className="media-progress"
          role="progressbar"
          aria-label={`下载 ${message.content.fileName}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((message.content.progress ?? 0) * 100)}
        >
          <span><MediaProgressRing progress={message.content.progress} /></span>
        </span>
      )}
    </button>
  );
});

interface PanPosition {
  x: number;
  y: number;
}

export function MediaViewer({
  messages,
  activeMessageId,
  onActiveMessageChange,
  onClose,
  onDownload,
}: MediaViewerProps) {
  const active = messages.find((message) => message.id === activeMessageId);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState<PanPosition>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: PanPosition;
  } | undefined>(undefined);
  const [failedSource, setFailedSource] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const showDownloading = useStableVisibility(Boolean(active?.content.isDownloading), {
    minimumVisible: 320,
  });
  const activeThumbnailRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const previousId = adjacentPhotoId(messages, activeMessageId, -1);
  const nextId = adjacentPhotoId(messages, activeMessageId, 1);
  const source = useMemo(() => active
    ? sourceFromPath(active.content.localPath) ??
      sourceFromPath(active.content.thumbnailPath) ??
      active.content.previewDataUrl
    : undefined, [active]);
  const copyActive = useCallback(async () => {
    if (!source) return;
    await writeClipboardImage(source, active?.content.caption);
  }, [active?.content.caption, source]);

  useEffect(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    dragRef.current = undefined;
    setFailedSource(undefined);
    setRetryKey(0);
  }, [activeMessageId, source]);

  useEffect(() => {
    if (zoom === MIN_ZOOM) setPan({ x: 0, y: 0 });
  }, [zoom]);

  useEffect(() => {
    activeThumbnailRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeMessageId, reduceMotion]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && previousId) {
        event.preventDefault();
        onActiveMessageChange(previousId);
      } else if (event.key === "ArrowRight" && nextId) {
        event.preventDefault();
        onActiveMessageChange(nextId);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP));
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && source) {
        event.preventDefault();
        void copyActive();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [copyActive, nextId, onActiveMessageChange, previousId, source]);

  if (!active) return null;
  const content = active.content;
  const failed = Boolean(source && failedSource === source);
  const canDownload = content.fileId !== undefined &&
    content.canDownload !== false &&
    !content.isDownloading &&
    !content.isDownloaded;
  const updateZoom = (nextZoom: number) => {
    const normalized = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    setZoom(normalized);
  };
  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.ctrlKey) {
      updateZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      return;
    }
    const targetId = event.deltaY < 0 ? previousId : nextId;
    if (targetId) onActiveMessageChange(targetId);
  };
  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, .media-viewer-thumbnails")) return;
    const imageBounds = imageRef.current?.getBoundingClientRect();
    const insideImage = imageBounds && event.clientX >= imageBounds.left && event.clientX <= imageBounds.right &&
      event.clientY >= imageBounds.top && event.clientY <= imageBounds.bottom;
    if (!insideImage) {
      event.preventDefault();
      onClose();
      return;
    }
    if (zoom <= MIN_ZOOM) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pan,
    };
    setDragging(true);
  };
  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y + event.clientY - drag.startY,
    });
  };
  const finishDragging = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = undefined;
    setDragging(false);
  };

  return (
    <div
      className="media-viewer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="media-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`图片查看器：${content.fileName}`}
        tabIndex={-1}
      >
        <header className="media-viewer-toolbar">
          <span className="media-viewer-title">
            <strong>{content.fileName}</strong>
            <small>{messages.findIndex((message) => message.id === activeMessageId) + 1} / {messages.length}</small>
          </span>
          <div className="media-viewer-tools" role="toolbar" aria-label="图片缩放">
            <button type="button" aria-label="缩小" title="缩小" disabled={zoom <= MIN_ZOOM} onClick={() => updateZoom(zoom - ZOOM_STEP)}>
              <ZoomOut size={19} />
            </button>
            <span className="media-viewer-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="放大" title="放大" disabled={zoom >= MAX_ZOOM} onClick={() => updateZoom(zoom + ZOOM_STEP)}>
              <ZoomIn size={19} />
            </button>
            <button type="button" aria-label="重置缩放" title="重置缩放" disabled={zoom === MIN_ZOOM} onClick={() => updateZoom(MIN_ZOOM)}>
              <RotateCcw size={18} />
            </button>
            {source && (
              <button type="button" aria-label="复制图片" title="复制图片 (Ctrl+C)" onClick={() => void copyActive()}>
                <Copy size={18} />
              </button>
            )}
            {(canDownload || content.isDownloading) && (
              <button
                type="button"
                aria-label={content.isDownloading ? "原图下载中" : "下载原图"}
                title={content.isDownloading ? "原图下载中" : "下载原图"}
                disabled={content.isDownloading}
                onClick={() => void onDownload(content.fileId!, content.fileName)}
              >
                {content.isDownloading
                  ? <LoaderCircle className="spin" size={18} />
                  : <Download size={18} />}
              </button>
            )}
            <button type="button" aria-label="关闭图片查看器" title="关闭" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </header>

        <main
          className={`media-viewer-stage ${messages.length > 1 ? "has-thumbnails" : ""} ${zoom > MIN_ZOOM ? "is-pannable" : ""} ${dragging ? "is-dragging" : ""}`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
        >
          {source && !failed ? (
            <StableImage
              key={`${source}:${retryKey}`}
              ref={imageRef}
              className="media-viewer-image"
              src={source}
              alt={content.caption || content.fileName}
              draggable={false}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              onError={() => setFailedSource(source)}
            />
          ) : (
            <div className="media-viewer-empty" role="status">
              {showDownloading
                ? <LoaderCircle className="spin" size={34} />
                : <ImageOff size={38} strokeWidth={1.5} />}
              <span>{failed ? "图片加载失败" : showDownloading ? "图片正在下载" : "原图尚未下载"}</span>
              {failed && (
                <button type="button" onClick={() => {
                  setFailedSource(undefined);
                  setRetryKey((current) => current + 1);
                }}>重试加载</button>
              )}
              {canDownload && (
                <button type="button" onClick={() => void onDownload(content.fileId!, content.fileName)}>
                  <Download size={17} />
                  下载原图
                </button>
              )}
            </div>
          )}
          {previousId && (
            <button className="media-viewer-nav is-previous" type="button" aria-label="上一张" title="上一张" onClick={() => onActiveMessageChange(previousId)}>
              <ChevronLeft size={30} />
            </button>
          )}
          {nextId && (
            <button className="media-viewer-nav is-next" type="button" aria-label="下一张" title="下一张" onClick={() => onActiveMessageChange(nextId)}>
              <ChevronRight size={30} />
            </button>
          )}
          {messages.length > 1 && (
            <nav className="media-viewer-thumbnails" aria-label="会话图片预览">
              {messages.map((message) => (
                <MediaViewerThumbnail
                  ref={message.id === activeMessageId ? activeThumbnailRef : undefined}
                  key={message.id}
                  message={message}
                  selected={message.id === activeMessageId}
                  onSelect={() => onActiveMessageChange(message.id)}
                />
              ))}
            </nav>
          )}
        </main>

        {content.caption && (
          <footer className="media-viewer-caption">
            <span>{content.caption}</span>
          </footer>
        )}
      </div>
    </div>
  );
}
