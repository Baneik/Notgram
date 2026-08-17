import { useLayoutEffect, useRef, type RefObject } from "react";
import { usePreferencesStore } from "../store/preferencesStore";
import { motionDuration, motionEasing } from "../utils/motionTokens";

interface UseFlipListMotionOptions {
  containerRef: RefObject<HTMLElement | null>;
  itemSelector: string;
  dependencies: readonly unknown[];
}

/** Smooths small list reorders without changing layout ownership or scroll position. */
export const useFlipListMotion = ({
  containerRef,
  itemSelector,
  dependencies,
}: UseFlipListMotionOptions) => {
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const previousPositionRef = useRef(new Map<string, { left: number; top: number }>());
  const animationsRef = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLElement>(itemSelector)];
    const previousPosition = previousPositionRef.current;
    const nextPosition = new Map<string, { left: number; top: number }>();
    items.forEach((item) => {
      const key = item.dataset.motionKey;
      if (!key) return;
      const bounds = item.getBoundingClientRect();
      nextPosition.set(key, { left: bounds.left, top: bounds.top });
    });
    if (previousPosition.size > 0 && !reduceMotion && typeof HTMLElement.prototype.animate === "function") {
      items.forEach((item) => {
        const key = item.dataset.motionKey;
        if (!key) return;
        const oldPosition = previousPosition.get(key);
        const newPosition = nextPosition.get(key);
        if (!oldPosition || !newPosition) return;
        const deltaX = oldPosition.left - newPosition.left;
        const deltaY = oldPosition.top - newPosition.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
        animationsRef.current.get(key)?.cancel();
        const animation = item.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)` },
            { transform: "translate(0, 0)" },
          ],
          {
            duration: motionDuration.fast,
            easing: motionEasing.standard,
            fill: "both",
          },
        );
        animationsRef.current.set(key, animation);
        void animation.finished.then(() => {
          if (animationsRef.current.get(key) !== animation) return;
          animation.cancel();
          animationsRef.current.delete(key);
        }).catch(() => undefined);
      });
    }
    previousPositionRef.current = nextPosition;
    return () => {
      animationsRef.current.forEach((animation) => animation.cancel());
      animationsRef.current.clear();
    };
    // The caller owns the dependency values; they describe when list geometry changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, itemSelector, reduceMotion, ...dependencies]);
};
