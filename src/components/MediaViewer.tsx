import { messageCanBeSaved } from "../telegram/messageLifecycle";
import { parseTdlibRemoteFileDataCenter } from "../telegram/fileDataCenter";
import { translate } from "../i18n";
import { ChevronLeft, ChevronRight, Download, ImageOff, LoaderCircle } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { useImageViewport } from "../hooks/useImageViewport";
import { adjacentPhotoId, photoThumbnailWindow, type PhotoMessage } from "../utils/mediaViewerModel";
import { photoSources } from "../media/photoSources";
import { hasDecodedImage, rememberDecodedImage } from "../media/decodedImages";
import { localMediaSource } from "../media/localMediaSource";
import { logPerformance } from "../utils/performanceMonitor";
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

function usePhotoSource(message: PhotoMessage, thumbnail = false) {
  const content = message.content;
  const sources = useMemo(() => photoSources(content, thumbnail), [content.localPath, content.thumbnailPath, content.previewDataUrl, thumbnail]);
  const [failedSources, setFailedSources] = useState<Set<string>>(() => new Set());
  const available = sources.filter(source => !failedSources.has(source));
  const source = available[0];
  return {
    source,
    preview: available[1],
    failed: sources.length > 0 && !source,
    onError: () => {
      if (source) setFailedSources(current => new Set(current).add(source));
    },
    retry: () => setFailedSources(new Set()),
  };
}

const MediaViewerThumbnail = memo(function MediaViewerThumbnail({ message, selected, onSelect }: {
  message: PhotoMessage; selected: boolean; onSelect: (id: string) => void;
}) {
  const { source, onError } = usePhotoSource(message, true);
  return <button className={selected ? "is-active" : undefined} type="button"
    aria-label={translate("查看 {{value0}}", { value0: message.content.fileName })}
    aria-current={selected ? "true" : undefined} onClick={() => onSelect(message.id)}>
    {source ? <StableImage src={source} alt="" loading="eager" decoding="async" onError={onError} /> : <ImageOff size={18} />}
    {message.content.isDownloading && <span className="media-progress" role="progressbar"
      aria-label={translate("下载 {{value0}}", { value0: message.content.fileName })}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((message.content.progress ?? 0) * 100)}>
      <span><MediaProgressRing progress={message.content.progress} /></span>
    </span>}
  </button>;
});

function PhotoSurface({ message, onDownload, onDimensions }: {
  message: PhotoMessage; onDownload: MediaViewerProps["onDownload"]; onDimensions: (width: number, height: number) => void;
}) {
  const { source, preview, failed, onError, retry } = usePhotoSource(message);
  const [hasReadyImage, setHasReadyImage] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const startedAt = useRef(performance.now());
  const showDownloading = useStableVisibility(Boolean(message.content.isDownloading));
  const content = message.content;
  const canDownload = messageCanBeSaved(message) && content.fileId !== undefined && content.canDownload !== false && !content.isDownloading && !content.isDownloaded;
  return source ? <>
    {/* Start the original immediately; a slow preview must never gate its load. */}
    {!hasReadyImage && preview && <StableImage className="media-viewer-placeholder" src={preview} alt="" aria-hidden="true" draggable={false} />}
    <StableImage ref={imageRef} retainWhileLoading className="media-viewer-image" fetchPriority="high"
    src={source} alt={content.caption || content.fileName} draggable={false} onError={onError}
    onReady={() => {
      setHasReadyImage(true);
      if (imageRef.current && source === localMediaSource(content.localPath)) {
        onDimensions(imageRef.current.naturalWidth, imageRef.current.naturalHeight);
      }
      logPerformance("ui_media_viewer_image", { durationMs: performance.now() - startedAt.current });
    }} /></> : <div className="media-viewer-empty" role="status">
    {showDownloading ? <LoaderCircle className="spin" size={34} /> : <ImageOff size={38} strokeWidth={1.5} />}
    <span>{failed ? translate("图片加载失败") : showDownloading ? translate("图片正在下载") : translate("原图尚未下载")}</span>
    {failed && <button type="button" onClick={retry}>{translate("重试加载")}</button>}
    {canDownload && <button type="button" onClick={() => void onDownload(content.fileId!, content.fileName)}>
      <Download size={17} />{translate("下载原图")}
    </button>}
  </div>;
}

export function MediaViewer(props: MediaViewerProps) {
  const active = props.messages.find(message => message.id === props.activeMessageId);
  return active ? <Viewer {...props} active={active} /> : null;
}

