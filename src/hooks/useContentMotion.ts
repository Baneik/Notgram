import { useLayoutEffect, useRef, type RefObject } from "react";
import { usePreferencesStore } from "../store/preferencesStore";
import { motionDistance, motionDuration, motionEasing } from "../utils/motionTokens";

/** Presents newly selected content without delaying its state, focus, or layout. */
export function useContentMotion(
  containerRef: RefObject<HTMLElement | null>,
  selection: number,
  selector?: string,
  enabled = true,
) {
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const previousSelection = useRef(selection);
  const interruptedTransform = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selection;
    const container = containerRef.current;
    if (!enabled || reduceMotion || document.hidden) {
      interruptedTransform.current = undefined;
      return;
    }
    if (!container || previous === selection || !container.animate) return;
    const targets = selector ? [...container.querySelectorAll<HTMLElement>(selector)] : [container];
    const direction = selection > previous ? 1 : -1;
    const animations = targets.map((target) => target.animate([
      { transform: interruptedTransform.current ?? `translateX(${direction * motionDistance.near}px)` },
      { transform: "translateX(0)" },
    ], { duration: motionDuration.standard, easing: motionEasing.enter }));
    const stop = () => animations.forEach((animation) => animation.cancel());
    const onVisibility = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      interruptedTransform.current = targets[0]?.isConnected && animations[0]?.playState === "running"
        ? getComputedStyle(targets[0]).transform : undefined;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [containerRef, enabled, reduceMotion, selection, selector]);
}
