import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type VideoHTMLAttributes } from "react";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { forgetMediaPreview, hasMediaPreview, mediaPreviewGeneration, rememberMediaPreview } from "../media/mediaPreviewCache";
import { CachedMediaPreview } from "./CachedMediaPreview";

interface AutoplayVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, "autoPlay"> {
  autoplay: boolean;
  retainOnRemount?: boolean;
  onReady?: () => void;
}

/** Keeps already-mounted animation media in sync when motion preferences change. */
export function AutoplayVideo({ autoplay, retainOnRemount = false, onReady, ...props }: AutoplayVideoProps) {
  const [readySource, setReadySource] = useState<string>();
  const previewGeneration = useMemo(() => mediaPreviewGeneration(), [props.src]);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const failedVideoRef = useRef<HTMLVideoElement | null>(null);
  const [visibilityRef, visible] = useElementVisibility<HTMLVideoElement>();
  const shouldPlay = autoplay && visible;
  useLayoutEffect(() => { setReadySource(undefined); }, [props.src]);
  const setVideoRef = useCallback((video: HTMLVideoElement | null) => {
    videoElementRef.current = video;
    const stopObserving = visibilityRef(video);
    return () => {
      if (retainOnRemount && props.src && video && !video.error && failedVideoRef.current !== video) {
        rememberMediaPreview(props.src, video, previewGeneration, { replace: true });
      }
      if (videoElementRef.current === video) videoElementRef.current = null;
      stopObserving?.();
      video?.pause();
    };
  }, [previewGeneration, props.src, retainOnRemount, visibilityRef]);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) return;
    if (shouldPlay) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [props.src, shouldPlay]);

  return <>
    {retainOnRemount && props.src && readySource !== props.src && hasMediaPreview(props.src) &&
      <CachedMediaPreview key={`preview:${props.src}`} source={props.src} onReady={onReady} />}
    <video
      key={props.src}
      ref={setVideoRef}
      {...props}
      autoPlay={shouldPlay}
      data-motion-autoplay={shouldPlay ? "true" : "false"}
      onLoadedData={event => {
        failedVideoRef.current = null;
        if (retainOnRemount && props.src) rememberMediaPreview(props.src, event.currentTarget, previewGeneration);
        setReadySource(props.src);
        onReady?.();
        props.onLoadedData?.(event);
      }}
      onError={event => {
        failedVideoRef.current = event.currentTarget;
        if (retainOnRemount && props.src) forgetMediaPreview(props.src);
        setReadySource(undefined);
        props.onError?.(event);
      }}
    />
  </>;
}
