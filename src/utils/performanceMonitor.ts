import { invoke } from "@tauri-apps/api/core";

export type PerformanceValue = number | boolean | undefined;
export type PerformanceDetails = Record<string, PerformanceValue>;
export type PerformanceCategory = "startup" | "interaction" | "render" | "data" | "media";
export type PerformanceSeverity = "normal" | "warning" | "critical";

export interface PerformanceRecord {
  id: number;
  timestampMs: number;
  startTimeMs: number;
  event: string;
  label: string;
  category: PerformanceCategory;
  severity: PerformanceSeverity;
  durationMs?: number;
  details: Readonly<Record<string, number | boolean>>;
}

interface EventMetadata {
  label: string;
  category: PerformanceCategory;
  warningMs: number;
  criticalMs: number;
}

interface NativePerformanceRecord {
  event: string;
  details: Readonly<Record<string, number | boolean>>;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
  processingEnd: number;
  target?: Node | null;
}

interface LayoutShiftEntry extends PerformanceEntry {
  hadRecentInput: boolean;
  value: number;
}

interface LongAnimationFrameEntry extends PerformanceEntry {
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts?: Array<{ duration: number }>;
}

const MAX_RECORDS = 240;
const FRAME_BUDGET_MS = 1000 / 60;
const FRAME_DROP_THRESHOLD_MS = 50;
const FRAME_DROP_LOG_INTERVAL_MS = 1_000;
const HISTORY_CONTEXT_MS = 5_000;
const NATIVE_BATCH_SIZE = 20;
const NATIVE_FLUSH_DELAY_MS = 250;

const eventMetadata: Record<string, EventMetadata> = {
  ui_startup: { label: "应用启动", category: "startup", warningMs: 1_000, criticalMs: 2_500 },
  ui_slow_interaction: { label: "慢交互", category: "interaction", warningMs: 50, criticalMs: 100 },
  ui_long_frame: { label: "长动画帧", category: "render", warningMs: 50, criticalMs: 100 },
  ui_long_task: { label: "主线程长任务", category: "render", warningMs: 50, criticalMs: 100 },
  ui_frame_drop: { label: "掉帧", category: "render", warningMs: 50, criticalMs: 100 },
  ui_layout_shift: { label: "布局偏移", category: "render", warningMs: 20, criticalMs: 100 },
  ui_history_data: { label: "历史数据加载", category: "data", warningMs: 500, criticalMs: 1_500 },
  ui_history_merge: { label: "历史消息合并", category: "data", warningMs: 16, criticalMs: 50 },
  ui_history_render: { label: "历史消息渲染", category: "render", warningMs: 50, criticalMs: 100 },
  video_window_open_started: { label: "视频窗口打开", category: "media", warningMs: 250, criticalMs: 1_000 },
  video_window_descriptor_received: { label: "视频描述读取", category: "media", warningMs: 250, criticalMs: 1_000 },
  video_window_initialized: { label: "视频窗口初始化", category: "media", warningMs: 250, criticalMs: 1_000 },
  video_window_open_failed: { label: "视频窗口失败", category: "media", warningMs: 0, criticalMs: 1 },
};

let monitoringInstalled = false;
let historyInteractionStartedAt = Number.NEGATIVE_INFINITY;
let historyInteractionUntil = 0;
let nextRecordId = 1;
let records: readonly PerformanceRecord[] = [];
let lastFrameDropLogAt = Number.NEGATIVE_INFINITY;
let nativeFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let nativeFlushInFlight = false;
const pendingNativeRecords: NativePerformanceRecord[] = [];
const listeners = new Set<() => void>();
const pendingInteractions = new Map<number, EventTimingEntry>();
let interactionFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

const roundedDetails = (details: PerformanceDetails) => Object.fromEntries(
  Object.entries(details)
    .filter((entry): entry is [string, number | boolean] => entry[1] !== undefined)
    .slice(0, 16)
    .map(([key, value]) => [
      key,
      typeof value === "number" ? Math.round(value * 10) / 10 : value,
    ]),
);

const hasTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const recordDuration = (event: string, details: Readonly<Record<string, number | boolean>>) => {
  if (event === "ui_layout_shift") return undefined;
  if (typeof details.durationMs === "number") return details.durationMs;
  const durations = Object.entries(details)
    .filter(([key, value]) =>
      key !== "startTimeMs" && key.endsWith("Ms") && typeof value === "number"
    )
    .map(([, value]) => value as number);
  return durations.length > 0 ? Math.max(...durations) : undefined;
};

