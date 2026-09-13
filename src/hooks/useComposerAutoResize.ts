import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ComposerInputElement } from "../components/ComposerInput";

export const useComposerAutoResize = (
  inputRef: RefObject<ComposerInputElement | null>,
  content: string,
  enabled: boolean,
  scope?: string,
  onResize?: () => void,
) => {
  const previousHeight = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    const notify = () => {
      const height = input.getBoundingClientRect().height;
      if (height === previousHeight.current) return;
      previousHeight.current = height;
      onResize?.();
    };
    notify();
    const observer = new ResizeObserver(notify);
    observer.observe(input);
    return () => observer.disconnect();
  }, [content, enabled, inputRef, onResize, scope]);
};
