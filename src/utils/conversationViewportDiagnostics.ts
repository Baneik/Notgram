import {
  isPerformanceMonitoringEnabled, logPerformance, subscribePerformanceMonitoring,
  type PerformanceDetails,
} from "./performanceMonitor";
import type { Message } from "../telegram/types";
import {
  createConversationTrace, registerConversationTrace, conversationTraceKind as kind,
  conversationTraceLimits as limits, conversationMessageShape,
} from "./conversationTrace";

export interface ConversationDiagnosticModel {
  messages: readonly Message[];
  indexes: ReadonlyMap<string, number>;
  firstItemIndex: number;
}
interface DiagnosticOptions {
  chatId: string;
  readModel: () => ConversationDiagnosticModel;
  readState: () => PerformanceDetails;
}

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
  options?: DiagnosticOptions,
) => {
  let stop: (() => void) | undefined;
  const sync = () => {
    stop?.();
    stop = isPerformanceMonitoringEnabled()
      ? startConversationViewportDiagnostics(list, readControl, options)
      : undefined;
  };
  const unsubscribe = subscribePerformanceMonitoring(sync);
  sync();
  return () => {
    unsubscribe();
    stop?.();
  };
};

const startConversationViewportDiagnostics = (
  list: HTMLElement,
  readControl: () => PerformanceDetails,
  options?: DiagnosticOptions,
) => {
  const trace = options ? createConversationTrace() : undefined;
  const unregister = trace && options ? registerConversationTrace(list, options.chatId, trace) : undefined;
  let previousSignature: string | undefined;
  let lastRowsAt = -Infinity;
  let snapshotId = 0;
  let members = new WeakMap<Element, string>();
  let sampledRun = 0;
  let frame: number | undefined;
  let stopped = false;
  let frameCount = 0;
  let previousTop = list.scrollTop;
  let previousDirection = 0;
  let reversals = 0;
  let minimumTop = Infinity, maximumTop = -Infinity;
  let minimumHeight = Infinity, maximumHeight = -Infinity;
  let minimumDistance = Infinity, maximumDistance = -Infinity;
  let controlSignature = "";
  const available = () => !stopped && list.isConnected && document.visibilityState !== "hidden" && list.clientHeight > 0;
  const readFrame = () => {
    frame = undefined;
    if (stopped || !trace?.active || !available()) return;
    const top = list.scrollTop, height = list.scrollHeight;
    const distance = height - list.clientHeight - top;
    const direction = Math.sign(top - previousTop);
    if (direction && previousDirection && direction !== previousDirection) reversals++;
    if (direction) previousDirection = direction;
    previousTop = top;
    minimumTop = Math.min(minimumTop, top); maximumTop = Math.max(maximumTop, top);
    minimumHeight = Math.min(minimumHeight, height); maximumHeight = Math.max(maximumHeight, height);
    minimumDistance = Math.min(minimumDistance, distance); maximumDistance = Math.max(maximumDistance, distance);
    frameCount++;
    frame = requestAnimationFrame(readFrame);
  };
  const sampleRows = () => {
    if (!trace || !options) return;
    const model = options.readModel();
    const byId = new Map(model.messages.map(message => [message.id, message]));
    const top = list.getBoundingClientRect().top;
    const rows = [...list.querySelectorAll<HTMLElement>(".message-list-content > [data-index]")].map(row => {
      const bounds = row.getBoundingClientRect();
      const known = Number(row.dataset.knownSize);
      return { row, bounds, known, error: Math.abs(known - bounds.height) };
    });
    // Always retain the tail, then prioritize bad measurements over healthy rows.
    const selected = [...rows.slice(-1), ...[...rows].sort((a, b) => b.error - a.error)]
      .filter((entry, index, all) => all.findIndex(item => item.row === entry.row) === index).slice(0, limits.rows);
    snapshotId++;
    for (const { row, bounds, known } of selected) {
      const messageRows = [...row.querySelectorAll<HTMLElement>("[data-message-id]")];
      const ids = messageRows.map(element => element.dataset.messageId!);
      const index = Number(row.dataset.index);
      const transform = getComputedStyle(row).transform;
      const matrix = transform === "none" ? undefined : new DOMMatrixReadOnly(transform);
      trace.detail("ui_conversation_row", {
        snapshotId, rowToken: trace.objectToken(row), blockIndex: index, itemIndex: Number(row.dataset.itemIndex),
        partitionToken: trace.token(`partition:${row.querySelector<HTMLElement>("[data-virtual-block-id]")?.dataset.virtualBlockId ?? ids[0] ?? ""}`),
        firstMessageToken: trace.token(ids[0] ? `message:${ids[0]}` : undefined),
        lastMessageToken: trace.token(ids.at(-1) ? `message:${ids.at(-1)}` : undefined),
        knownHeight: known, rowHeight: bounds.height, rowTop: bounds.top - top,
        rowWidth: bounds.width, rowOffsetTop: row.offsetTop, rowLayoutHeight: row.offsetHeight,
        transformY: matrix?.m42 ?? 0, scaleY: matrix?.m22 ?? 1,
        messageCount: ids.length, removingCount: messageRows.filter(element => element.classList.contains("is-removing")).length,
        mappingMismatch: ids.some(id => model.indexes.get(id) !== index),
        firstItemIndex: model.firstItemIndex, selectedRowCount: selected.length, mountedRowCount: rows.length,
      });
      const signature = `${index}:${ids.map(id => `${id}:${model.indexes.get(id)}`).join(",")}`;
      if (members.get(row) === signature) continue;
      members.set(row, signature);
      for (const id of ids.slice(0, 16)) {
        trace.detail("ui_conversation_member", {
          snapshotId, rowToken: trace.objectToken(row), messageToken: trace.token(`message:${id}`),
          expectedIndex: model.indexes.get(id), blockIndex: index,
          ...conversationMessageShape(byId.get(id)), memberCount: ids.length,
        });
      }
    }
  };
  const checkAnomaly = (details: PerformanceDetails) => {
    if (Number(details.measuredRowErrorPx) > 8) trace?.trigger(2);
    else if (details.followLatest && !details.pointerActive && !details.middleAutoScroll &&
      (Math.abs(Number(details.bottomDistancePx)) > 32 || Number(details.latestGapPx) < -8 || Number(details.viewportClipPx) > 8)) trace?.trigger(3);
  };
  const sample = () => {
    if (!available()) return;
    const details = { ...measureConversationViewport(list), ...readControl() };
    checkAnomaly(details);
    // Ordinary movement through a healthy list does not need a log each second.
    // Keep the raw scroll metrics in emitted evidence, but compare endpoint geometry.
    const { scrollTop: _top, scrollHeight: _height, ...geometry } = details;
    const signature = JSON.stringify(Object.values(geometry).map(value =>
      typeof value === "number" ? Math.round(value) : value,
    ));
    if (signature === previousSignature) return;
    previousSignature = signature;
    logPerformance("ui_conversation_viewport", { ...details, ...(trace ? { traceSession: trace.session } : {}) });
  };
  const pulse = () => {
    if (stopped || !trace) return;
    if (!trace.active) { trace.flush(); return; }
    if (sampledRun !== trace.run) {
      sampledRun = trace.run;
      members = new WeakMap();
      controlSignature = "";
      lastRowsAt = -Infinity;
    }
    if (frameCount) {
      trace.record(kind.frame, {
        sampleCount: frameCount, minimumTop, maximumTop, minimumHeight, maximumHeight,
        minimumDistance, maximumDistance, reversalCount: reversals,
      });
      frameCount = reversals = 0;
      minimumTop = minimumHeight = minimumDistance = Infinity;
      maximumTop = maximumHeight = maximumDistance = -Infinity;
    }
    const control = { ...readControl(), ...options?.readState() };
    const signature = JSON.stringify(control);
    if (signature !== controlSignature) { controlSignature = signature; trace.record(kind.control, control); }
    trace.flush();
    if (!trace.active || !available()) return;
    if (frame === undefined) frame = requestAnimationFrame(readFrame);
    if (performance.now() - lastRowsAt >= limits.rowIntervalMs) {
      lastRowsAt = performance.now();
      sampleRows();
    }
  };
  const scroll = (event: Event) => trace?.record(kind.scroll, {
    actualTop: list.scrollTop, scrollHeight: list.scrollHeight, trusted: event.isTrusted,
  });
  const input = (event: Event) => {
    const inputKind = ["wheel", "keydown", "pointerdown", "pointerup", "pointercancel"].indexOf(event.type) + 1;
    trace?.record(kind.input, {
      inputKind, trusted: event.isTrusted,
      direction: event instanceof WheelEvent ? Math.sign(event.deltaY) : undefined,
      button: event instanceof PointerEvent ? event.button : undefined,
      // Never record typed text or arbitrary keyboard values.
      keyKind: event instanceof KeyboardEvent ? ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].indexOf(event.key) + 1 : undefined,
    });
  };
  const visibility = () => trace?.record(kind.visibility, { pageVisible: !document.hidden, windowFocused: document.hasFocus() });
  const inputs = ["wheel", "keydown", "pointerdown", "pointerup", "pointercancel"];
  if (trace) {
    list.addEventListener("scroll", scroll, { passive: true });
    inputs.forEach(type => list.addEventListener(type, input, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", visibility);
    window.addEventListener("blur", visibility);
  }
  // Idle sampling remains one hertz. High-frequency reads exist only within a
  // bounded burst, and never call a virtualizer, resize observer, or scroll setter.
  const timer = globalThis.setInterval(sample, 1_000);
  const burstTimer = trace ? globalThis.setInterval(pulse, limits.flushIntervalMs) : undefined;
  return () => {
    stopped = true;
    globalThis.clearInterval(timer);
    if (burstTimer !== undefined) globalThis.clearInterval(burstTimer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    list.removeEventListener("scroll", scroll);
    inputs.forEach(type => list.removeEventListener(type, input, true));
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("focus", visibility);
    window.removeEventListener("blur", visibility);
    unregister?.();
  };
};
