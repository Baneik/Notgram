import { useEffect, useLayoutEffect, type RefObject } from "react";

const COMPOSER_TEXTAREA_MIN_HEIGHT = 40;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 290;

const resizeComposerInput = (input: HTMLTextAreaElement) => {
  input.style.height = `${COMPOSER_TEXTAREA_MIN_HEIGHT}px`;
  const contentHeight = input.scrollHeight;
  input.style.height = `${Math.min(
    COMPOSER_TEXTAREA_MAX_HEIGHT,
    Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, contentHeight),
  )}px`;
  input.style.overflowY = contentHeight > COMPOSER_TEXTAREA_MAX_HEIGHT
    ? "auto"
    : "hidden";
};

export const useComposerAutoResize = (
  inputRef: RefObject<HTMLTextAreaElement | null>,
  content: string,
  enabled: boolean,
  scope?: string,
) => {
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    resizeComposerInput(input);
  }, [content, enabled, inputRef, scope]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    const observer = new ResizeObserver(() => resizeComposerInput(input));
    observer.observe(input);
    return () => observer.disconnect();
  }, [enabled, inputRef, scope]);
};
