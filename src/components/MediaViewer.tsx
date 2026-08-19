import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  LoaderCircle,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { usePreferencesStore } from "../store/preferencesStore";
import {
  adjacentPhotoId,
  type PhotoMessage,
} from "../utils/mediaViewerModel";
import { MediaProgressRing } from "./MediaProgressRing";
import { StableImage } from "./StableImage";

interface MediaViewerProps {
  messages: PhotoMessage[];
  activeMessageId: string;
  onActiveMessageChange: (messageId: string) => void;
  onClose: () => void;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onSave: (sourcePath: string, fileName: string) => Promise<void>;
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
  onSave,
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
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [nextId, onActiveMessageChange, previousId]);

  if (!active) return null;
  const content = active.content;
  const failed = Boolean(source && failedSource === source);
  const canDownload = content.fileId !== undefined &&
    content.canDownload !== false &&
    !content.isDownloading &&
    !content.isDownloaded;
  const canSave = Boolean(content.localPath);
  const downloadUnavailable = !canSave && !canDownload && !content.isDownloading;
  const activeIndex = messages.findIndex((message) => message.id === activeMessageId);
  const imageDetails = [
    `序号：${activeIndex + 1} / ${messages.length}`,
    `数据中心：${content.dataCenterId ? `DC${content.dataCenterId}` : "Telegram 自动选择"}`,
    `尺寸：${content.width && content.height ? `${content.width} × ${content.height}` : "未知"}`,
    `大小：${content.sizeLabel}`,
  ];
  const handleDownload = () => {
    if (content.localPath) return onSave(content.localPath, content.fileName);
    if (canDownload) return onDownload(content.fileId!, content.fileName);
    return Promise.resolve();
  };
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
    if (target instanceof Element && target.closest("button, .media-viewer-thumbnails, .media-viewer-caption, .media-viewer-details")) return;
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
          </span>
          <div className="media-viewer-tools" role="toolbar" aria-label="图片操作">
            <button
              type="button"
              aria-label="下载图片"
              aria-busy={content.isDownloading || undefined}
              title={content.isDownloading ? "原图下载中" : canSave ? "另存图片" : "下载原图"}
              disabled={content.isDownloading || downloadUnavailable}
              onClick={() => void handleDownload()}
            >
              {content.isDownloading
                ? <LoaderCircle className="spin" size={18} />
                : <Download size={18} />}
            </button>
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
          <aside className="media-viewer-details" aria-label="图片详细信息">
            {imageDetails.map((detail) => <span key={detail}>{detail}</span>)}
          </aside>
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
          {content.caption && (
            <p
              className="media-viewer-caption"
              aria-live="polite"
              onWheel={(event) => event.stopPropagation()}
            >{content.caption}</p>
          )}
        </main>
      </div>
    </div>
  );
}
