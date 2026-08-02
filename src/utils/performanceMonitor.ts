import { invoke } from "@tauri-apps/api/core";

type PerformanceValue = number | boolean | undefined;
type PerformanceDetails = Record<string, PerformanceValue>;

const LONG_TASK_LOG_INTERVAL_MS = 10_000;
let monitoringInstalled = false;
let lastLongTaskLogAt = Number.NEGATIVE_INFINITY;
let lastHistoryLongTaskLogAt = Number.NEGATIVE_INFINITY;
let historyInteractionUntil = 0;

const roundedDetails = (details: PerformanceDetails) => Object.fromEntries(
  Object.entries(details)
    .filter((entry): entry is [string, number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [
      key,
      typeof value === "number" ? Math.round(value * 10) / 10 : value,
    ]),
);

const hasTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const logPerformance = (event: string, details: PerformanceDetails) => {
  const normalized = roundedDetails(details);
  if (import.meta.env.DEV) console.info(`[performance] ${event}`, normalized);
  if (hasTauriRuntime()) {
    void invoke("telegram_log_performance", { event, details: normalized }).catch(() => undefined);
  }
};

export const markHistoryInteraction = () => {
  historyInteractionUntil = performance.now() + 5_000;
};

export const installPerformanceMonitoring = () => {
  if (monitoringInstalled || typeof PerformanceObserver === "undefined") return;
  monitoringInstalled = true;
  try {
    const observer = new PerformanceObserver((list) => {
      const longest = list.getEntries().reduce<PerformanceEntry | undefined>(
        (current, entry) => !current || entry.duration > current.duration ? entry : current,
        undefined,
      );
      const now = performance.now();
      const duringHistoryLoad = now <= historyInteractionUntil;
      const lastLogAt = duringHistoryLoad ? lastHistoryLongTaskLogAt : lastLongTaskLogAt;
      if (!longest || now - lastLogAt < LONG_TASK_LOG_INTERVAL_MS) return;
      if (duringHistoryLoad) lastHistoryLongTaskLogAt = now;
      else lastLongTaskLogAt = now;
      logPerformance("ui_long_task", {
        durationMs: longest.duration,
        duringHistoryLoad,
      });
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long-task entries are optional in embedded webviews.
  }
};
