import { useCallback, useEffect, useRef } from "react";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { loadTgsAnimationData } from "../media/tgsAnimationCache";

interface TgsStickerProps {
  src: string;
  label: string;
  autoplay: boolean;
  onError: () => void;
}

export function TgsSticker({ src, label, autoplay, onError }: TgsStickerProps) {
  const containerElementRef = useRef<HTMLSpanElement | null>(null);
  const [visibilityRef, visible] = useElementVisibility<HTMLSpanElement>();
  const animationRef = useRef<import("lottie-web").AnimationItem | undefined>(undefined);
  const shouldPlayRef = useRef(false);
  const onErrorRef = useRef(onError);
  const shouldPlay = autoplay && visible;
  const containerRef = useCallback((container: HTMLSpanElement | null) => {
    containerElementRef.current = container;
    const stopObserving = visibilityRef(container);
    return () => {
      if (containerElementRef.current === container) containerElementRef.current = null;
      stopObserving?.();
    };
  }, [visibilityRef]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    shouldPlayRef.current = shouldPlay;
    if (shouldPlay) animationRef.current?.play();
    else animationRef.current?.pause();
  }, [shouldPlay]);

  useEffect(() => {
    const container = containerElementRef.current;
    if (!container) return;
    let active = true;
    let animation: import("lottie-web").AnimationItem | undefined;

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
        if (!shouldPlayRef.current) animation.pause();
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        onErrorRef.current();
      });

    return () => {
      active = false;
      animation?.destroy();
      if (animationRef.current === animation) animationRef.current = undefined;
      container.replaceChildren();
    };
  }, [src]);

  return <span
    ref={containerRef}
    className="tgs-sticker"
    role="img"
    aria-label={label}
    data-motion-autoplay={shouldPlay ? "true" : "false"}
  />;
}
