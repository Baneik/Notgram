import { useEffect, useRef, useState } from "react";
import { asyncFeedbackTiming } from "../utils/motionTokens";

interface StableVisibilityOptions {
  showDelay?: number;
  minimumVisible?: number;
}

/** Prevents brief async work from flashing while keeping longer feedback legible. */
export const useStableVisibility = (
  active: boolean,
  {
    showDelay = asyncFeedbackTiming.showDelay,
    minimumVisible = asyncFeedbackTiming.minimumVisible,
  }: StableVisibilityOptions = {},
) => {
  const [visible, setVisible] = useState(active && showDelay === 0);
  const visibleRef = useRef(visible);
  const shownAtRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    if (active) {
      if (visibleRef.current) return;
      timer = globalThis.setTimeout(() => {
        shownAtRef.current = performance.now();
        visibleRef.current = true;
        setVisible(true);
      }, showDelay);
    } else if (visibleRef.current) {
      const elapsed = shownAtRef.current === undefined
        ? minimumVisible
        : performance.now() - shownAtRef.current;
      timer = globalThis.setTimeout(() => {
        shownAtRef.current = undefined;
        visibleRef.current = false;
        setVisible(false);
      }, Math.max(0, minimumVisible - elapsed));
    }
    return () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [active, minimumVisible, showDelay]);

  return visible;
};
