import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

const COMPOSER_TEXTAREA_MIN_HEIGHT = 40;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 290;

const measureComposerContentHeight = (input: HTMLTextAreaElement) => {
  const measurement = input.cloneNode(false) as HTMLTextAreaElement;
  measurement.value = input.value;
  measurement.removeAttribute("id");
  measurement.removeAttribute("name");
  measurement.setAttribute("aria-hidden", "true");
  measurement.tabIndex = -1;
  Object.assign(measurement.style, {
    position: "absolute",
    inset: "0 auto auto 0",
    width: `${input.getBoundingClientRect().width}px`,
    height: "0px",
    minHeight: "0px",
    maxHeight: "none",
    overflow: "hidden",
    visibility: "hidden",
    pointerEvents: "none",
  });
  input.parentElement?.append(measurement);
  const contentHeight = measurement.scrollHeight;
  measurement.remove();
  return contentHeight;
};

const resizeComposerInput = (input: HTMLTextAreaElement) => {
  const contentHeight = measureComposerContentHeight(input);
  const nextHeight = Math.min(
    COMPOSER_TEXTAREA_MAX_HEIGHT,
    Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, contentHeight),
  );
  const resized = input.getBoundingClientRect().height !== nextHeight;
  if (resized) {
    input.style.height = `${nextHeight}px`;
  }
  input.style.overflowY = contentHeight > COMPOSER_TEXTAREA_MAX_HEIGHT
    ? "auto"
    : "hidden";
  return resized;
};

export const useComposerAutoResize = (
  inputRef: RefObject<HTMLTextAreaElement | null>,
  content: string,
  enabled: boolean,
  scope?: string,
  onResize?: () => void,
) => {
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const resizeTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const resizeAndNotify = useCallback((input: HTMLTextAreaElement) => {
    if (resizeComposerInput(input)) onResize?.();
  }, [onResize]);
  const scheduleResize = useCallback((input: HTMLTextAreaElement) => {
    if (resizeFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(resizeFrameRef.current);
    }
    resizeFrameRef.current = globalThis.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      resizeAndNotify(input);
    });
  }, [resizeAndNotify]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    resizeAndNotify(input);
  }, [content, enabled, inputRef, resizeAndNotify, scope]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;
    const handleWindowResize = () => {
      if (resizeTimerRef.current !== undefined) {
        globalThis.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = globalThis.setTimeout(() => {
        resizeTimerRef.current = undefined;
        scheduleResize(input);
      }, 100);
    };
    globalThis.addEventListener("resize", handleWindowResize);
    return () => {
      globalThis.removeEventListener("resize", handleWindowResize);
      if (resizeTimerRef.current !== undefined) {
        globalThis.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = undefined;
      }
    };
  }, [enabled, inputRef, scheduleResize, scope]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(resizeFrameRef.current);
    }
    if (resizeTimerRef.current !== undefined) {
      globalThis.clearTimeout(resizeTimerRef.current);
    }
  }, []);
};
