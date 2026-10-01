import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { observeLayout } from "../utils/layoutObservation";
import { useConversationGeometry } from "./ConversationSurface";

const INLINE_META_LOWERING_PX = 2.5;
interface TextLayout { wrapped: boolean; offset: number }
interface CachedLayout { layout: TextLayout; fingerprint: string }
const layouts = new WeakMap<object, Map<string, CachedLayout>>();
const inlineLayout: TextLayout = { wrapped: false, offset: 0 };

interface Measurement {
  prepare: () => void;
  read: () => TextLayout;
  cleanup: () => void;
  commit: (layout: TextLayout) => void;
}
const pending = new Map<HTMLElement, () => Measurement | undefined>();
const active = new Map<HTMLElement, () => Measurement | undefined>();
export const MessageTextLayoutContext = createContext<(() => void) | undefined>(undefined);
let measurementFrame: number | undefined;
let resizeFlushQueued = false;

/** An explicit quote resize must finish metadata layout before its viewport
 * transaction measures the collapsed/expanded anchor. */
export const remeasureMessageText = (root: Element) => {
  active.forEach((measure, flow) => { if (root.contains(flow)) pending.set(flow, measure); });
  flushMessageTextMeasurements();
};

/** Read all live geometry before inserting probes, then read all probes before
 * removing any. React receives one batch after the layout reads have finished. */
export const flushMessageTextMeasurements = () => {
  if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame);
  measurementFrame = undefined;
  const tasks = [...pending.values()];
  pending.clear();
  const measurements = tasks.flatMap(task => task() ?? []);
  const results: TextLayout[] = [];
  try {
    measurements.forEach(measurement => measurement.prepare());
    measurements.forEach(measurement => results.push(measurement.read()));
  } finally {
    measurements.forEach(measurement => measurement.cleanup());
  }
  measurements.forEach((measurement, index) => measurement.commit(results[index]));
};

const scheduleMeasurement = (flow: HTMLElement, measure: () => Measurement | undefined) => {
  pending.set(flow, measure);
  measurementFrame ??= requestAnimationFrame(flushMessageTextMeasurements);
};

const rememberLayout = (source: object | undefined, key: string, value: CachedLayout) => {
  if (!source) return;
  let variants = layouts.get(source);
  if (!variants) { variants = new Map(); layouts.set(source, variants); }
  variants.delete(key);
  variants.set(key, value);
  if (variants.size > 8) variants.delete(variants.keys().next().value!);
};

interface Props extends HTMLAttributes<HTMLDivElement> {
  largeEmoji?: boolean;
  forceWrapped?: boolean;
  layoutSource?: object;
  layoutVersion?: string;
}

/** Content-owned numeric layout survives virtual unmounts without retaining DOM
 * or React callbacks. Changed content and geometry invalidate it independently. */
