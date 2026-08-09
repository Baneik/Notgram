import { useEffect, useRef, type VideoHTMLAttributes } from "react";

interface AutoplayVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, "autoPlay"> {
  autoplay: boolean;
}

/** Keeps already-mounted animation media in sync when motion preferences change. */
export function AutoplayVideo({ autoplay, ...props }: AutoplayVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (autoplay) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [autoplay, props.src]);

  return <video ref={videoRef} {...props} autoPlay={autoplay} data-motion-autoplay={autoplay ? "true" : "false"} />;
}
