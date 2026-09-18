import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { loadTgsAnimationData } from "../media/tgsAnimationCache";
import { forgetMediaPreview, hasMediaPreview, mediaPreviewGeneration, rememberMediaPreview } from "../media/mediaPreviewCache";
import { CachedMediaPreview } from "./CachedMediaPreview";

interface TgsStickerProps {
  src: string;
  label: string;
  autoplay: boolean;
  onError: () => void;
  onReady?: () => void;
}

export function TgsSticker({ src, label, autoplay, onError, onReady }: TgsStickerProps) {
  const containerElementRef = useRef<HTMLSpanElement | null>(null);
  const [readySource, setReadySource] = useState<string>();
  const previewGeneration = useMemo(() => mediaPreviewGeneration(), [src]);
  const [visibilityRef, visible] = useElementVisibility<HTMLSpanElement>();
  const animationRef = useRef<import("lottie-web").AnimationItem | undefined>(undefined);
  const shouldPlayRef = useRef(false);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const shouldPlay = autoplay && visible;
  // A -> pending B -> A creates a new player even though A was ready earlier.
  useLayoutEffect(() => { setReadySource(undefined); }, [src]);

  useEffect(() => {
    onErrorRef.current = onError;
    onReadyRef.current = onReady;
  }, [onError, onReady]);

  useEffect(() => {
    shouldPlayRef.current = shouldPlay;
    if (shouldPlay) animationRef.current?.play();
    else animationRef.current?.pause();
  }, [shouldPlay]);

  useEffect(() => {
    const container = containerElementRef.current;
    if (!container) return;
    let active = true;
    let frameReady = false;
    let animation: import("lottie-web").AnimationItem | undefined;
    const ready = () => {
      if (!active) return;
      frameReady = true;
      const svg = container.querySelector("svg");
      if (svg) rememberMediaPreview(src, svg, previewGeneration);
      setReadySource(src);
      onReadyRef.current?.();
    };
    const failed = () => {
      if (!active) return;
      frameReady = false;
      forgetMediaPreview(src);
      setReadySource(undefined);
      onErrorRef.current();
    };

    void Promise.all([
      loadTgsAnimationData(src),
      import("lottie-web/build/player/lottie_light"),
    ])
      .then(([animationData, lottieModule]) => {
        if (!active) return;
        animation = lottieModule.default.loadAnimation({
          container,
          renderer: "svg",
          loop: true,
          autoplay: shouldPlayRef.current,
          animationData,
          rendererSettings: { preserveAspectRatio: "xMidYMid meet", progressiveLoad: true },
        });
        animationRef.current = animation;
        animation.addEventListener("DOMLoaded", ready);
        animation.addEventListener("data_failed", failed);
        animation.addEventListener("error", failed);
        if (animation.isLoaded) ready();
        if (!shouldPlayRef.current) animation.pause();
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        failed();
      });

    return () => {
      active = false;
      // The first frame of an animation can be empty; preserve the frame the
      // reader actually left before Lottie removes its rendered SVG.
      const svg = frameReady ? container.querySelector("svg") : undefined;
      if (svg) rememberMediaPreview(src, svg, previewGeneration, { replace: true });
      animation?.destroy();
      if (animationRef.current === animation) animationRef.current = undefined;
      container.replaceChildren();
    };
  }, [previewGeneration, src]);

  return <span
    ref={visibilityRef}
    className="tgs-sticker"
    role="img"
    aria-label={label}
    data-motion-autoplay={shouldPlay ? "true" : "false"}
  >
    {readySource !== src && hasMediaPreview(src) && <CachedMediaPreview key={`preview:${src}`} source={src} onReady={onReady} />}
    <span key={src} ref={containerElementRef} className="tgs-sticker-player" />
  </span>;
}
