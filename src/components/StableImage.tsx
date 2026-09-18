import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from "react";
import { forgetDecodedImage, hasDecodedImage, rememberDecodedImage } from "../media/decodedImages";
import { forgetMediaPreview, hasMediaPreview, mediaPreviewGeneration, rememberMediaPreview } from "../media/mediaPreviewCache";
import { CachedMediaPreview } from "./CachedMediaPreview";

type StableImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  onReady?: () => void;
  /** Only use within a positioned media surface whose identity survives source upgrades. */
  retainWhileLoading?: boolean;
  /** Small avatars/stickers can reuse bounded display pixels after virtualization. */
  retainOnRemount?: boolean;
};

/** Keeps the fallback visible until the current image has finished decoding. */
export const StableImage = forwardRef<HTMLImageElement, StableImageProps>(function StableImage({
  className = "",
  decoding = "async",
  onError,
  onLoad,
  onReady,
  retainWhileLoading = false,
  retainOnRemount = false,
  src,
  srcSet,
  sizes,
  ...props
}, forwardedRef) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [failedRequest, setFailedRequest] = useState<string>();
  const [readyImage, setReadyImage] = useState<{
    request: string; animate: boolean; source: string;
  }>();
  const source = typeof src === "string" ? src : undefined;
  const request = JSON.stringify([source, srcSet, sizes]);
  const previewSource = retainOnRemount && !srcSet ? source : undefined;
  const previewGeneration = useMemo(() => mediaPreviewGeneration(), [request]);
  const restoredRequest = useRef<string | undefined>(undefined);
  const ready = Boolean((source || srcSet) && readyImage?.request === request);
  const retained = retainWhileLoading && (source || srcSet) && !ready ? readyImage : undefined;
  const deliveredRequest = useRef<string | undefined>(undefined);

  useImperativeHandle(forwardedRef, () => imageRef.current!, [request]);

  const reveal = useCallback((image: HTMLImageElement, loadedSource: string, animate: boolean) => {
    // A late decode from a replaced source must not reveal or acknowledge it.
    if (imageRef.current !== image || image.getAttribute("src") !== (source ?? null) ||
      image.getAttribute("srcset") !== (srcSet ?? null) ||
      image.getAttribute("sizes") !== (sizes ?? null) ||
      image.currentSrc !== loadedSource || !image.complete || image.naturalWidth < 1) return;
    rememberDecodedImage(loadedSource);
    if (previewSource) rememberMediaPreview(previewSource, image, previewGeneration);
    setReadyImage((current) => current?.request === request ? current : {
      request, source: loadedSource, animate: animate && !(retainWhileLoading && current) && restoredRequest.current !== request,
    });
    if (deliveredRequest.current !== request) {
      deliveredRequest.current = request;
      onReady?.();
    }
  }, [onReady, previewGeneration, previewSource, request, retainWhileLoading, sizes, source, srcSet]);

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0 && hasDecodedImage(image.currentSrc)) {
      // Restore previously decoded, already-loaded resources before paint.
      reveal(image, image.currentSrc, false);
    }
  }, [reveal]);

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    onLoad?.(event);
    const image = event.currentTarget;
    const loadedSource = image.currentSrc;
    const animate = !hasDecodedImage(loadedSource);
    const finish = () => reveal(image, loadedSource, animate);
    if (typeof image.decode === "function") void image.decode().catch(() => undefined).then(finish);
    else finish();
  }, [onLoad, reveal]);

  return (
    <>
      {!ready && !retained && previewSource && hasMediaPreview(previewSource) && <CachedMediaPreview
        key={previewSource}
        source={previewSource}
        onReady={() => {
          restoredRequest.current = request;
          if (deliveredRequest.current !== request) {
            deliveredRequest.current = request;
            onReady?.();
          }
        }}
      />}
      {retained && <img
        {...props}
        key={retained.request}
        src={retained.source}
        className={`stable-image ${className}`.trim()}
        data-image-state="ready"
        data-image-transition="none"
        data-image-retained="true"
        aria-hidden="true"
      />}
      <img
        {...props}
        key={request}
        ref={imageRef}
        className={`stable-image ${className}`.trim()}
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        decoding={decoding}
        // The decoded node remains in normal flow. Only its replacement is
        // layered, so loading cannot change the media geometry or erase a frame.
        style={retained ? { ...props.style, position: "absolute", inset: 0, pointerEvents: "none" } : props.style}
        aria-hidden={retained ? true : props["aria-hidden"]}
        data-image-pending={retained ? "true" : undefined}
        data-image-state={ready ? "ready" : failedRequest === request ? "error" : "decoding"}
        data-image-transition={ready && readyImage?.animate ? "enter" : "none"}
        onLoad={handleLoad}
        onError={(event) => {
          forgetDecodedImage(event.currentTarget.currentSrc || event.currentTarget.src);
          if (previewSource) forgetMediaPreview(previewSource);
          setFailedRequest(request);
          deliveredRequest.current = undefined;
          if (!retainWhileLoading) setReadyImage(undefined);
          onError?.(event);
        }}
      />
    </>
  );
});
