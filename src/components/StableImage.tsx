import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from "react";
import { forgetDecodedImage, hasDecodedImage, rememberDecodedImage } from "../media/decodedImages";

type StableImageProps = ImgHTMLAttributes<HTMLImageElement> & { onReady?: () => void };

/** Keeps the fallback visible until the current image has finished decoding. */
export const StableImage = forwardRef<HTMLImageElement, StableImageProps>(function StableImage({
  className = "",
  decoding = "async",
  onError,
  onLoad,
  onReady,
  src,
  srcSet,
  sizes,
  ...props
}, forwardedRef) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [readyImage, setReadyImage] = useState<{ request: string; animate: boolean }>();
  const source = typeof src === "string" ? src : undefined;
  const request = JSON.stringify([source, srcSet, sizes]);
  const ready = Boolean((source || srcSet) && readyImage?.request === request);
  const deliveredRequest = useRef<string | undefined>(undefined);

  useImperativeHandle(forwardedRef, () => imageRef.current!, []);

  const reveal = useCallback((image: HTMLImageElement, loadedSource: string, animate: boolean) => {
    // A late decode from a replaced source must not reveal or acknowledge it.
    if (imageRef.current !== image || image.getAttribute("src") !== (source ?? null) ||
      image.getAttribute("srcset") !== (srcSet ?? null) ||
      image.getAttribute("sizes") !== (sizes ?? null) ||
      image.currentSrc !== loadedSource || !image.complete || image.naturalWidth < 1) return;
    rememberDecodedImage(loadedSource);
    setReadyImage((current) => current?.request === request ? current : { request, animate });
    if (deliveredRequest.current !== request) {
      deliveredRequest.current = request;
      onReady?.();
    }
  }, [onReady, request, sizes, source, srcSet]);

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
    <img
      {...props}
      ref={imageRef}
      className={`stable-image ${className}`.trim()}
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      decoding={decoding}
      data-image-state={ready ? "ready" : "decoding"}
      data-image-transition={ready && readyImage?.animate ? "enter" : "none"}
      onLoad={handleLoad}
      onError={(event) => {
        forgetDecodedImage(event.currentTarget.currentSrc || event.currentTarget.src);
        deliveredRequest.current = undefined;
        setReadyImage(undefined);
        onError?.(event);
      }}
    />
  );
});
