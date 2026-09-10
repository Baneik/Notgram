import { logPerformance, type PerformanceDetails } from "./performanceMonitor";

/** Read geometry only. This observer must never participate in scroll ownership. */
export const measureConversationViewport = (list: HTMLElement) => {
  const viewport = list.getBoundingClientRect();
  let visibleBottom = viewport.bottom;
  let ancestorScrollTop = 0;
  for (let parent = list.parentElement; parent; parent = parent.parentElement) {
    ancestorScrollTop = Math.max(ancestorScrollTop, Math.abs(parent.scrollTop));
    if (getComputedStyle(parent).overflowY !== "visible") {
      visibleBottom = Math.min(visibleBottom, parent.getBoundingClientRect().bottom);
    }
  }
  const footer = list.querySelector<HTMLElement>(".message-list-end-sentinel")?.getBoundingClientRect();
  const latest = list.querySelectorAll<HTMLElement>("[data-message-id]");
  const latestBounds = latest.item(latest.length - 1)?.getBoundingClientRect();
  let measuredRowErrorPx = 0;
  const rows = list.querySelectorAll<HTMLElement>(".message-list-content > [data-index]");
  for (const row of rows) {
    const known = Number(row.dataset.knownSize);
    if (Number.isFinite(known)) {
      measuredRowErrorPx = Math.max(measuredRowErrorPx, Math.abs(known - row.getBoundingClientRect().height));
    }
  }
  return {
    scrollTop: list.scrollTop,
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    viewportHeight: viewport.height,
    bottomDistancePx: list.scrollHeight - list.clientHeight - list.scrollTop,
    viewportClipPx: viewport.bottom - visibleBottom,
    footerPresent: Boolean(footer),
    footerGapPx: footer ? visibleBottom - footer.bottom : undefined,
    footerHeight: footer?.height,
    latestGapPx: latestBounds ? visibleBottom - latestBounds.bottom : undefined,
    measuredRowErrorPx,
    mountedRowCount: rows.length,
    ancestorScrollTop,
    cssZoom: Number(getComputedStyle(document.documentElement).zoom) || 1,
    deviceScale: window.devicePixelRatio,
  };
};

export const observeConversationViewportDiagnostics = (
  list: HTMLElement,
  readControl: () => PerformanceDetails,
) => {
  let previousSignature: string | undefined;
  const sample = () => {
    if (!list.isConnected || document.visibilityState === "hidden" || list.clientHeight === 0) return;
    const details = { ...measureConversationViewport(list), ...readControl() };
    // Ordinary movement through a healthy list does not need a log each second.
    // Keep the raw scroll metrics in emitted evidence, but compare endpoint geometry.
    const { scrollTop: _top, scrollHeight: _height, ...geometry } = details;
    const signature = JSON.stringify(Object.values(geometry).map(value =>
      typeof value === "number" ? Math.round(value) : value,
    ));
    if (signature === previousSignature) return;
    previousSignature = signature;
    logPerformance("ui_conversation_viewport", details);
  };
  // Low-rate sampling also catches a native/virtual correction after a positioning
  // transaction has ended. There are no DOM writes, frame loops or layout observers.
  const timer = globalThis.setInterval(sample, 1_000);
  return () => globalThis.clearInterval(timer);
};
