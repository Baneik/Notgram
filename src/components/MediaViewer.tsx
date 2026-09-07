import { messageCanBeSaved } from "../telegram/messageLifecycle";
import { translate } from "../i18n";
import { localMediaSource } from "../media/localMediaSource";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import {
  adjacentPhotoId,
  photoThumbnailWindow,
  type PhotoMessage,
} from "../utils/mediaViewerModel";
import { MediaProgressRing } from "./MediaProgressRing";
import { StableImage } from "./StableImage";

interface MediaViewerProps {
  messages: PhotoMessage[];
  activeMessageId: string;
  onActiveMessageChange: (messageId: string) => void;
  onClose: () => void;
  allowSave?: boolean;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onSave: (sourcePath: string, fileName: string) => Promise<void>;
}

// A retained photo can still have a readable preview after its original is gone.
// Use the same fallback order for the stage and its thumbnail strip.
const usePhotoSource = (message?: PhotoMessage) => {
  const content = message?.content;
  const sources = useMemo(() => [...new Set([
    localMediaSource(content?.localPath),
    localMediaSource(content?.thumbnailPath),
    content?.previewDataUrl,
  ].filter((value): value is string => Boolean(value)))], [
    content?.localPath, content?.thumbnailPath, content?.previewDataUrl,
  ]);
  const [failedSources, setFailedSources] = useState<Set<string>>(() => new Set());
  useEffect(() => setFailedSources(new Set()), [message?.id, sources]);
  const source = sources.find((candidate) => !failedSources.has(candidate));
  return {
    source,
    failed: sources.length > 0 && !source,
    onError: () => {
      if (source) setFailedSources((current) => new Set(current).add(source));
    },
    retry: () => setFailedSources(new Set()),
  };
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

interface MediaViewerThumbnailProps {
  message: PhotoMessage;
  selected: boolean;
  onSelect: () => void;
}

function MediaViewerThumbnail({
  message,
  selected,
  onSelect,
}: MediaViewerThumbnailProps) {
  const { source, onError } = usePhotoSource(message);

  return (
    <button
      className={selected ? "is-active" : undefined}
      type="button"
      aria-label={translate("查看 {{value0}}", { value0: message.content.fileName })}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      {source
        ? <StableImage
            src={source}
            alt=""
            loading="eager"
            decoding="async"
            onError={onError}
          />
        : <ImageOff size={18} strokeWidth={1.6} />}
      {message.content.isDownloading && (
        <span
          className="media-progress"
          role="progressbar"
          aria-label={translate("下载 {{value0}}", { value0: message.content.fileName })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((message.content.progress ?? 0) * 100)}
        >
          <span><MediaProgressRing progress={message.content.progress} /></span>
        </span>
      )}
    </button>
  );
}

interface PanPosition {
  x: number;
  y: number;
}

export function MediaViewer({
  messages,
  activeMessageId,
  onActiveMessageChange,
  onClose,
  allowSave = true,
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
  const showDownloading = useStableVisibility(Boolean(active?.content.isDownloading), {
    minimumVisible: 320,
  });
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose, false, stageRef);
  const previousId = adjacentPhotoId(messages, activeMessageId, -1);
  const nextId = adjacentPhotoId(messages, activeMessageId, 1);
  const thumbnailMessages = useMemo(
    () => photoThumbnailWindow(messages, activeMessageId),
    [activeMessageId, messages],
  );
  const { source, failed, onError, retry } = usePhotoSource(active);
  useEffect(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    dragRef.current = undefined;
  }, [activeMessageId, source]);

  useEffect(() => {
    if (zoom === MIN_ZOOM) setPan({ x: 0, y: 0 });
  }, [zoom]);

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
  const canDownload = messageCanBeSaved(active) && content.fileId !== undefined &&
    content.canDownload !== false &&
    !content.isDownloading &&
    !content.isDownloaded;
  const canSave = allowSave && messageCanBeSaved(active) && Boolean(content.localPath);
  const downloadUnavailable = !canSave && !canDownload && !content.isDownloading;
  const imageDetails = [
    translate("数据中心：{{value0}}", {
      value0: content.dataCenterId ? `DC${content.dataCenterId}` : translate("Telegram 自动选择"),
    }),
    translate("尺寸：{{value0}}", {
      value0: content.width && content.height ? `${content.width} × ${content.height}` : translate("未知"),
    }),
    translate("大小：{{value0}}", { value0: content.sizeLabel }),
  ];
  const handleDownload = () => {
    if (allowSave && content.localPath) return onSave(content.localPath, content.fileName);
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
        aria-label={translate("图片查看器：{{value0}}", { value0: content.fileName })}
        tabIndex={-1}
      >
        <main
          ref={stageRef}
          tabIndex={-1}
          className={`media-viewer-stage ${messages.length > 1 ? "has-thumbnails" : ""} ${zoom > MIN_ZOOM ? "is-pannable" : ""} ${dragging ? "is-dragging" : ""}`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
        >
          <button
            className="media-viewer-download"
            type="button"
            aria-label={translate("下载图片")}
            aria-busy={content.isDownloading || undefined}
            title={content.isDownloading ? translate("原图下载中") : canSave ? translate("保存到下载目录") : translate("下载原图")}
            disabled={content.isDownloading || downloadUnavailable}
            onClick={() => void handleDownload()}
          >
            {content.isDownloading
              ? <LoaderCircle className="spin" size={19} />
              : <Download size={19} />}
          </button>
          <aside className="media-viewer-details" aria-label={translate("图片详细信息")}>
            {imageDetails.map((detail) => <span key={detail}>{detail}</span>)}
          </aside>
          {source && !failed ? (
            <StableImage
              key={source}
              ref={imageRef}
              className="media-viewer-image"
              src={source}
              alt={content.caption || content.fileName}
              draggable={false}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              onError={onError}
            />
          ) : (
            <div className="media-viewer-empty" role="status">
              {showDownloading
                ? <LoaderCircle className="spin" size={34} />
                : <ImageOff size={38} strokeWidth={1.5} />}
              <span>{failed ? translate("图片加载失败") : showDownloading ? translate("图片正在下载") : translate("原图尚未下载")}</span>
              {failed && (
                <button type="button" onClick={retry}>{translate("重试加载")}</button>
              )}
              {canDownload && (
                <button type="button" onClick={() => void onDownload(content.fileId!, content.fileName)}>
                  <Download size={17} />{translate("下载原图")}</button>
              )}
            </div>
          )}
          {previousId && (
            <button className="media-viewer-nav is-previous" type="button" aria-label={translate("上一张")} title={translate("上一张")} onClick={() => onActiveMessageChange(previousId)}>
              <ChevronLeft size={30} />
            </button>
          )}
          {nextId && (
            <button className="media-viewer-nav is-next" type="button" aria-label={translate("下一张")} title={translate("下一张")} onClick={() => onActiveMessageChange(nextId)}>
              <ChevronRight size={30} />
            </button>
          )}
          {messages.length > 1 && (
            <nav className="media-viewer-thumbnails" aria-label={translate("会话图片预览")}>
              {thumbnailMessages.map((message) => (
                <MediaViewerThumbnail
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
