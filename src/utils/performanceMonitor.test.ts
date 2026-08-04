import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginConversationSwitch,
  clearPerformanceRecords,
  getPerformanceRecords,
  logPerformance,
  markConversationSwitch,
  subscribePerformanceRecords,
} from "./performanceMonitor";

describe("performance monitor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
        details: expect.objectContaining({
          durationMs: 52.3,
          batchCount: 30,
          failed: false,
          observedAtMs: expect.any(Number),
          windowKind: 0,
          windowId: expect.any(Number),
        }),
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

  it("summarizes a conversation switch and identifies its largest stage", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const traceId = beginConversationSwitch({
      cached: true,
      messageCount: 60,
      viewTransition: true,
      navigationKind: 1,
    });

    markConversationSwitch(traceId, "transitionStarted");
    now = 5;
    markConversationSwitch(traceId, "selectionCommitted");
    now = 45;
    markConversationSwitch(traceId, "dataReady", { messageCount: 62, blockCount: 31 });
    now = 47;
    markConversationSwitch(traceId, "messageProjected", { durationMs: 2 });
    now = 55;
    markConversationSwitch(traceId, "reactCommitted", { durationMs: 8 });
    markConversationSwitch(traceId, "virtuosoRange");
    now = 70;
    markConversationSwitch(traceId, "positioned");
    now = 96;
    markConversationSwitch(traceId, "transitionFinished");

    expect(getPerformanceRecords()).toEqual([
      expect.objectContaining({
        event: "ui_conversation_switch",
        durationMs: 96,
        details: expect.objectContaining({
          traceId,
          messageCount: 62,
          blockCount: 31,
          dataDurationMs: 40,
          reactDurationMs: 8,
          transitionDurationMs: 96,
          bottleneckStage: 7,
          bottleneckDurationMs: 96,
        }),
      }),
    ]);
  });
});
