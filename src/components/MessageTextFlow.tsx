import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { observeLayout } from "../utils/layoutObservation";

const INLINE_META_LOWERING_PX = 2.5;

const createInlineMeasurement = (flow: HTMLElement) => {
  // Text bubbles shrink to their contents. Include the row's sizing context so
  // an inline timestamp can grow the bubble again when more width is available.
  const source = flow.parentElement?.matches(".message-bubble.is-textual")
    ? flow.closest<HTMLElement>(".message-row") ?? flow
    : flow;
  const measurement = source.cloneNode(true) as HTMLElement;
  const measuredFlow = source === flow
    ? measurement
    : measurement.querySelector<HTMLElement>(".message-text-flow")!;
  measuredFlow.classList.remove("is-meta-wrapped");
  measurement.removeAttribute("id");
  measurement.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
  measurement.setAttribute("aria-hidden", "true");
  measurement.inert = true;
  Object.assign(measurement.style, {
    position: "fixed",
    inset: "0 auto auto 0",
    width: getComputedStyle(source).width,
    height: "auto",
    minHeight: "0",
    maxHeight: "none",
    margin: "0",
    visibility: "hidden",
    pointerEvents: "none",
  });
  source.parentElement!.append(measurement);
  return measurement;
};

interface Props extends HTMLAttributes<HTMLDivElement> {
  largeEmoji?: boolean;
  forceWrapped?: boolean;
  onWrapChange?: (wrapped: boolean) => void;
}

/** Shares last-line metadata placement between text messages and media captions. */
export function MessageTextFlow({ children, className = "", style, largeEmoji = false, forceWrapped = false, onWrapChange, ...props }: Props) {
  const textFlowRef = useRef<HTMLDivElement>(null);
  const [metaWrapped, setMetaWrapped] = useState(false);
  const [metaInlineOffset, setMetaInlineOffset] = useState(0);

  useLayoutEffect(() => {
    const flow = textFlowRef.current;
    // Emoji uses CSS grid alignment, not last-line text flow. Measuring its
    // bottom-aligned metadata as a float incorrectly reports a wrapped line.
    if (forceWrapped || largeEmoji || !flow) {
      setMetaWrapped(forceWrapped);
      setMetaInlineOffset(0);
      return;
    }

    const measure = () => {
      const text = flow.querySelector<HTMLElement>(".message-rich-text");
      const meta = flow.querySelector<HTMLElement>(".message-meta");
      if (!text) return;
      if (!meta) {
        setMetaWrapped(false);
        setMetaInlineOffset(0);
        return;
      }
      if (text.querySelector(".rich-blockquote.is-collapsed")) {
        setMetaWrapped(true);
        setMetaInlineOffset(0);
        return;
      }
      // Unwrapping a live flow can temporarily shorten the scroll extent and
      // clamp its ancestor's scrollTop, even if the class is restored before
      // paint. Probe the inline layout outside the flow instead. CSS width
      // preserves the same box sizing and avoids applying interface zoom twice.
      const measurement = flow.classList.contains("is-meta-wrapped")
        ? createInlineMeasurement(flow)
        : undefined;
      try {
        const measuredText = measurement?.querySelector<HTMLElement>(".message-rich-text") ?? text;
        const measuredMeta = measurement?.querySelector<HTMLElement>(".message-meta") ?? meta;
        const range = document.createRange();
        range.selectNodeContents(measuredText);
        const rects = [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .sort((left, right) => left.top - right.top || left.left - right.left);
        const lastLine = rects.at(-1);
        if (!lastLine) return;
        const metaBounds = measuredMeta.getBoundingClientRect();
        const transform = getComputedStyle(measuredMeta).transform;
        const translatedY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
        const wrapped = metaBounds.top - translatedY > lastLine.top + 4;
        setMetaWrapped((current) => current === wrapped ? current : wrapped);
        const inlineOffset = wrapped
          ? 0
          : lastLine.bottom - (metaBounds.bottom - translatedY) + INLINE_META_LOWERING_PX;
        setMetaInlineOffset((current) => Math.abs(current - inlineOffset) < 0.25
          ? current
          : inlineOffset);
      } finally {
        measurement?.remove();
      }
    };

    measure();
    const stopObservingFlow = observeLayout(flow, measure);
    const bubbleShell = flow.closest<HTMLElement>(".message-bubble-shell, .media-album");
    const stopObservingBubbleShell = bubbleShell
      ? observeLayout(bubbleShell, measure)
      : undefined;
    const layoutContainer = flow.closest<HTMLElement>(".message-group");
    let containerWidth = layoutContainer?.getBoundingClientRect().width;
    const measureWhenContainerWidthChanges = () => {
      if (!layoutContainer) return;
      const nextWidth = layoutContainer.getBoundingClientRect().width;
      if (containerWidth !== undefined && Math.abs(nextWidth - containerWidth) <= 0.5) return;
      containerWidth = nextWidth;
      measure();
    };
    const stopObservingContainer = layoutContainer
      ? observeLayout(layoutContainer, measureWhenContainerWidthChanges)
      : undefined;
    return () => {
      stopObservingFlow();
      stopObservingBubbleShell?.();
      stopObservingContainer?.();
    };
  }, [children, forceWrapped, largeEmoji]);

  useLayoutEffect(() => { onWrapChange?.(metaWrapped); }, [metaWrapped, onWrapChange]);

  return (
    <div {...props} ref={textFlowRef}
      className={`message-text-flow ${className} ${largeEmoji ? "is-large-emoji" : ""} ${metaWrapped ? "is-meta-wrapped" : ""}`}
      style={{ ...style, "--message-meta-inline-offset": `${metaInlineOffset}px` } as CSSProperties}>
      {children}
    </div>
  );
}