const flushNativePerformanceRecords = async () => {
  if (nativeFlushInFlight || pendingNativeRecords.length === 0) return;
  if (nativeFlushTimer !== undefined) {
    globalThis.clearTimeout(nativeFlushTimer);
    nativeFlushTimer = undefined;
  }
  const batch = pendingNativeRecords.splice(0, NATIVE_BATCH_SIZE);
  nativeFlushInFlight = true;
  try {
    await invoke("telegram_log_performance_batch", { records: batch });
  } catch {
    // Performance diagnostics are best-effort and must not affect interaction state.
  } finally {
    nativeFlushInFlight = false;
    if (pendingNativeRecords.length > 0) {
      if (pendingNativeRecords.length >= NATIVE_BATCH_SIZE) {
        void flushNativePerformanceRecords();
      } else {
        nativeFlushTimer = globalThis.setTimeout(
          () => void flushNativePerformanceRecords(),
          NATIVE_FLUSH_DELAY_MS,
        );
      }
    }
  }
};

const enqueueNativePerformanceRecord = (record: NativePerformanceRecord) => {
  pendingNativeRecords.push(record);
  if (pendingNativeRecords.length >= NATIVE_BATCH_SIZE && !nativeFlushInFlight) {
    void flushNativePerformanceRecords();
    return;
  }
  if (nativeFlushTimer === undefined && !nativeFlushInFlight) {
    nativeFlushTimer = globalThis.setTimeout(
      () => void flushNativePerformanceRecords(),
      NATIVE_FLUSH_DELAY_MS,
    );
  }
};

const appendRecord = (event: string, details: Readonly<Record<string, number | boolean>>) => {
  const metadata = eventMetadata[event];
  if (!metadata) return;
  const durationMs = recordDuration(event, details);
  const shiftScore = typeof details.shiftScore === "number" ? details.shiftScore : 0;
  const severity: PerformanceSeverity = event === "ui_layout_shift"
    ? shiftScore >= 0.1 ? "critical" : shiftScore >= 0.02 ? "warning" : "normal"
    : durationMs !== undefined && durationMs >= metadata.criticalMs
      ? "critical"
      : durationMs !== undefined && durationMs >= metadata.warningMs
        ? "warning"
        : "normal";
  const startTimeMs = typeof details.startTimeMs === "number"
    ? details.startTimeMs
    : performance.now();
  const next: PerformanceRecord = {
    id: nextRecordId++,
    timestampMs: Date.now(),
    startTimeMs,
    event,
    label: metadata.label,
    category: metadata.category,
    severity,
    durationMs,
    details,
  };
  records = [...records.slice(-(MAX_RECORDS - 1)), next];
  for (const listener of listeners) listener();
};

export const getPerformanceRecords = () => records;

export const subscribePerformanceRecords = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const clearPerformanceRecords = () => {
  records = [];
  for (const listener of listeners) listener();
};

export const logPerformance = (event: string, details: PerformanceDetails) => {
  const normalized = roundedDetails(details);
  appendRecord(event, normalized);
  if (import.meta.env.DEV) console.info(`[performance] ${event}`, normalized);
  if (hasTauriRuntime()) {
    enqueueNativePerformanceRecord({ event, details: normalized });
  }
};

export const markHistoryInteraction = () => {
  historyInteractionStartedAt = performance.now();
  historyInteractionUntil = historyInteractionStartedAt + HISTORY_CONTEXT_MS;
};

const duringHistoryLoad = (startTime = performance.now()) =>
  startTime >= historyInteractionStartedAt && startTime <= historyInteractionUntil;

const targetKind = (target?: Node | null) => {
  if (!(target instanceof Element)) return 0;
  const semanticTarget = target.closest("button, input, textarea, a, video, audio, img, li, [role]")
    ?? target;
  const tag = semanticTarget.tagName.toLowerCase();
  const role = semanticTarget.getAttribute("role");
  if (tag === "button" || role === "button") return 1;
  if (tag === "input" || tag === "textarea" || role === "textbox") return 2;
  if (tag === "a" || role === "link") return 3;
  if (tag === "video" || tag === "audio" || tag === "img") return 4;
  if (role === "listitem" || tag === "li") return 5;
  return 6;
};

const interactionKind = (name: string) => {
  if (name === "click") return 1;
  if (name.startsWith("key")) return 2;
  if (name.startsWith("pointer")) return 3;
  if (name.startsWith("input")) return 4;
  return 0;
};

const observe = (
  callback: (entries: PerformanceEntry[]) => void,
  options: PerformanceObserverInit,
) => {
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe(options);
    return true;
  } catch {
    return false;
  }
};

