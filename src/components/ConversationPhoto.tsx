import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { getPhotoPreview, invalidatePhotoPreview, latestPhotoPreview, photoPreviewSize, retainPhotoPreview, type PhotoPreviewSize } from "../media/photoPreview";
import { StableImage } from "./StableImage";
import { MEDIA_PREFETCH_ROOT_MARGIN, MESSAGE_SCROLL_ROOT_SELECTOR } from "../utils/mediaPrefetch";

interface Props {
  source: string;
  fallback?: string;
  alt?: string;
  cover: boolean;
  onReady: () => void;
  onDimensions: (width: number, height: number) => void;
  onError: () => void;
}

/** The surrounding card owns geometry; a preview's pixel size never changes it. */
export function ConversationPhoto({ source, fallback, alt, cover, onReady, onDimensions, onError }: Props) {
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const [visibilityRef, visible] = useElementVisibility<HTMLSpanElement>(MEDIA_PREFETCH_ROOT_MARGIN, MESSAGE_SCROLL_ROOT_SELECTOR);
  const [size, setSize] = useState<PhotoPreviewSize | undefined>(() => latestPhotoPreview(source, cover)?.size);
  const [loaded, setLoaded] = useState<{ source: string; size: PhotoPreviewSize; url: string } | undefined>(() => {
    const previous = latestPhotoPreview(source, cover);
    return previous ? { source, size: previous.size, url: previous.value.url } : undefined;
  });
  const [failed, setFailed] = useState<string>();
  const [failedFallback, setFailedFallback] = useState<string>();
  const callbacks = useRef({ onDimensions, onError });
  useLayoutEffect(() => { callbacks.current = { onDimensions, onError }; });
  const ref = useCallback((element: HTMLSpanElement | null) => {
    elementRef.current = element;
    return visibilityRef(element);
  }, [visibilityRef]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1) return;
      // Bounds include app CSS zoom; DPR adds the physical display scale.
      const next = photoPreviewSize(bounds.width * devicePixelRatio, bounds.height * devicePixelRatio, cover);
      setSize(current => current?.width === next.width && current.height === next.height && current.cover === next.cover ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const zoomObserver = new MutationObserver(measure);
    zoomObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); zoomObserver.disconnect(); window.removeEventListener("resize", measure); };
  }, [cover]);

  const cached = size ? getPhotoPreview(source, size) : undefined;
  useEffect(() => {
    if (!size || (!visible && !cached)) return;
    let active = true;
    const retained = retainPhotoPreview(source, size);
    void retained.promise.then(value => {
      if (!active) return;
      callbacks.current.onDimensions(value.sourceWidth, value.sourceHeight);
      setFailed(undefined);
      setLoaded({ source, size, url: value.url });
    }).catch(() => {
      // Preserve the existing element recovery path for unsupported codecs or
      // unavailable preview generation, rather than making the photo unusable.
      if (active) setFailed(source);
    });
    return () => { active = false; retained.release(); };
  }, [source, size, visible, Boolean(cached)]);

  const previous = loaded?.source === source ? getPhotoPreview(source, loaded.size)?.url : undefined;
  const prepared = failed === source ? undefined : cached?.url ?? previous;
  const displaySource = prepared ?? (failed === source ? source : fallback !== failedFallback ? fallback : undefined);
  return <span className="conversation-photo" ref={ref}>
    {displaySource && <StableImage
      retainWhileLoading
      retainOnRemount
      src={displaySource}
      alt={alt}
      decoding="async"
      data-photo-preview={prepared ? "true" : undefined}
      onReady={onReady}
      onLoad={event => {
        if (!prepared && displaySource === source) {
          callbacks.current.onDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
        }
      }}
      onError={() => {
        if (displaySource === source) callbacks.current.onError();
        else if (prepared) {
          if (size) invalidatePhotoPreview(source, size);
          setLoaded(undefined);
          setFailed(source);
        } else setFailedFallback(fallback);
      }}
    />}
  </span>;
}
