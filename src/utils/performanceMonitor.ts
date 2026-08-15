import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

export interface PersistedPerformanceRecord extends NativePerformanceRecord {
  timestampMs: number;
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
  sources?: LayoutShiftAttribution[];
}

interface LayoutShiftAttribution {
  node?: Node | null;
  previousRect: DOMRectReadOnly;
  currentRect: DOMRectReadOnly;
}

interface LongAnimationFrameEntry extends PerformanceEntry {
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts?: PerformanceScriptTiming[];
}

interface PerformanceScriptTiming {
  duration: number;
  forcedStyleAndLayoutDuration?: number;
  pauseDuration?: number;
  sourceURL?: string;
  sourceCharPosition?: number;
  invokerType?: string;
}

interface LongTaskEntry extends PerformanceEntry {
  attribution?: Array<{ containerType?: string }>;
}

interface NativeDisplayTiming {
  refreshRateHz: number;
  native: boolean;
}

export interface DisplayTiming {
  refreshRateHz: number;
  frameBudgetMs: number;
  sourceKind: number;
}

const MAX_RECORDS = 240;
const DEFAULT_REFRESH_RATE_HZ = 60;
const MIN_REFRESH_RATE_HZ = 24;
const MAX_REFRESH_RATE_HZ = 1_000;
const FRAME_DROP_MIN_MISSED_FRAMES = 2;
const FRAME_DROP_LOG_INTERVAL_MS = 1_000;
const HISTORY_CONTEXT_MS = 5_000;
const NATIVE_BATCH_SIZE = 20;
const NATIVE_FLUSH_DELAY_MS = 250;
const LAYOUT_SHIFT_AGGREGATION_MS = 250;
const DISPLAY_REFRESH_DEBOUNCE_MS = 250;
const RAF_CALIBRATION_SAMPLE_COUNT = 60;
const MAX_DETAIL_FIELDS = 48;
const CONVERSATION_TRACE_TIMEOUT_MS = 8_000;

export const performanceCauseDomains: Readonly<Record<number, string>> = {
  0: "未分类",
  1: "前端主线程",
  2: "前端渲染",
  3: "异步或后端等待",
  4: "监控链路",
  5: "视觉稳定性",
  6: "启动或媒体管线",
};

export const performanceCauseKinds: Readonly<Record<number, string>> = {
  0: "证据不足",
  1: "JavaScript 执行",
  2: "样式与布局",
  3: "浏览器呈现",
  4: "React 渲染",
  5: "虚拟列表或滚动定位",
  6: "异步数据或原生后端",
  7: "显示调度或合成",
  8: "后台窗口节流",
  9: "追踪阶段未完成",
  10: "输入排队",
  11: "媒体管线",
  12: "应用启动",
  13: "性能日志管线",
  14: "状态提交或调度",
};

export const performanceEvidenceKinds: Readonly<Record<number, string>> = {
  0: "应用计时",
  1: "Long Animation Frame",
  2: "Long Task",
  3: "Event Timing",
  4: "动画帧间隔",
  5: "Layout Shift",
  6: "React Profiler",
  7: "会话阶段追踪",
};

const REQUIRED_CONVERSATION_STAGE_MASK = 1 | 2 | 32 | 64 | 128;

export const conversationStageMaskLabels: Readonly<Record<number, string>> = {
  1: "选择提交",
  2: "数据就绪",
  4: "消息投影",
  8: "React 提交",
  16: "虚拟列表首帧",
  32: "滚动定位",
  64: "过渡开始",
  128: "视觉呈现",
};

export const conversationBottleneckStages: Readonly<Record<number, string>> = {
  0: "未确定",
  1: "选择提交",
  2: "数据等待",
  3: "消息投影",
  4: "React 提交",
  5: "虚拟列表",
  6: "滚动定位",
  7: "视觉呈现",
};

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
  ui_conversation_switch: { label: "会话切换", category: "interaction", warningMs: 100, criticalMs: 250 },
  ui_react_commit: { label: "React 提交", category: "render", warningMs: 16, criticalMs: 50 },
  ui_message_projection: { label: "消息投影", category: "render", warningMs: 8, criticalMs: 16 },
  ui_tdlib_update_batch: { label: "TDLib 更新处理", category: "data", warningMs: 16, criticalMs: 50 },
  ui_cache_snapshot: { label: "界面缓存快照", category: "data", warningMs: 16, criticalMs: 50 },
  ui_performance_log_drop: { label: "性能日志丢失", category: "data", warningMs: 0, criticalMs: 1 },
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

export const performanceWindowKind = (search?: string, pathname?: string) => {
  const resolvedSearch = search ?? (
    typeof window === "undefined" ? undefined : window.location.search
  );
  const resolvedPathname = pathname ?? (
    typeof window === "undefined" ? undefined : window.location.pathname
  );
  if (resolvedSearch === undefined && resolvedPathname === undefined) return 0;
  const legacyVideoRoute = new URLSearchParams(resolvedSearch).has("videoWindow");
  return legacyVideoRoute || resolvedPathname?.endsWith("/video-window.html") ? 2 : 1;
};

const performanceWindowId = (() => {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  }
  return Math.floor(Math.random() * 0xffff_ffff);
})();