const installLongFrameObserver = () => {
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (supported.includes("long-animation-frame")) {
    return observe((entries) => {
      for (const entry of entries as LongAnimationFrameEntry[]) {
        const scriptDurationMs = entry.scripts?.reduce(
          (total, script) => total + script.duration,
          0,
        ) ?? 0;
        logPerformance("ui_long_frame", {
          startTimeMs: entry.startTime,
          durationMs: entry.duration,
          blockingDurationMs: entry.blockingDuration,
          scriptDurationMs,
          renderDurationMs: Math.max(0, entry.duration - scriptDurationMs),
          styleLayoutDurationMs: entry.styleAndLayoutStart > 0
            ? Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart)
            : 0,
          duringHistoryLoad: duringHistoryLoad(entry.startTime),
        });
      }
    }, { type: "long-animation-frame", buffered: true });
  }

  return observe((entries) => {
    for (const entry of entries) {
      logPerformance("ui_long_task", {
        startTimeMs: entry.startTime,
        durationMs: entry.duration,
        duringHistoryLoad: duringHistoryLoad(entry.startTime),
      });
    }
  }, { type: "longtask", buffered: true });
};

const logInteraction = (entry: EventTimingEntry) => {
    const inputDelayMs = Math.max(0, entry.processingStart - entry.startTime);
    const processingDurationMs = Math.max(0, entry.processingEnd - entry.processingStart);
    const presentationDelayMs = Math.max(
      0,
      entry.startTime + entry.duration - entry.processingEnd,
    );
    logPerformance("ui_slow_interaction", {
      startTimeMs: entry.startTime,
      durationMs: entry.duration,
      inputDelayMs,
      processingDurationMs,
      presentationDelayMs,
      interactionKind: interactionKind(entry.name),
      targetKind: targetKind(entry.target),
      duringHistoryLoad: duringHistoryLoad(entry.startTime),
    });
};

const flushPendingInteractions = () => {
  interactionFlushTimer = undefined;
  const entries = [...pendingInteractions.values()];
  pendingInteractions.clear();
  for (const entry of entries) logInteraction(entry);
};

const installInteractionObserver = () => observe((entries) => {
  for (const entry of entries as EventTimingEntry[]) {
    const interactionId = entry.interactionId;
    if (interactionId === undefined) {
      logInteraction(entry);
      continue;
    }
    const previous = pendingInteractions.get(interactionId);
    if (!previous || entry.duration > previous.duration) {
      pendingInteractions.set(interactionId, entry);
    }
  }
  if (pendingInteractions.size > 0 && interactionFlushTimer === undefined) {
    interactionFlushTimer = globalThis.setTimeout(flushPendingInteractions, 0);
  }
}, { type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);

const installLayoutShiftObserver = () => observe((entries) => {
  for (const entry of entries as LayoutShiftEntry[]) {
    if (entry.hadRecentInput || entry.value < 0.02) continue;
    logPerformance("ui_layout_shift", {
      startTimeMs: entry.startTime,
      shiftScore: entry.value,
      duringHistoryLoad: duringHistoryLoad(entry.startTime),
    });
  }
}, { type: "layout-shift", buffered: true });

const startFrameGapMonitor = () => {
  let previousFrameAt = performance.now();
  document.addEventListener("visibilitychange", () => {
    previousFrameAt = performance.now();
  });
  const sample = (now: number) => {
    const frameGapMs = now - previousFrameAt;
    previousFrameAt = now;
    if (
      document.visibilityState === "visible" &&
      frameGapMs >= FRAME_DROP_THRESHOLD_MS &&
      now - lastFrameDropLogAt >= FRAME_DROP_LOG_INTERVAL_MS
    ) {
      lastFrameDropLogAt = now;
      logPerformance("ui_frame_drop", {
        startTimeMs: now - frameGapMs,
        durationMs: frameGapMs,
        missedFrames: Math.max(1, Math.floor(frameGapMs / FRAME_BUDGET_MS) - 1),
        duringHistoryLoad: now <= historyInteractionUntil,
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

const logStartupTiming = () => {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!navigation) return;
  const paint = performance.getEntriesByName("first-contentful-paint")[0];
  logPerformance("ui_startup", {
    startTimeMs: 0,
    durationMs: navigation.loadEventEnd || performance.now(),
    domInteractiveMs: navigation.domInteractive,
    domContentLoadedMs: navigation.domContentLoadedEventEnd,
    loadEventMs: navigation.loadEventEnd,
    firstContentfulPaintMs: paint?.startTime,
  });
};

export const installPerformanceMonitoring = () => {
  if (monitoringInstalled || typeof window === "undefined") return;
  monitoringInstalled = true;
  if (typeof PerformanceObserver !== "undefined") {
    installLongFrameObserver();
    installInteractionObserver();
    installLayoutShiftObserver();
  }
  if (typeof requestAnimationFrame === "function") startFrameGapMonitor();
  if (document.readyState === "complete") setTimeout(logStartupTiming, 0);
  else window.addEventListener("load", () => setTimeout(logStartupTiming, 0), { once: true });
};