function Viewer({ messages, activeMessageId, active, onActiveMessageChange, onClose, allowSave = true, onDownload, onSave }: MediaViewerProps & { active: PhotoMessage }) {
  const content = active.content;
  const identity = `${active.chatId}:${active.id}`;
  const stageRef = useRef<HTMLElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose, false, stageRef);
  const [naturalSize, setNaturalSize] = useState<{ identity: string; source?: string; width: number; height: number }>();
  const dimensions = {
    width: naturalSize?.identity === identity ? naturalSize.width : content.width || 1280,
    height: naturalSize?.identity === identity ? naturalSize.height : content.height || 800,
  };
  const viewport = useImageViewport(identity, dimensions);
  const previousId = adjacentPhotoId(messages, activeMessageId, -1);
  const nextId = adjacentPhotoId(messages, activeMessageId, 1);
  const previousSource = localMediaSource(messages.find(message => message.id === previousId)?.content.localPath);
  const nextSource = localMediaSource(messages.find(message => message.id === nextId)?.content.localPath);
  const originalReady = naturalSize?.identity === identity && naturalSize.source === content.localPath;
  useEffect(() => {
    if (!originalReady) return;
    let cancelled = false;
    const images: HTMLImageElement[] = [];
    // The visible original owns the decode budget first. Warm neighbors one at
    // a time only after it is ready, and cancel pending work on navigation.
    const timer = globalThis.setTimeout(() => {
      void (async () => {
        for (const source of new Set([previousSource, nextSource])) {
          if (cancelled) return;
          if (!source || hasDecodedImage(source)) continue;
          const image = new Image();
          images.push(image);
          image.decoding = "async";
          image.fetchPriority = "low";
          image.src = source;
          try {
            await image.decode();
            if (!cancelled) rememberDecodedImage(source);
          } catch { /* A failed neighbor must not prevent viewing the current photo. */ }
        }
      })();
    }, 140);
    return () => {
      cancelled = true; globalThis.clearTimeout(timer);
      for (const image of images) image.removeAttribute("src");
    };
  }, [identity, content.localPath, originalReady, previousSource, nextSource]);
  const thumbnailSlotRef = useRef<HTMLDivElement>(null);
  const [thumbnailLimit, setThumbnailLimit] = useState(1);
  const [actionError, setActionError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const actionGeneration = useRef(0);
  const navigationId = useRef(activeMessageId);
  const keyboard = useRef({ previousId, nextId, onActiveMessageChange, viewport });
  useLayoutEffect(() => { keyboard.current = { previousId, nextId, onActiveMessageChange, viewport }; });
  useLayoutEffect(() => {
    actionGeneration.current++;
    navigationId.current = activeMessageId;
    setActionError(undefined); setSaving(false);
  }, [identity]);

  useLayoutEffect(() => {
    const element = thumbnailSlotRef.current;
    if (!element) return;
    const measure = () => {
      const capacity = Math.max(1, Math.min(9, Math.floor((element.clientWidth - 16 + 7) / 65)));
      setThumbnailLimit(capacity % 2 === 0 ? capacity - 1 : capacity);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const thumbnails = useMemo(() => photoThumbnailWindow(messages, activeMessageId, thumbnailLimit), [messages, activeMessageId, thumbnailLimit]);

  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey) return;
      const state = keyboard.current;
      const id = event.key === "ArrowLeft" ? state.previousId : event.key === "ArrowRight" ? state.nextId : undefined;
      if (id) { event.preventDefault(); state.onActiveMessageChange(id); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); state.viewport.zoomBy(1.5); }
      else if (event.key === "-") { event.preventDefault(); state.viewport.zoomBy(1 / 1.5); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1);
    if (!Number.isFinite(delta) || delta === 0) return;
    if (event.ctrlKey) {
      viewport.zoomBy(Math.exp(-delta * Math.log(1.5) / 240), { x: event.clientX, y: event.clientY });
      return;
    }
    // Track every event, including a burst delivered before React commits.
    const target = adjacentPhotoId(messages, navigationId.current, delta < 0 ? -1 : 1);
    if (target) { navigationId.current = target; onActiveMessageChange(target); }
  };
  const canDownload = messageCanBeSaved(active) && content.fileId !== undefined && content.canDownload !== false && !content.isDownloading && !content.isDownloaded;
  const canSave = allowSave && messageCanBeSaved(active) && Boolean(content.localPath);
  // Re-derive from the file ID so snapshots written by older clients cannot
  // continue presenting the account's DC as this image's storage location.
  const dc = content.remoteId ? parseTdlibRemoteFileDataCenter(content.remoteId) : undefined;
  const imageDetails = [
    translate("数据中心：{{value0}}", { value0: dc ? `DC${dc}` : translate("未知") }),
    translate("尺寸：{{value0}}", { value0: naturalSize?.identity === identity || (content.width && content.height) ? `${dimensions.width} × ${dimensions.height}` : translate("未知") }),
    translate("大小：{{value0}}", { value0: content.sizeLabel }),
  ];
  const save = async () => {
    const generation = actionGeneration.current;
    setSaving(true); setActionError(undefined);
    try {
      if (canSave) await onSave(content.localPath!, content.fileName);
      else if (canDownload) await onDownload(content.fileId!, content.fileName);
    } catch { if (actionGeneration.current === generation) setActionError(translate("文件下载失败")); }
    finally { if (actionGeneration.current === generation) setSaving(false); }
  };
  return <div className="media-viewer-backdrop" role="presentation">
    <div ref={dialogRef} className="media-viewer" role="dialog" aria-modal="true"
      aria-label={translate("图片查看器：{{value0}}", { value0: content.fileName })} tabIndex={-1}>
      <main ref={stageRef} tabIndex={-1} className="media-viewer-stage" onWheel={handleWheel}>
        <div ref={viewport.fitRef} className="media-viewer-canvas" onPointerDown={event => {
          if (event.button === 0 && event.target === event.currentTarget) onClose();
        }}>
          <div ref={viewport.viewportRef} className={`media-viewer-viewport ${viewport.zoom > 1 ? "is-pannable" : ""}`}
            onPointerDown={event => {
              if (event.button !== 0) return;
              if (event.target === event.currentTarget) { event.preventDefault(); onClose(); return; }
              viewport.onPointerDown(event);
            }} onPointerMove={viewport.onPointerMove} onPointerUp={viewport.onPointerUp}
            onPointerCancel={viewport.onPointerCancel} onLostPointerCapture={viewport.onLostPointerCapture}
            onDoubleClick={event => {
              // Pointer capture retargets the click to the viewport after a
              // zoomed image is pressed. Hit-test the image instead of target.
              const surface = viewport.surfaceRef.current;
              const bounds = surface?.getBoundingClientRect();
              if (surface?.querySelector(".media-viewer-image") && bounds && event.clientX >= bounds.left &&
                  event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
                viewport.toggleActualSize({ x: event.clientX, y: event.clientY });
              }
            }}>
            <div ref={viewport.surfaceRef} className="media-viewer-surface">
              <PhotoSurface key={identity} message={active} onDownload={async (fileId, fileName) => {
                const generation = actionGeneration.current;
                try { await onDownload(fileId, fileName); }
                catch { if (actionGeneration.current === generation) setActionError(translate("文件下载失败")); }
              }}
                onDimensions={(width, height) => setNaturalSize(current => current?.identity === identity && current.source === content.localPath && current.width === width && current.height === height ? current : { identity, source: content.localPath, width, height })} />
            </div>
          </div>
          {previousId && <button className="media-viewer-nav is-previous" type="button" aria-label={translate("上一张")} title={translate("上一张")} onClick={() => onActiveMessageChange(previousId)}><ChevronLeft size={28} /></button>}
          {nextId && <button className="media-viewer-nav is-next" type="button" aria-label={translate("下一张")} title={translate("下一张")} onClick={() => onActiveMessageChange(nextId)}><ChevronRight size={28} /></button>}
          {viewport.zoom > 1 && <output className="media-viewer-zoom" aria-label={translate("图片缩放比例")}>{viewport.percentage}%</output>}
        </div>
        <footer className="media-viewer-footer">
          {content.caption && <div className="media-viewer-caption-wrap">
            <p className="media-viewer-caption" aria-live="polite">{content.caption}</p>
          </div>}
          <div className="media-viewer-controls">
            <aside className="media-viewer-details" aria-label={translate("图片详细信息")}>
              {imageDetails.map(detail => <span key={detail}>{detail}</span>)}
            </aside>
            <div className="media-viewer-thumbnail-slot" ref={thumbnailSlotRef}>
              {messages.length > 1 && <nav className="media-viewer-thumbnails" aria-label={translate("会话图片预览")}>
                {thumbnails.map(message => <MediaViewerThumbnail key={`${message.chatId}:${message.id}`} message={message} selected={message.id === activeMessageId} onSelect={onActiveMessageChange} />)}
              </nav>}
            </div>
            <div className="media-viewer-actions">
              <span className="media-viewer-counter">{messages.findIndex(message => message.id === activeMessageId) + 1} / {messages.length}</span>
              <button className="media-viewer-download" type="button" aria-label={translate("下载图片")} aria-busy={content.isDownloading || saving || undefined}
                title={content.isDownloading ? translate("原图下载中") : canSave ? translate("保存到下载目录") : translate("下载原图")}
                disabled={saving || content.isDownloading || (!canSave && !canDownload)} onClick={() => void save()}>
                {content.isDownloading || saving ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}
              </button>
            </div>
          </div>
          {actionError && <div className="media-viewer-action-error" role="alert">{actionError}</div>}
        </footer>
      </main>
    </div>
  </div>;
}
