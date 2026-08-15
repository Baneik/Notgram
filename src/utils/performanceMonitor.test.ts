import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginConversationSwitch,
  calculateFrameStats,
  clearPerformanceRecords,
  getPerformanceRecords,
  logPerformance,
  markConversationSwitch,
  mergePersistedPerformanceRecords,
  performanceWindowKind,
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
          causeDomain: 1,
          causeKind: 1,
          evidenceKind: 0,
          uiStall: true,
          refreshRateHz: 60,
          frameBudgetMs: 16.7,
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

  it("detects isolated and legacy video window routes", () => {
    expect(performanceWindowKind("?id=preview-1", "/video-window.html")).toBe(2);
    expect(performanceWindowKind("?videoWindow=preview-1", "/")).toBe(2);
    expect(performanceWindowKind("?id=preview-1", "/media-viewer-window.html")).toBe(1);
    expect(performanceWindowKind("", "/")).toBe(1);
  });

  it("calculates missed frames from the active display refresh rate", () => {
    expect(calculateFrameStats(50, 60)).toEqual({
      frameBudgetMs: 1_000 / 60,
      expectedFrames: 3,
      missedFrames: 2,
    });
    expect(calculateFrameStats(25, 120)).toEqual({
      frameBudgetMs: 1_000 / 120,
      expectedFrames: 3,
      missedFrames: 2,
    });
    expect(calculateFrameStats(100, 30)).toEqual({
      frameBudgetMs: 1_000 / 30,
      expectedFrames: 3,
      missedFrames: 2,
    });
  });

  it("classifies asynchronous history loading separately from UI stalls", () => {
    logPerformance("ui_history_data", { durationMs: 2_400, failed: false });

    expect(getPerformanceRecords()[0]).toMatchObject({
      severity: "critical",
      details: {
        causeDomain: 3,
        causeKind: 6,
        uiStall: false,
        mainThreadBlocked: false,
      },
    });
  });

  it("preserves layout-shift precision for useful diagnostics", () => {
    logPerformance("ui_layout_shift", {
      shiftScore: 0.02456,
      maxShiftScore: 0.02004,
      shiftCount: 2,
    });

    expect(getPerformanceRecords()[0]).toMatchObject({
      severity: "warning",
      details: {
        shiftScore: 0.0246,
        maxShiftScore: 0.02,
        shiftCount: 2,
      },
    });
  });

  it("bounds the in-memory timeline", () => {
    for (let index = 0; index < 260; index += 1) {
      logPerformance("ui_frame_drop", { durationMs: 60, missedFrames: index });
    }

    expect(getPerformanceRecords()).toHaveLength(240);
    expect(getPerformanceRecords()[0]?.details.missedFrames).toBe(20);
    expect(getPerformanceRecords()[239]?.details.missedFrames).toBe(259);
  });

  it("merges persisted native records without duplicating live samples", () => {
    logPerformance("ui_long_frame", { durationMs: 72 });
    const live = getPerformanceRecords()[0]!;
    mergePersistedPerformanceRecords([{
      timestampMs: live.timestampMs,
      event: live.event,
      details: live.details,
    }, {
      timestampMs: live.timestampMs + 1,
      event: "ui_conversation_switch",
      details: { durationMs: 38, observedAtMs: live.timestampMs + 1, cached: true },
    }]);

    expect(getPerformanceRecords()).toHaveLength(2);
    expect(getPerformanceRecords()[1]).toMatchObject({
      event: "ui_conversation_switch",
      timestampMs: live.timestampMs + 1,
      details: { cached: true },
    });
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

  it("reports an incomplete trace without treating its eight-second timer as a UI stall", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const traceId = beginConversationSwitch({
        cached: true,
        messageCount: 20,
        viewTransition: false,
        navigationKind: 1,
      });
      markConversationSwitch(traceId, "transitionStarted");
      markConversationSwitch(traceId, "selectionCommitted");
      now = 4;
      markConversationSwitch(traceId, "dataReady");
      now = 16;
      markConversationSwitch(traceId, "transitionFinished");

      now = 8_000;
      await vi.advanceTimersByTimeAsync(8_000);

      expect(getPerformanceRecords()).toEqual([
        expect.objectContaining({
          event: "ui_conversation_switch",
          durationMs: 8_000,
          severity: "warning",
          details: expect.objectContaining({
            timedOut: true,
            visualResponseDurationMs: 16,
            traceWaitDurationMs: 7_984,
            missingStageMask: 32,
            causeDomain: 4,
            causeKind: 9,
            uiStall: false,
            mainThreadBlocked: false,
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attributes an eight-second trace to async work when the wait is still in flight", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const traceId = beginConversationSwitch({
        cached: false,
        messageCount: 0,
        viewTransition: false,
        navigationKind: 3,
      });
      markConversationSwitch(traceId, "asyncWaitStarted");

      now = 8_000;
      await vi.advanceTimersByTimeAsync(8_000);

      expect(getPerformanceRecords()[0]).toMatchObject({
        event: "ui_conversation_switch",
        durationMs: 8_000,
        severity: "critical",
        details: {
          asyncWaitDurationMs: 8_000,
          asyncWaitCount: 1,
          asyncWaitInFlight: true,
          causeDomain: 3,
          causeKind: 6,
          uiStall: false,
          mainThreadBlocked: false,
        },
      });
      expect(getPerformanceRecords()[0]?.details).not.toHaveProperty("traceWaitDurationMs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps completed async waiting out of selection work and visual response timing", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const traceId = beginConversationSwitch({
      cached: false,
      messageCount: 0,
      viewTransition: false,
      navigationKind: 3,
    });
    markConversationSwitch(traceId, "asyncWaitStarted");
    now = 500;
    markConversationSwitch(traceId, "asyncWaitFinished", { failed: false });
    now = 502;
    markConversationSwitch(traceId, "transitionStarted");
    markConversationSwitch(traceId, "selectionCommitted");
    now = 504;
    markConversationSwitch(traceId, "dataReady");
    now = 505;
    markConversationSwitch(traceId, "virtuosoRange");
    now = 510;
    markConversationSwitch(traceId, "positioned");
    now = 518;
    markConversationSwitch(traceId, "transitionFinished");

    expect(getPerformanceRecords()[0]).toMatchObject({
      event: "ui_conversation_switch",
      durationMs: 518,
      severity: "critical",
      details: {
        selectionDurationMs: 2,
        asyncWaitDurationMs: 500,
        visualResponseDurationMs: 16,
        bottleneckStage: 2,
        causeDomain: 3,
        causeKind: 6,
        uiStall: false,
      },
    });
  });

  it("keeps a superseded trace as informational instead of reporting a UI stall", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const firstTraceId = beginConversationSwitch({
      cached: true,
      messageCount: 20,
      viewTransition: false,
      navigationKind: 1,
    });
    markConversationSwitch(firstTraceId, "transitionStarted");
    markConversationSwitch(firstTraceId, "selectionCommitted");

    now = 500;
    beginConversationSwitch({
      cached: true,
      messageCount: 10,
      viewTransition: false,
      navigationKind: 1,
    });

    expect(getPerformanceRecords()[0]).toMatchObject({
      event: "ui_conversation_switch",
      durationMs: 500,
      severity: "normal",
      details: {
        cancelled: true,
        causeDomain: 4,
        causeKind: 9,
        uiStall: false,
      },
    });
    clearPerformanceRecords();
  });
});
