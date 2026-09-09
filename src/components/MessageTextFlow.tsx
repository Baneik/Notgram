import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { observeLayout } from "../utils/layoutObservation";

const INLINE_META_LOWERING_PX = 2.5;

interface Props extends HTMLAttributes<HTMLDivElement> {
  forceWrapped?: boolean;
  onWrapChange?: (wrapped: boolean) => void;
}

/** Shares last-line metadata placement between text messages and media captions. */
export function MessageTextFlow({ children, className = "", style, forceWrapped = false, onWrapChange, ...props }: Props) {
  const textFlowRef = useRef<HTMLDivElement>(null);
  const [metaWrapped, setMetaWrapped] = useState(false);
  const [metaInlineOffset, setMetaInlineOffset] = useState(0);

  useLayoutEffect(() => {
    const flow = textFlowRef.current;
    if (forceWrapped || !flow) {
      if (forceWrapped) {
        setMetaWrapped(true);
        setMetaInlineOffset(0);
      }
      return;
    }

    const measure = () => {
      const text = flow.querySelector<HTMLElement>(".message-rich-text");
      const meta = flow.querySelector<HTMLElement>(".message-meta");
      if (!text) return;
      const isWrappedLayout = Boolean(meta) && flow.classList.contains("is-meta-wrapped");
      if (isWrappedLayout) flow.classList.remove("is-meta-wrapped");
      try {
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .sort((left, right) => left.top - right.top || left.left - right.left);
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
        const lastLine = rects.at(-1);
        if (!lastLine) return;
        const metaBounds = meta.getBoundingClientRect();
        const transform = getComputedStyle(meta).transform;
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
        if (isWrappedLayout) flow.classList.add("is-meta-wrapped");
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
  }, [children, forceWrapped]);

  useLayoutEffect(() => { onWrapChange?.(metaWrapped); }, [metaWrapped, onWrapChange]);

  return (
    <div {...props} ref={textFlowRef}
      className={`message-text-flow ${className} ${metaWrapped ? "is-meta-wrapped" : ""}`}
      style={{ ...style, "--message-meta-inline-offset": `${metaInlineOffset}px` } as CSSProperties}>
      {children}
    </div>
  );
}
