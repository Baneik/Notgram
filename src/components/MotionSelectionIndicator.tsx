import { useLayoutEffect, useRef } from "react";
import { usePreferencesStore } from "../store/preferencesStore";
import { motionDuration, motionEasing } from "../utils/motionTokens";

interface MotionSelectionIndicatorProps {
  selection: string;
  selector: string;
  axis?: "horizontal" | "vertical";
}

/** One persistent marker follows selection, including interrupted moves and resizing. */
export function MotionSelectionIndicator({ selection, selector, axis = "horizontal" }: MotionSelectionIndicatorProps) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const previousTransform = useRef<string | undefined>(undefined);
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const container = marker?.parentElement;
    const selected = container?.querySelector<HTMLElement>(selector);
    if (!container || !marker || !selected) {
      if (marker) marker.style.opacity = "0";
      previousTransform.current = undefined;
      return;
    }
    let animation: Animation | undefined;
    let targetTransform: string | undefined;
    const position = (animate: boolean) => {
      // Both navigations position their buttons directly in this container.
      // Layout offsets ignore ancestor entrance transforms, zoom, and scrolling.
      const transform = axis === "horizontal"
        ? `translateX(${selected.offsetLeft + 12}px) scaleX(${Math.max(1, selected.offsetWidth - 24)})`
        : `translateY(${selected.offsetTop + 8}px) scaleY(${Math.max(1, selected.offsetHeight - 16)})`;
      // ResizeObserver delivers an initial notification after every selection.
      // Only a real geometry change may replace an in-flight marker animation.
      if (!animate && targetTransform === transform) return;
      targetTransform = transform;
      const from = previousTransform.current;
      animation?.cancel();
      marker.style.opacity = "1";
      marker.style.transform = transform;
      if (animate && from && !reduceMotion && !document.hidden && marker.animate) {
        animation = marker.animate([{ transform: from }, { transform }], {
          duration: motionDuration.standard, easing: motionEasing.standard,
        });
      }
      previousTransform.current = transform;
    };
    position(true);
    const resize = new ResizeObserver(() => position(false));
    resize.observe(container);
    resize.observe(selected);
    const onVisibility = () => { if (document.hidden) animation?.cancel(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      previousTransform.current = getComputedStyle(marker).transform;
      animation?.cancel();
      resize.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [axis, reduceMotion, selection, selector]);
  return <span ref={markerRef} className="motion-selection-indicator" data-axis={axis} aria-hidden="true" />;
}
