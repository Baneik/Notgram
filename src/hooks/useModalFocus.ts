import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const focusableElements = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");

export const useModalFocus = <T extends HTMLElement>(
  onClose: () => void,
  closeDisabled = false,
  initialFocusRef?: RefObject<HTMLElement | null>,
) => {
  const containerRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  closeRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const focusInitial = () => {
      const container = containerRef.current;
      if (!container) return;
      const target = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
      target.focus();
    };
    const timer = globalThis.setTimeout(focusInitial, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (event.key === "Escape" && !closeDisabledRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1)) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      globalThis.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [initialFocusRef]);

  return containerRef;
};
