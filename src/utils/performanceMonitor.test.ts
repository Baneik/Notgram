import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPerformanceRecords,
  getPerformanceRecords,
  logPerformance,
  subscribePerformanceRecords,
} from "./performanceMonitor";

describe("performance monitor", () => {
  beforeEach(() => {
    clearPerformanceRecords();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("classifies instrumented stages and preserves only numeric diagnostics", () => {
    logPerformance("ui_history_merge", {
      durationMs: 52.346,
      batchCount: 30,
      failed: false,
      ignored: undefined,
    });

    expect(getPerformanceRecords()).toEqual([
      expect.objectContaining({
        event: "ui_history_merge",
        label: "历史消息合并",
        category: "data",
        severity: "critical",
        durationMs: 52.3,
        details: {
          durationMs: 52.3,
          batchCount: 30,
          failed: false,
        },
      }),
    ]);
  });

  it("notifies live views and clears the current session", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePerformanceRecords(listener);

    logPerformance("ui_long_frame", { durationMs: 72 });
    expect(listener).toHaveBeenCalledOnce();
    expect(getPerformanceRecords()).toHaveLength(1);

    clearPerformanceRecords();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getPerformanceRecords()).toEqual([]);
    unsubscribe();
  });

  it("never treats the monotonic start timestamp as an event duration", () => {
    logPerformance("ui_history_render", {
      startTimeMs: 12_000,
      restoreDurationMs: 12,
    });

    expect(getPerformanceRecords()[0]).toEqual(expect.objectContaining({
      durationMs: 12,
      severity: "normal",
    }));
  });

  it("bounds the in-memory timeline", () => {
    for (let index = 0; index < 260; index += 1) {
      logPerformance("ui_frame_drop", { durationMs: 60, missedFrames: index });
    }

    expect(getPerformanceRecords()).toHaveLength(240);
    expect(getPerformanceRecords()[0]?.details.missedFrames).toBe(20);
    expect(getPerformanceRecords()[239]?.details.missedFrames).toBe(259);
  });
});
