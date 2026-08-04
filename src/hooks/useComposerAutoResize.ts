import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

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
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const scheduleResize = useCallback((input: HTMLTextAreaElement) => {
    if (resizeFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(resizeFrameRef.current);
    }
    resizeFrameRef.current = globalThis.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      resizeComposerInput(input);
    });
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    scheduleResize(input);
  }, [content, enabled, inputRef, scheduleResize, scope]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    const observer = new ResizeObserver(() => scheduleResize(input));
    observer.observe(input);
    return () => observer.disconnect();
  }, [enabled, inputRef, scheduleResize, scope]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(resizeFrameRef.current);
    }
  }, []);
};