type ConversationSwitchStage =
  | "selectionCommitted"
  | "dataReady"
  | "messageProjected"
  | "reactCommitted"
  | "virtuosoRange"
  | "positioned"
  | "transitionStarted"
  | "transitionFinished"
  | "asyncWaitStarted"
  | "asyncWaitFinished";

interface ConversationSwitchTrace {
  id: number;
  startedAt: number;
  cached: boolean;
  viewTransition: boolean;
  navigationKind: number;
  messageCount: number;
  blockCount: number;
  selectionCommittedAt?: number;
  dataReadyAt?: number;
  virtuosoRangeAt?: number;
  positionedAt?: number;
  transitionStartedAt?: number;
  transitionFinishedAt?: number;
  projectionDurationMs?: number;
  reactDurationMs?: number;
  asyncWaitStartedAt?: number;
  asyncWaitDepth: number;
  asyncWaitDurationMs: number;
  preSelectionAsyncWaitDurationMs: number;
  asyncWaitCount: number;
  asyncWaitFailed: boolean;
  mainThreadStallCount: number;
  mainThreadBlockedDurationMs: number;
  longestMainThreadStallMs: number;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

const conversationSwitchTraces = new Map<number, ConversationSwitchTrace>();
const conversationTraceWindows: Array<{ id: number; startedAt: number; finishedAt: number }> = [];
let nextConversationTraceId = 1;
let activeConversationTraceId: number | undefined;

let displayTiming: DisplayTiming = {
  refreshRateHz: DEFAULT_REFRESH_RATE_HZ,
  frameBudgetMs: 1_000 / DEFAULT_REFRESH_RATE_HZ,
  sourceKind: 0,
};
const displayTimingListeners = new Set<() => void>();

const isValidRefreshRate = (refreshRateHz: number) =>
  Number.isFinite(refreshRateHz) &&
  refreshRateHz >= MIN_REFRESH_RATE_HZ &&
  refreshRateHz <= MAX_REFRESH_RATE_HZ;

const updateDisplayTiming = (refreshRateHz: number, sourceKind: number) => {
  if (!isValidRefreshRate(refreshRateHz)) return false;
  const normalizedRate = Math.round(refreshRateHz * 10) / 10;
  if (
    sourceKind === 2 &&
    displayTiming.sourceKind === 2 &&
    Math.abs(displayTiming.refreshRateHz - normalizedRate) < 0.5
  ) return false;
  if (
    displayTiming.refreshRateHz === normalizedRate &&
    displayTiming.sourceKind === sourceKind
  ) return false;
  displayTiming = {
    refreshRateHz: normalizedRate,
    frameBudgetMs: 1_000 / normalizedRate,
    sourceKind,
  };
  for (const listener of displayTimingListeners) listener();
  return true;
};

export const getDisplayTiming = () => displayTiming;

export const subscribeDisplayTiming = (listener: () => void) => {
  displayTimingListeners.add(listener);
  return () => {
    displayTimingListeners.delete(listener);
  };
};

export const calculateFrameStats = (frameGapMs: number, refreshRateHz: number) => {
  const resolvedRate = isValidRefreshRate(refreshRateHz)
    ? refreshRateHz
    : DEFAULT_REFRESH_RATE_HZ;
  const frameBudgetMs = 1_000 / resolvedRate;
  const expectedFrames = Math.max(1, Math.floor((frameGapMs + frameBudgetMs * 0.1) / frameBudgetMs));
  return {
    frameBudgetMs,
    expectedFrames,
    missedFrames: Math.max(0, expectedFrames - 1),
  };
};

const roundedDetails = (details: PerformanceDetails) => Object.fromEntries(
  Object.entries(details)
    .filter((entry): entry is [string, number | boolean] => entry[1] !== undefined)
    .slice(0, MAX_DETAIL_FIELDS)
    .map(([key, value]) => {
      const precision = key === "shiftScore" || key === "maxShiftScore" ? 10_000 : 10;
      return [
        key,
        typeof value === "number" ? Math.round(value * precision) / precision : value,
      ];
    }),
);

const hasTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const currentPerformanceEnvironment = () => {
  const pageVisible = typeof document === "undefined" || document.visibilityState === "visible";
  const windowFocused = typeof document === "undefined" || document.hasFocus();
  const networkOnline = typeof navigator === "undefined" || navigator.onLine;
  return {
    refreshRateHz: displayTiming.refreshRateHz,
    frameBudgetMs: displayTiming.frameBudgetMs,
    refreshRateSource: displayTiming.sourceKind,
    pageVisible,
    windowFocused,
    networkOnline,
  };
};

interface PerformanceAttribution {
  causeDomain: number;
  causeKind: number;
  evidenceKind: number;
  uiStall: boolean;
  mainThreadBlocked: boolean;
}

const greatestDurationKey = (
  details: PerformanceDetails,
  keys: readonly string[],
) => keys.reduce<{ key: string; durationMs: number }>(
  (greatest, key) => {
    const value = details[key];
    return typeof value === "number" && value > greatest.durationMs
      ? { key, durationMs: value }
      : greatest;
  },
  { key: "", durationMs: 0 },
);

const performanceAttribution = (
  event: string,
  details: PerformanceDetails,
  environment: ReturnType<typeof currentPerformanceEnvironment>,
): PerformanceAttribution => {
  const durationMs = typeof details.durationMs === "number" ? details.durationMs : 0;
  const exceedsFrameBudget = durationMs > environment.frameBudgetMs * 1.5;
  if (event === "ui_long_frame") {
    const scriptDurationMs = Number(details.scriptDurationMs ?? 0);
    const styleLayoutDurationMs = Number(details.styleLayoutDurationMs ?? 0);
    const scriptDominates = scriptDurationMs > 0 && scriptDurationMs >= styleLayoutDurationMs;
    return {
      causeDomain: scriptDominates ? 1 : 2,
      causeKind: scriptDominates ? 1 : styleLayoutDurationMs > 0 ? 2 : 3,
      evidenceKind: 1,
      uiStall: true,
      mainThreadBlocked: true,
    };
  }
  if (event === "ui_long_task") {
    return { causeDomain: 1, causeKind: 1, evidenceKind: 2, uiStall: true, mainThreadBlocked: true };
  }
  if (event === "ui_frame_drop") {
    const foreground = environment.pageVisible && environment.windowFocused;
    return {
      causeDomain: 2,
      causeKind: foreground ? 7 : 8,
      evidenceKind: 4,
      uiStall: foreground,
      mainThreadBlocked: false,
    };
  }
  if (event === "ui_slow_interaction") {
    const greatest = greatestDurationKey(details, [
      "inputDelayMs",
      "processingDurationMs",
      "presentationDelayMs",
    ]);
    const processing = greatest.key === "processingDurationMs";
    return {
      causeDomain: greatest.key === "presentationDelayMs" ? 2 : 1,
      causeKind: greatest.key === "inputDelayMs" ? 10 : processing ? 1 : 3,
      evidenceKind: 3,
      uiStall: true,
      mainThreadBlocked: processing && greatest.durationMs > environment.frameBudgetMs,
    };
  }
  if (event === "ui_layout_shift") {
    return { causeDomain: 5, causeKind: 2, evidenceKind: 5, uiStall: true, mainThreadBlocked: false };
  }
  if (event === "ui_conversation_switch") {
    const mainThreadBlocked = Number(details.mainThreadBlockedDurationMs ?? 0) > 0;
    const timedOut = details.timedOut === true || details.cancelled === true;
    const hasAsyncWait = Number(details.asyncWaitDurationMs ?? 0) > 0;
    const bottleneckStage = Number(details.bottleneckStage ?? 0);
    if (mainThreadBlocked) {
      return { causeDomain: 1, causeKind: 1, evidenceKind: 7, uiStall: true, mainThreadBlocked: true };
    }
    if (
      hasAsyncWait &&
      ((timedOut && details.asyncWaitInFlight === true) || bottleneckStage === 2)
    ) {
      return { causeDomain: 3, causeKind: 6, evidenceKind: 7, uiStall: false, mainThreadBlocked: false };
    }
    if (timedOut) {
      return { causeDomain: 4, causeKind: 9, evidenceKind: 7, uiStall: false, mainThreadBlocked: false };
    }
    if (bottleneckStage === 2) {
      return { causeDomain: 2, causeKind: 14, evidenceKind: 7, uiStall: exceedsFrameBudget, mainThreadBlocked: false };
    }
    if (bottleneckStage === 3 || bottleneckStage === 4) {
      return {
        causeDomain: 1,
        causeKind: bottleneckStage === 4 ? 4 : 1,
        evidenceKind: 7,
        uiStall: exceedsFrameBudget,
        mainThreadBlocked: false,
      };
    }
    return {
      causeDomain: 2,
      causeKind: bottleneckStage === 5 || bottleneckStage === 6 ? 5 : 3,
      evidenceKind: 7,
      uiStall: exceedsFrameBudget,
      mainThreadBlocked: false,
    };
  }
  if (event === "ui_history_data") {
    return { causeDomain: 3, causeKind: 6, evidenceKind: 0, uiStall: false, mainThreadBlocked: false };
  }
  if (event === "ui_react_commit") {
    return {
      causeDomain: 1,
      causeKind: 4,
      evidenceKind: 6,
      uiStall: exceedsFrameBudget,
      mainThreadBlocked: exceedsFrameBudget,
    };
  }
  if (["ui_history_merge", "ui_message_projection", "ui_tdlib_update_batch", "ui_cache_snapshot"]
    .includes(event)) {
    return {
      causeDomain: 1,
      causeKind: 1,
      evidenceKind: 0,
      uiStall: exceedsFrameBudget,
      mainThreadBlocked: exceedsFrameBudget,
    };
  }
  if (event === "ui_history_render") {
    return {
      causeDomain: 2,
      causeKind: 5,
      evidenceKind: 0,
      uiStall: exceedsFrameBudget,
      mainThreadBlocked: false,
    };
  }
  if (event === "ui_performance_log_drop") {
    return { causeDomain: 4, causeKind: 13, evidenceKind: 0, uiStall: false, mainThreadBlocked: false };
  }
  if (event === "ui_startup") {
    return { causeDomain: 6, causeKind: 12, evidenceKind: 0, uiStall: false, mainThreadBlocked: false };
  }
  if (event.startsWith("video_window_")) {
    return { causeDomain: 6, causeKind: 11, evidenceKind: 0, uiStall: false, mainThreadBlocked: false };
  }
  return { causeDomain: 0, causeKind: 0, evidenceKind: 0, uiStall: false, mainThreadBlocked: false };
};

const recordDuration = (event: string, details: Readonly<Record<string, number | boolean>>) => {
  if (event === "ui_layout_shift") return undefined;
  if (typeof details.durationMs === "number") return details.durationMs;
  const durations = Object.entries(details)
    .filter(([key, value]) =>
      !["startTimeMs", "observedAtMs", "frameBudgetMs"].includes(key) &&
      key.endsWith("Ms") &&
      typeof value === "number"
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

const recordFingerprint = (
  event: string,
  timestampMs: number,
  details: Readonly<Record<string, number | boolean>>,
) => JSON.stringify([
  event,
  timestampMs,
  Object.entries(details).sort(([left], [right]) => left.localeCompare(right)),
]);

const createRecord = (
  event: string,
  details: Readonly<Record<string, number | boolean>>,
  timestampMs = typeof details.observedAtMs === "number" ? details.observedAtMs : Date.now(),
) => {
  const metadata = eventMetadata[event];
  if (!metadata) return undefined;
  const durationMs = recordDuration(event, details);
  const shiftScore = typeof details.shiftScore === "number" ? details.shiftScore : 0;
  const missedFrames = typeof details.missedFrames === "number" ? details.missedFrames : 0;
  const traceTimedOutWithoutUiStall = event === "ui_conversation_switch" &&
    details.timedOut === true && details.causeDomain === 4;
  const traceCancelledWithoutUiStall = event === "ui_conversation_switch" &&
    details.cancelled === true && details.causeDomain === 4;
  const severity: PerformanceSeverity = event === "ui_layout_shift"
    ? shiftScore >= 0.1 ? "critical" : shiftScore >= 0.02 ? "warning" : "normal"
    : event === "ui_frame_drop"
      ? missedFrames >= 6 ? "critical" : missedFrames >= FRAME_DROP_MIN_MISSED_FRAMES ? "warning" : "normal"
      : traceTimedOutWithoutUiStall
        ? "warning"
        : traceCancelledWithoutUiStall
          ? "normal"
          : durationMs !== undefined && durationMs >= metadata.criticalMs
            ? "critical"
            : durationMs !== undefined && durationMs >= metadata.warningMs
              ? "warning"
              : "normal";
  const startTimeMs = typeof details.startTimeMs === "number"
    ? details.startTimeMs
    : performance.now();
  return {
    id: nextRecordId++,
    timestampMs,
    startTimeMs,
    event,
    label: metadata.label,
    category: metadata.category,
    severity,
    durationMs,
    details,
  } satisfies PerformanceRecord;
};

const appendRecord = (event: string, details: Readonly<Record<string, number | boolean>>) => {
  const next = createRecord(event, details);
  if (!next) return;
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
  for (const trace of conversationSwitchTraces.values()) globalThis.clearTimeout(trace.timeout);
  conversationSwitchTraces.clear();
  conversationTraceWindows.length = 0;
  activeConversationTraceId = undefined;
  nextConversationTraceId = 1;
  for (const listener of listeners) listener();
};

export const mergePersistedPerformanceRecords = (
  persistedRecords: readonly PersistedPerformanceRecord[],
) => {
  const known = new Set(records.map((record) =>
    recordFingerprint(record.event, record.timestampMs, record.details)));
  const additions: PerformanceRecord[] = [];
  for (const persisted of persistedRecords) {
    if (
      !Number.isFinite(persisted.timestampMs) ||
      !persisted.details ||
      typeof persisted.details !== "object"
    ) continue;
    const details = roundedDetails(persisted.details);
    const fingerprint = recordFingerprint(persisted.event, persisted.timestampMs, details);
    if (known.has(fingerprint)) continue;
    const record = createRecord(persisted.event, details, persisted.timestampMs);
    if (!record) continue;
    known.add(fingerprint);
    additions.push(record);
  }
  if (additions.length === 0) return records;
  records = [...records, ...additions]
    .sort((left, right) => left.timestampMs - right.timestampMs || left.id - right.id)
    .slice(-MAX_RECORDS);
  for (const listener of listeners) listener();
  return records;
};

export const refreshPersistedPerformanceRecords = async () => {
  if (!hasTauriRuntime()) return records;
  const persisted = await invoke<PersistedPerformanceRecord[]>(
    "telegram_read_performance_records",
  );
  return mergePersistedPerformanceRecords(persisted);
};

export const clearPersistedPerformanceRecords = async () => {
  if (nativeFlushTimer !== undefined) {
    globalThis.clearTimeout(nativeFlushTimer);
    nativeFlushTimer = undefined;
  }
  pendingNativeRecords.length = 0;
  if (hasTauriRuntime()) await invoke("telegram_clear_performance_records");
};

export const logPerformance = (event: string, details: PerformanceDetails) => {
  const environment = currentPerformanceEnvironment();
  const attribution = performanceAttribution(event, details, environment);
  const normalized = roundedDetails({
    ...details,
    ...attribution,
    ...environment,
    observedAtMs: Date.now(),
    windowKind: performanceWindowKind(),
    windowId: performanceWindowId,
  });
  appendRecord(event, normalized);
  if (import.meta.env.DEV) console.info(`[performance] ${event}`, normalized);
  if (hasTauriRuntime()) {
    enqueueNativePerformanceRecord({ event, details: normalized });
  }
};

const elapsed = (later: number | undefined, earlier: number | undefined) =>
  later !== undefined && earlier !== undefined ? Math.max(0, later - earlier) : undefined;

const conversationStageMask = (trace: ConversationSwitchTrace) =>
  (trace.selectionCommittedAt !== undefined ? 1 : 0) |
  (trace.dataReadyAt !== undefined ? 2 : 0) |
  (trace.projectionDurationMs !== undefined ? 4 : 0) |
  (trace.reactDurationMs !== undefined ? 8 : 0) |
  (trace.virtuosoRangeAt !== undefined ? 16 : 0) |
  (trace.positionedAt !== undefined ? 32 : 0) |
  (trace.transitionStartedAt !== undefined ? 64 : 0) |
  (trace.transitionFinishedAt !== undefined ? 128 : 0);

const finishConversationSwitch = (
  trace: ConversationSwitchTrace,
  options: { timedOut?: boolean; cancelled?: boolean } = {},
) => {
  globalThis.clearTimeout(trace.timeout);
  conversationSwitchTraces.delete(trace.id);
  const traceWindow = conversationTraceWindows.find((window) => window.id === trace.id);
  if (traceWindow) traceWindow.finishedAt = performance.now() + 500;
  if (activeConversationTraceId === trace.id) activeConversationTraceId = undefined;

  const observedAt = performance.now();
  const finishedAt = Math.max(
    trace.positionedAt ?? trace.startedAt,
    trace.transitionFinishedAt ?? trace.startedAt,
    observedAt,
  );
  const selectionElapsedMs = elapsed(trace.selectionCommittedAt, trace.startedAt);
  const dataDurationMs = elapsed(trace.dataReadyAt, trace.selectionCommittedAt);
  const virtualListDurationMs = elapsed(trace.virtuosoRangeAt, trace.dataReadyAt);
  const positionDurationMs = elapsed(
    trace.positionedAt,
    trace.virtuosoRangeAt ?? trace.dataReadyAt,
  );
  const transitionDurationMs = elapsed(
    trace.transitionFinishedAt,
    trace.transitionStartedAt,
  );
  const visualResponseDurationMs = transitionDurationMs;
  const frontendWorkDurationMs =
    (trace.projectionDurationMs ?? 0) + (trace.reactDurationMs ?? 0);
  const asyncWaitInFlight = trace.asyncWaitStartedAt !== undefined;
  const asyncWaitDurationMs = trace.asyncWaitDurationMs + (
    trace.asyncWaitStartedAt === undefined ? 0 : finishedAt - trace.asyncWaitStartedAt
  );
  const preSelectionAsyncWaitDurationMs = trace.preSelectionAsyncWaitDurationMs + (
    trace.selectionCommittedAt === undefined && trace.asyncWaitStartedAt !== undefined
      ? finishedAt - trace.asyncWaitStartedAt
      : 0
  );
  const selectionDurationMs = selectionElapsedMs === undefined
    ? undefined
    : Math.max(0, selectionElapsedMs - preSelectionAsyncWaitDurationMs);
  const latestCompletedAt = Math.max(
    trace.startedAt,
    trace.selectionCommittedAt ?? trace.startedAt,
    trace.dataReadyAt ?? trace.startedAt,
    trace.virtuosoRangeAt ?? trace.startedAt,
    trace.positionedAt ?? trace.startedAt,
    trace.transitionStartedAt ?? trace.startedAt,
    trace.transitionFinishedAt ?? trace.startedAt,
  );
  const completedStageMask = conversationStageMask(trace);
  const candidates = [
    [1, selectionDurationMs],
    [2, Math.max(dataDurationMs ?? 0, asyncWaitDurationMs)],
    [3, trace.projectionDurationMs],
    [4, trace.reactDurationMs],
    [5, virtualListDurationMs],
    [6, positionDurationMs],
    [7, transitionDurationMs],
  ] as const;
  const bottleneck = candidates.reduce<{ stage: number; duration: number }>(
    (current, [stage, duration]) => duration !== undefined && duration > current.duration
      ? { stage, duration }
      : current,
    { stage: 0, duration: 0 },
  );

  logPerformance("ui_conversation_switch", {
    startTimeMs: trace.startedAt,
    durationMs: finishedAt - trace.startedAt,
    traceId: trace.id,
    cached: trace.cached,
    viewTransition: trace.viewTransition,
    navigationKind: trace.navigationKind,
    messageCount: trace.messageCount,
    blockCount: trace.blockCount,
    selectionDurationMs,
    dataDurationMs,
    projectionDurationMs: trace.projectionDurationMs,
    reactDurationMs: trace.reactDurationMs,
    frontendWorkDurationMs,
    visualResponseDurationMs,
    asyncWaitDurationMs,
    asyncWaitCount: trace.asyncWaitCount,
    asyncWaitInFlight,
    asyncWaitFailed: trace.asyncWaitFailed,
    traceWaitDurationMs: options.timedOut && !asyncWaitInFlight
      ? finishedAt - latestCompletedAt
      : undefined,
    mainThreadBlockedDurationMs: trace.mainThreadBlockedDurationMs,
    longestMainThreadStallMs: trace.longestMainThreadStallMs,
    mainThreadStallCount: trace.mainThreadStallCount,
    virtualListDurationMs,
    positionDurationMs,
    transitionDurationMs,
    bottleneckStage: bottleneck.stage,
    bottleneckDurationMs: bottleneck.duration,
    completedStageMask,
    missingStageMask: REQUIRED_CONVERSATION_STAGE_MASK & ~completedStageMask,
    timedOut: options.timedOut,
    cancelled: options.cancelled,
  });
};

const maybeFinishConversationSwitch = (trace: ConversationSwitchTrace) => {
  if (
    trace.selectionCommittedAt !== undefined &&
    trace.dataReadyAt !== undefined &&
    trace.positionedAt !== undefined &&
    trace.transitionFinishedAt !== undefined
  ) {
    finishConversationSwitch(trace);
  }
};

export const beginConversationSwitch = (details: {
  cached: boolean;
  messageCount: number;
  viewTransition: boolean;
  navigationKind: number;
}) => {
  if (activeConversationTraceId !== undefined) {
    const active = conversationSwitchTraces.get(activeConversationTraceId);
    if (active) finishConversationSwitch(active, { cancelled: true });
  }
  const id = nextConversationTraceId++;
  const startedAt = performance.now();
  historyInteractionStartedAt = startedAt - 250;
  historyInteractionUntil = startedAt + CONVERSATION_TRACE_TIMEOUT_MS;
  const trace: ConversationSwitchTrace = {
    id,
    startedAt,
    cached: details.cached,
    viewTransition: details.viewTransition,
    navigationKind: details.navigationKind,
    messageCount: details.messageCount,
    blockCount: 0,
    asyncWaitDurationMs: 0,
    asyncWaitDepth: 0,
    asyncWaitCount: 0,
    asyncWaitFailed: false,
    preSelectionAsyncWaitDurationMs: 0,
    mainThreadStallCount: 0,
    mainThreadBlockedDurationMs: 0,
    longestMainThreadStallMs: 0,
    timeout: globalThis.setTimeout(() => {
      const pending = conversationSwitchTraces.get(id);
      if (pending) finishConversationSwitch(pending, { timedOut: true });
    }, CONVERSATION_TRACE_TIMEOUT_MS),
  };
  conversationSwitchTraces.set(id, trace);
  conversationTraceWindows.push({
    id,
    startedAt: startedAt - 250,
    finishedAt: Number.POSITIVE_INFINITY,
  });
  if (conversationTraceWindows.length > 20) conversationTraceWindows.shift();
  activeConversationTraceId = id;
  return id;
};

export const markConversationSwitch = (
  traceId: number | undefined,
  stage: ConversationSwitchStage,
  details: {
    durationMs?: number;
    messageCount?: number;
    blockCount?: number;
    failed?: boolean;
  } = {},
) => {
  if (traceId === undefined) return;
  const trace = conversationSwitchTraces.get(traceId);
  if (!trace) return;
  const now = performance.now();
  if (details.messageCount !== undefined) trace.messageCount = details.messageCount;
  if (details.blockCount !== undefined) trace.blockCount = details.blockCount;
  if (stage === "selectionCommitted") trace.selectionCommittedAt ??= now;
  else if (stage === "dataReady") trace.dataReadyAt ??= now;
  else if (stage === "messageProjected") {
    trace.projectionDurationMs = Math.max(
      trace.projectionDurationMs ?? 0,
      details.durationMs ?? 0,
    );
  } else if (stage === "reactCommitted") {
    trace.reactDurationMs = Math.max(trace.reactDurationMs ?? 0, details.durationMs ?? 0);
  } else if (stage === "asyncWaitStarted") {
    if (trace.asyncWaitDepth === 0) trace.asyncWaitStartedAt = now;
    trace.asyncWaitDepth += 1;
    trace.asyncWaitCount += 1;
  } else if (stage === "asyncWaitFinished") {
    trace.asyncWaitDepth = Math.max(0, trace.asyncWaitDepth - 1);
    if (trace.asyncWaitDepth === 0 && trace.asyncWaitStartedAt !== undefined) {
      const waitDurationMs = now - trace.asyncWaitStartedAt;
      trace.asyncWaitDurationMs += waitDurationMs;
      if (trace.selectionCommittedAt === undefined) {
        trace.preSelectionAsyncWaitDurationMs += waitDurationMs;
      }
      trace.asyncWaitStartedAt = undefined;
    }
    trace.asyncWaitFailed ||= details.failed === true;
  } else if (stage === "virtuosoRange") trace.virtuosoRangeAt ??= now;
  else if (stage === "positioned") trace.positionedAt = now;
  else if (stage === "transitionStarted") trace.transitionStartedAt ??= now;
  else if (stage === "transitionFinished") trace.transitionFinishedAt ??= now;
  maybeFinishConversationSwitch(trace);
};

export const isConversationSwitchActive = (traceId: number | undefined) =>
  traceId !== undefined && conversationSwitchTraces.has(traceId);

export const getActiveConversationTraceId = () => activeConversationTraceId;

const conversationTraceIdAt = (startTime: number) => {
  for (let index = conversationTraceWindows.length - 1; index >= 0; index -= 1) {
    const trace = conversationTraceWindows[index];
    if (trace && startTime >= trace.startedAt && startTime <= trace.finishedAt) return trace.id;
  }
  return undefined;
};

const attributeMainThreadStall = (
  startTime: number,
  durationMs: number,
  blockingDurationMs: number,
) => {
  const traceId = conversationTraceIdAt(startTime);
  if (traceId === undefined) return;
  const trace = conversationSwitchTraces.get(traceId);
  if (!trace) return;
  trace.mainThreadStallCount += 1;
  trace.mainThreadBlockedDurationMs += Math.max(0, blockingDurationMs);
  trace.longestMainThreadStallMs = Math.max(trace.longestMainThreadStallMs, durationMs);
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

const regionKind = (target?: Node | null) => {
  if (!(target instanceof Element)) return 0;
  if (target.closest(".chat-sidebar, .chat-list, .chat-row")) return 1;
  if (target.closest(".conversation, .conversation-shell, .message-list, .message-list-content")) return 2;
  if (target.closest(".conversation-composer, .composer")) return 3;
  if (target.closest(".settings-dialog, .settings-detail")) return 4;
  if (target.closest("video, audio, .video-player, .media-viewer")) return 5;
  if (target.closest("nav, header, .app-chrome, .window-chrome")) return 6;
  return 7;
};

const scriptSourceKind = (sourceURL?: string) => {
  if (!sourceURL) return 0;
  if (sourceURL.startsWith("chrome-extension:") || sourceURL.startsWith("edge-extension:")) return 3;
  if (sourceURL.startsWith("tauri:") || sourceURL.startsWith("http://tauri.localhost")) return 1;
  if (typeof location !== "undefined" && sourceURL.startsWith(location.origin)) return 1;
  return 2;
};

const scriptInvokerKind = (invokerType?: string) => {
  if (invokerType === "event-listener") return 1;
  if (invokerType === "resolve-promise") return 2;
  if (invokerType === "classic-script" || invokerType === "module-script") return 3;
  if (invokerType === "user-callback") return 4;
  return 0;
};

const longTaskContainerKind = (containerType?: string) => {
  if (containerType === "window") return 1;
  if (containerType === "iframe") return 2;
  if (containerType === "embed" || containerType === "object") return 3;
  return 0;
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
        const scripts = entry.scripts ?? [];
        const scriptDurationMs = scripts.reduce(
          (total, script) => total + script.duration,
          0,
        );
        const forcedStyleLayoutDurationMs = scripts.reduce(
          (total, script) => total + (script.forcedStyleAndLayoutDuration ?? 0),
          0,
        );
        const pauseDurationMs = scripts.reduce(
          (total, script) => total + (script.pauseDuration ?? 0),
          0,
        );
        const longestScript = scripts.reduce<PerformanceScriptTiming | undefined>(
          (longest, script) => !longest || script.duration > longest.duration ? script : longest,
          undefined,
        );
        attributeMainThreadStall(
          entry.startTime,
          entry.duration,
          entry.blockingDuration || entry.duration,
        );
        logPerformance("ui_long_frame", {
          startTimeMs: entry.startTime,
          durationMs: entry.duration,
          blockingDurationMs: entry.blockingDuration,
          scriptDurationMs,
          renderDurationMs: Math.max(0, entry.duration - scriptDurationMs),
          scriptCount: scripts.length,
          longestScriptDurationMs: longestScript?.duration,
          forcedStyleLayoutDurationMs,
          pauseDurationMs,
          scriptSourceKind: scriptSourceKind(longestScript?.sourceURL),
          scriptInvokerKind: scriptInvokerKind(longestScript?.invokerType),
          sourceCharPosition: longestScript?.sourceCharPosition,
          styleLayoutDurationMs: entry.styleAndLayoutStart > 0
            ? Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart)
            : 0,
          duringHistoryLoad: duringHistoryLoad(entry.startTime),
          traceId: conversationTraceIdAt(entry.startTime),
        });
      }
    }, { type: "long-animation-frame", buffered: true });
  }

  return observe((entries) => {
    for (const entry of entries as LongTaskEntry[]) {
      attributeMainThreadStall(entry.startTime, entry.duration, entry.duration);
      logPerformance("ui_long_task", {
        startTimeMs: entry.startTime,
        durationMs: entry.duration,
        attributionCount: entry.attribution?.length ?? 0,
        containerKind: longTaskContainerKind(entry.attribution?.[0]?.containerType),
        duringHistoryLoad: duringHistoryLoad(entry.startTime),
        traceId: conversationTraceIdAt(entry.startTime),
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
      regionKind: regionKind(entry.target),
      duringHistoryLoad: duringHistoryLoad(entry.startTime),
      traceId: conversationTraceIdAt(entry.startTime),
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

const installLayoutShiftObserver = () => {
  let aggregate: PerformanceDetails | undefined;
  let flushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const flush = () => {
    flushTimer = undefined;
    if (!aggregate) return;
    logPerformance("ui_layout_shift", aggregate);
    aggregate = undefined;
  };

  return observe((entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (entry.hadRecentInput || entry.value < 0.02) continue;
      const sources = entry.sources ?? [];
      const largestSource = sources.reduce<LayoutShiftAttribution | undefined>((largest, source) => {
        const sourceArea = Math.max(
          source.previousRect.width * source.previousRect.height,
          source.currentRect.width * source.currentRect.height,
        );
        if (!largest) return source;
        const largestArea = Math.max(
          largest.previousRect.width * largest.previousRect.height,
          largest.currentRect.width * largest.currentRect.height,
        );
        return sourceArea > largestArea ? source : largest;
      }, undefined);
      const previousCenterX = largestSource
        ? largestSource.previousRect.left + largestSource.previousRect.width / 2
        : 0;
      const previousCenterY = largestSource
        ? largestSource.previousRect.top + largestSource.previousRect.height / 2
        : 0;
      const currentCenterX = largestSource
        ? largestSource.currentRect.left + largestSource.currentRect.width / 2
        : 0;
      const currentCenterY = largestSource
        ? largestSource.currentRect.top + largestSource.currentRect.height / 2
        : 0;
      const movedDistancePx = largestSource
        ? Math.hypot(currentCenterX - previousCenterX, currentCenterY - previousCenterY)
        : 0;
      const previousMovedDistance = typeof aggregate?.movedDistancePx === "number"
        ? aggregate.movedDistancePx
        : -1;
      const traceId = conversationTraceIdAt(entry.startTime);
      aggregate = {
        ...aggregate,
        startTimeMs: typeof aggregate?.startTimeMs === "number"
          ? Math.min(aggregate.startTimeMs, entry.startTime)
          : entry.startTime,
        shiftScore: (typeof aggregate?.shiftScore === "number" ? aggregate.shiftScore : 0) + entry.value,
        maxShiftScore: Math.max(
          typeof aggregate?.maxShiftScore === "number" ? aggregate.maxShiftScore : 0,
          entry.value,
        ),
        shiftCount: (typeof aggregate?.shiftCount === "number" ? aggregate.shiftCount : 0) + 1,
        duringHistoryLoad: aggregate?.duringHistoryLoad === true || duringHistoryLoad(entry.startTime),
        sourceCount: (typeof aggregate?.sourceCount === "number" ? aggregate.sourceCount : 0) + sources.length,
        traceId: traceId ?? aggregate?.traceId,
        ...(movedDistancePx >= previousMovedDistance ? {
          targetKind: targetKind(largestSource?.node),
          regionKind: regionKind(largestSource?.node),
          movedDistancePx,
          impactedAreaPx: largestSource
            ? Math.max(
                largestSource.previousRect.width * largestSource.previousRect.height,
                largestSource.currentRect.width * largestSource.currentRect.height,
              )
            : 0,
        } : {}),
      };
      if (flushTimer === undefined) {
        flushTimer = globalThis.setTimeout(flush, LAYOUT_SHIFT_AGGREGATION_MS);
      }
    }
  }, { type: "layout-shift", buffered: true });
};

const startFrameGapMonitor = () => {
  let previousFrameAt = performance.now();
  const calibrationIntervals: number[] = [];
  document.addEventListener("visibilitychange", () => {
    previousFrameAt = performance.now();
    calibrationIntervals.length = 0;
  });
  const sample = (now: number) => {
    const frameGapMs = now - previousFrameAt;
    previousFrameAt = now;
    if (
      displayTiming.sourceKind !== 1 &&
      frameGapMs >= 1 &&
      frameGapMs <= 1_000 / MIN_REFRESH_RATE_HZ * 1.5
    ) {
      calibrationIntervals.push(frameGapMs);
      if (calibrationIntervals.length >= RAF_CALIBRATION_SAMPLE_COUNT) {
        const sorted = calibrationIntervals.splice(0).sort((left, right) => left - right);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (median !== undefined) updateDisplayTiming(1_000 / median, 2);
      }
    }
    const frameStats = calculateFrameStats(frameGapMs, displayTiming.refreshRateHz);
    if (
      document.visibilityState === "visible" &&
      frameStats.missedFrames >= FRAME_DROP_MIN_MISSED_FRAMES &&
      now - lastFrameDropLogAt >= FRAME_DROP_LOG_INTERVAL_MS
    ) {
      lastFrameDropLogAt = now;
      logPerformance("ui_frame_drop", {
        startTimeMs: now - frameGapMs,
        durationMs: frameGapMs,
        frameGapMs,
        expectedFrames: frameStats.expectedFrames,
        missedFrames: frameStats.missedFrames,
        duringHistoryLoad: now <= historyInteractionUntil,
        traceId: conversationTraceIdAt(now - frameGapMs),
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

const installNativeDisplayTiming = () => {
  if (!hasTauriRuntime()) return;
  let refreshTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const refresh = async () => {
    try {
      const timing = await invoke<NativeDisplayTiming>("notgram_display_timing");
      if (timing.native) updateDisplayTiming(timing.refreshRateHz, 1);
    } catch {
      // rAF calibration remains available when the native display query fails.
    }
  };
  const scheduleRefresh = () => {
    if (refreshTimer !== undefined) globalThis.clearTimeout(refreshTimer);
    refreshTimer = globalThis.setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, DISPLAY_REFRESH_DEBOUNCE_MS);
  };
  void refresh();
  window.addEventListener("focus", scheduleRefresh);
  void getCurrentWindow().onMoved(scheduleRefresh).catch(() => undefined);
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
  installNativeDisplayTiming();
  if (typeof PerformanceObserver !== "undefined") {
    installLongFrameObserver();
    installInteractionObserver();
    installLayoutShiftObserver();
  }
  if (typeof requestAnimationFrame === "function") startFrameGapMonitor();
  if (document.readyState === "complete") setTimeout(logStartupTiming, 0);
  else window.addEventListener("load", () => setTimeout(logStartupTiming, 0), { once: true });
};
