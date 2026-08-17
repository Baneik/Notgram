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
  const previousTopRef = useRef(new Map<string, number>());
  const animationsRef = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLElement>(itemSelector)];
    const previousTop = previousTopRef.current;
    const nextTop = new Map<string, number>();
    items.forEach((item) => {
      const key = item.dataset.motionKey;
      if (key) nextTop.set(key, item.getBoundingClientRect().top);
    });
    if (previousTop.size > 0 && !reduceMotion && typeof HTMLElement.prototype.animate === "function") {
      items.forEach((item) => {
        const key = item.dataset.motionKey;
        if (!key) return;
        const oldTop = previousTop.get(key);
        const newTop = nextTop.get(key);
        if (oldTop === undefined || newTop === undefined) return;
        const deltaY = oldTop - newTop;
        if (Math.abs(deltaY) < 0.5) return;
        animationsRef.current.get(key)?.cancel();
        const animation = item.animate(
          [
            { transform: `translateY(${deltaY}px)` },
            { transform: "translateY(0)" },
          ],
          {
            duration: motionDuration.fast,
            easing: motionEasing.standard,
            fill: "both",
          },
        );
        animationsRef.current.set(key, animation);
        void animation.finished.then(() => {
          if (animationsRef.current.get(key) === animation) animationsRef.current.delete(key);
        }).catch(() => undefined);
      });
    }
    previousTopRef.current = nextTop;
    return () => {
      animationsRef.current.forEach((animation) => animation.cancel());
      animationsRef.current.clear();
    };
    // The caller owns the dependency values; they describe when list geometry changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, itemSelector, reduceMotion, ...dependencies]);
};
