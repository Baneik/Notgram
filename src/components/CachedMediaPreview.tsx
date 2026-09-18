import { useLayoutEffect, useRef } from "react";
import { cloneMediaPreview } from "../media/mediaPreviewCache";

/** Restore pixels before paint; the current image/player still owns readiness. */
export function CachedMediaPreview({ source, onReady }: { source: string; onReady?: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const onReadyRef = useRef(onReady);
  useLayoutEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useLayoutEffect(() => {
    const container = ref.current;
    const preview = cloneMediaPreview(source);
    if (!container || !preview) return;
    container.replaceChildren(preview);
    onReadyRef.current?.();
    return () => { container.replaceChildren(); };
  }, [source]);
  return <span ref={ref} className="cached-media-preview" aria-hidden="true" />;
}
