import { useCallback, useEffect, useRef, type VideoHTMLAttributes } from "react";
import { useElementVisibility } from "../hooks/useElementVisibility";

interface AutoplayVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, "autoPlay"> {
  autoplay: boolean;
}

/** Keeps already-mounted animation media in sync when motion preferences change. */
export function AutoplayVideo({ autoplay, ...props }: AutoplayVideoProps) {
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const [visibilityRef, visible] = useElementVisibility<HTMLVideoElement>();
  const shouldPlay = autoplay && visible;
  const setVideoRef = useCallback((video: HTMLVideoElement | null) => {
    videoElementRef.current = video;
    const stopObserving = visibilityRef(video);
    return () => {
      if (videoElementRef.current === video) videoElementRef.current = null;
      stopObserving?.();
      video?.pause();
    };
  }, [visibilityRef]);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) return;
    if (shouldPlay) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [props.src, shouldPlay]);

  return <video
    ref={setVideoRef}
    {...props}
    autoPlay={shouldPlay}
    data-motion-autoplay={shouldPlay ? "true" : "false"}
  />;
}
