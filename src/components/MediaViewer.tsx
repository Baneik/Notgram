import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  LoaderCircle,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import {
  adjacentPhotoId,
  type PhotoMessage,
} from "../utils/mediaViewerModel";

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

export function MediaViewer({
  messages,
  activeMessageId,
  onActiveMessageChange,
  onClose,
  onDownload,
}: MediaViewerProps) {
  const active = messages.find((message) => message.id === activeMessageId);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [failedSource, setFailedSource] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
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
    setFailedSource(undefined);
    setRetryKey(0);
  }, [activeMessageId, source]);

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
            <button type="button" aria-label="缩小" title="缩小" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))}>
              <ZoomOut size={19} />
            </button>
            <span className="media-viewer-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="放大" title="放大" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))}>
              <ZoomIn size={19} />
            </button>
            <button type="button" aria-label="重置缩放" title="重置缩放" disabled={zoom === MIN_ZOOM} onClick={() => setZoom(MIN_ZOOM)}>
              <RotateCcw size={18} />
            </button>
            <button type="button" aria-label="关闭图片查看器" title="关闭" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </header>

        <main className="media-viewer-stage">
          {source && !failed ? (
            <img
              key={`${source}:${retryKey}`}
              className="media-viewer-image"
              src={source}
              alt={content.caption || content.fileName}
              style={{ transform: `scale(${zoom})` }}
              onError={() => setFailedSource(source)}
            />
          ) : (
            <div className="media-viewer-empty" role="status">
              {content.isDownloading
                ? <LoaderCircle className="spin" size={34} />
                : <ImageOff size={38} strokeWidth={1.5} />}
              <span>{failed ? "图片加载失败" : content.isDownloading ? "图片正在下载" : "原图尚未下载"}</span>
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
        </main>

        {(content.caption || content.isDownloading) && (
          <footer className="media-viewer-caption">
            <span>{content.caption}</span>
            {content.isDownloading && <small>{content.progress === undefined ? "下载中" : `${Math.round(content.progress * 100)}%`}</small>}
          </footer>
        )}
      </div>
    </div>
  );
}
