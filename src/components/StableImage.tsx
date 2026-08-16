import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from "react";

type StableImageProps = ImgHTMLAttributes<HTMLImageElement>;

/** Keeps the fallback visible until the current image has finished decoding. */
export const StableImage = forwardRef<HTMLImageElement, StableImageProps>(function StableImage({
  className = "",
  decoding = "async",
  onError,
  onLoad,
  src,
  ...props
}, forwardedRef) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [readySource, setReadySource] = useState<string>();
  const source = typeof src === "string" ? src : undefined;
  const ready = Boolean(source && readySource === source);

  useImperativeHandle(forwardedRef, () => imageRef.current!, []);

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    onLoad?.(event);
    const image = event.currentTarget;
    const loadedSource = source;
    const reveal = () => {
      if (loadedSource && imageRef.current === image) setReadySource(loadedSource);
    };
    if (typeof image.decode === "function") void image.decode().catch(() => undefined).then(reveal);
    else reveal();
  }, [onLoad, source]);

  return (
    <img
      {...props}
      ref={imageRef}
      className={`stable-image ${className}`.trim()}
      src={src}
      decoding={decoding}
      data-image-state={ready ? "ready" : "decoding"}
      onLoad={handleLoad}
      onError={onError}
    />
  );
});
