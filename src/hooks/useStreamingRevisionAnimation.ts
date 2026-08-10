import { useLayoutEffect, useRef, type RefObject } from "react";

const prefersReducedMotion = () =>
  document.documentElement.classList.contains("reduce-motion") ||
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export const useStreamingRevisionAnimation = (
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  revisionKey: string,
  targetSelector?: string,
) => {
  const previousRevisionRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const previousRevision = previousRevisionRef.current;
    previousRevisionRef.current = revisionKey;
    if (
      !active ||
      previousRevision === undefined ||
      previousRevision === revisionKey ||
      prefersReducedMotion()
    ) return;

    const container = containerRef.current;
    const target = targetSelector
      ? container?.querySelector<HTMLElement>(targetSelector)
      : container;
    if (!target || typeof target.animate !== "function") return;

    const animation = target.animate([
      { opacity: 0.72, transform: "translateY(2px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
    animation.id = "notgram-stream-revision";
    return () => animation.cancel();
  }, [active, containerRef, revisionKey, targetSelector]);
};
