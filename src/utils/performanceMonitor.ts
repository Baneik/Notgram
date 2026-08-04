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
  scripts?: Array<{ duration: number }>;
}

const MAX_RECORDS = 240;
const FRAME_BUDGET_MS = 1000 / 60;
const FRAME_DROP_THRESHOLD_MS = 50;
const FRAME_DROP_LOG_INTERVAL_MS = 1_000;
const HISTORY_CONTEXT_MS = 5_000;
const NATIVE_BATCH_SIZE = 20;
const NATIVE_FLUSH_DELAY_MS = 250;
const MAX_DETAIL_FIELDS = 24;
const CONVERSATION_TRACE_TIMEOUT_MS = 8_000;

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

const windowKind = () => {
  if (typeof window === "undefined") return 0;
  return window.location.pathname.includes("video-window") ? 2 : 1;
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
  | "transitionFinished";

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
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

const conversationSwitchTraces = new Map<number, ConversationSwitchTrace>();
const conversationTraceWindows: Array<{ id: number; startedAt: number; finishedAt: number }> = [];
let nextConversationTraceId = 1;
let activeConversationTraceId: number | undefined;

const roundedDetails = (details: PerformanceDetails) => Object.fromEntries(
  Object.entries(details)
    .filter((entry): entry is [string, number | boolean] => entry[1] !== undefined)
    .slice(0, MAX_DETAIL_FIELDS)
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
      !["startTimeMs", "observedAtMs"].includes(key) &&
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
  const normalized = roundedDetails({
    ...details,
    observedAtMs: Date.now(),
    windowKind: windowKind(),
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

const finishConversationSwitch = (
  trace: ConversationSwitchTrace,
  options: { timedOut?: boolean; cancelled?: boolean } = {},
) => {
  globalThis.clearTimeout(trace.timeout);
  conversationSwitchTraces.delete(trace.id);
  const traceWindow = conversationTraceWindows.find((window) => window.id === trace.id);
  if (traceWindow) traceWindow.finishedAt = performance.now() + 500;
  if (activeConversationTraceId === trace.id) activeConversationTraceId = undefined;

  const finishedAt = Math.max(
    trace.positionedAt ?? trace.startedAt,
    trace.transitionFinishedAt ?? trace.startedAt,
    performance.now(),
  );
  const selectionDurationMs = elapsed(trace.selectionCommittedAt, trace.startedAt);
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
  const candidates = [
    [1, selectionDurationMs],
    [2, dataDurationMs],
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
    virtualListDurationMs,
    positionDurationMs,
    transitionDurationMs,
    bottleneckStage: bottleneck.stage,
    bottleneckDurationMs: bottleneck.duration,
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
          traceId: conversationTraceIdAt(entry.startTime),
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

const installLayoutShiftObserver = () => observe((entries) => {
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
    logPerformance("ui_layout_shift", {
      startTimeMs: entry.startTime,
      shiftScore: entry.value,
      duringHistoryLoad: duringHistoryLoad(entry.startTime),
      sourceCount: sources.length,
      targetKind: targetKind(largestSource?.node),
      movedDistancePx: largestSource
        ? Math.hypot(currentCenterX - previousCenterX, currentCenterY - previousCenterY)
        : 0,
      impactedAreaPx: largestSource
        ? Math.max(
            largestSource.previousRect.width * largestSource.previousRect.height,
            largestSource.currentRect.width * largestSource.currentRect.height,
          )
        : 0,
      traceId: conversationTraceIdAt(entry.startTime),
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
        traceId: conversationTraceIdAt(now - frameGapMs),
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