export function MessageTextFlow({ children, className = "", style, largeEmoji = false, forceWrapped = false,
  layoutSource, layoutVersion = "", ...props }: Props) {
  const geometry = useConversationGeometry();
  const onLayoutCommitted = useContext(MessageTextLayoutContext);
  const cacheKey = `${geometry.key}:${geometry.width}:${className}:${layoutVersion}:${largeEmoji}:${forceWrapped}`;
  const cached = layoutSource ? layouts.get(layoutSource)?.get(cacheKey) : undefined;
  const initial = forceWrapped ? { wrapped: true, offset: 0 } : largeEmoji ? inlineLayout : cached?.layout ?? inlineLayout;
  const [state, setState] = useState(() => ({ key: cacheKey, layout: initial }));
  const layout = state.key === cacheKey ? state.layout : initial;
  const textFlowRef = useRef<HTMLDivElement>(null);
  const lastMeasurement = useRef<CachedLayout | undefined>(undefined);
  const committedLayout = useRef(layout);
  useLayoutEffect(() => {
    if (committedLayout.current === layout) return;
    committedLayout.current = layout;
    onLayoutCommitted?.();
  }, [layout, onLayoutCommitted]);

  useLayoutEffect(() => {
    const flow = textFlowRef.current;
    if (!flow || forceWrapped || largeEmoji) return;
    const commit = (next: TextLayout) => setState(current => current.key === cacheKey &&
      current.layout.wrapped === next.wrapped && Math.abs(current.layout.offset - next.offset) < 0.25
      ? current : { key: cacheKey, layout: next });
    const measure = (): Measurement | undefined => {
      if (!flow.isConnected) return;
      const text = flow.querySelector<HTMLElement>(".message-rich-text");
      const meta = flow.querySelector<HTMLElement>(".message-meta");
      if (!text) return;
      const source = flow.parentElement?.matches(".message-bubble.is-textual")
        ? flow.closest<HTMLElement>(".message-row") ?? flow : flow;
      const width = getComputedStyle(source).width;
      const textStyle = getComputedStyle(text);
      const groupWidth = flow.closest<HTMLElement>(".message-group")?.clientWidth;
      const quoteState = [...text.querySelectorAll<HTMLElement>(".rich-blockquote")].map(quote => quote.dataset.quoteState).join(":");
      const fingerprint = `${cacheKey}:${width}:${groupWidth}:${flow.clientWidth}:${textStyle.font}:${textStyle.lineHeight}:${textStyle.direction}:${text.dataset.richText}:${text.innerHTML}:${quoteState}:${meta?.innerHTML ?? ""}`;
      const previous = lastMeasurement.current ?? (layoutSource ? layouts.get(layoutSource)?.get(cacheKey) : undefined);
      if (previous?.fingerprint === fingerprint) {
        commit(previous.layout);
        return;
      }
      let probe: HTMLElement | undefined;
      const fixedLayout = !meta ? inlineLayout : text.querySelector(".rich-blockquote.is-collapsed")
        ? { wrapped: true, offset: 0 } : undefined;
      return {
        prepare: () => {
          if (fixedLayout || !flow.classList.contains("is-meta-wrapped")) return;
          // Never unwrap the live row: shortening it can clamp the user's
          // scrollTop even when the original class is restored before paint.
          probe = source.cloneNode(true) as HTMLElement;
          const measuredFlow = source === flow ? probe : probe.querySelector<HTMLElement>(".message-text-flow")!;
          measuredFlow.classList.remove("is-meta-wrapped");
          probe.removeAttribute("id");
          probe.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
          probe.setAttribute("aria-hidden", "true");
          probe.inert = true;
          Object.assign(probe.style, { position: "fixed", inset: "0 auto auto 0", width, height: "auto",
            minHeight: "0", maxHeight: "none", margin: "0", visibility: "hidden", pointerEvents: "none" });
          source.parentElement!.append(probe);
        },
        read: () => {
          if (fixedLayout) return fixedLayout;
          const measuredText = probe?.querySelector<HTMLElement>(".message-rich-text") ?? text;
          const measuredMeta = probe?.querySelector<HTMLElement>(".message-meta") ?? meta!;
          const range = document.createRange();
          range.selectNodeContents(measuredText);
          let lastLine: DOMRect | undefined;
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0 && (!lastLine || rect.top > lastLine.top ||
              (rect.top === lastLine.top && rect.left > lastLine.left))) lastLine = rect;
          }
          if (!lastLine) return inlineLayout;
          const bounds = measuredMeta.getBoundingClientRect();
          const transform = getComputedStyle(measuredMeta).transform;
          const translatedY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
          const wrapped = bounds.top - translatedY > lastLine.top + 4;
          return { wrapped, offset: wrapped ? 0 : lastLine.bottom - (bounds.bottom - translatedY) + INLINE_META_LOWERING_PX };
        },
        cleanup: () => probe?.remove(),
        commit: next => {
          const result = { layout: next, fingerprint };
          lastMeasurement.current = result;
          rememberLayout(layoutSource, cacheKey, result);
          commit(next);
        },
      };
    };
    const schedule = () => scheduleMeasurement(flow, measure);
    active.set(flow, measure);
    schedule();
    const scheduleResize = () => {
      schedule();
      // observeLayout already batches callbacks in one animation frame. Drain
      // after that batch, before paint, instead of delaying corrections a frame.
      if (resizeFlushQueued) return;
      resizeFlushQueued = true;
      queueMicrotask(() => { resizeFlushQueued = false; flushMessageTextMeasurements(); });
    };
    const stops = [flow, flow.closest(".message-bubble-shell, .media-album"), flow.closest(".message-group")]
      .flatMap(element => element ? [observeLayout(element, scheduleResize)] : []);
    return () => { stops.forEach(stop => stop()); pending.delete(flow); active.delete(flow); };
  }, [children, cacheKey, forceWrapped, largeEmoji, layoutSource]);

  return <div {...props} ref={textFlowRef}
    className={`message-text-flow ${className} ${largeEmoji ? "is-large-emoji" : ""} ${layout.wrapped ? "is-meta-wrapped" : ""}`}
    style={{ ...style, "--message-meta-inline-offset": `${layout.offset}px` } as CSSProperties}>
    {children}
  </div>;
}
