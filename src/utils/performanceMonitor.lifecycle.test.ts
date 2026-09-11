import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => {
  const listeners = new Set<(state: { performanceMonitoringEnabled: boolean }) => void>();
  let enabled = true;
  return {
    listeners,
    getState: () => ({ performanceMonitoringEnabled: enabled }),
    subscribe: (listener: (state: { performanceMonitoringEnabled: boolean }) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setEnabled(value: boolean) {
      enabled = value;
      for (const listener of listeners) listener(this.getState());
    },
  };
});
const native = vi.hoisted(() => ({ invoke: vi.fn(), onMoved: vi.fn() }));
vi.mock("../store/preferencesStore", () => ({ preferencesStore: preferences }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onMoved: native.onMoved }) }));

class TestObserver {
  static supportedEntryTypes = ["long-animation-frame", "longtask", "event", "layout-shift"];
  static instances: TestObserver[] = [];
  options?: PerformanceObserverInit;
  disconnect = vi.fn();
  constructor(private callback: PerformanceObserverCallback) { TestObserver.instances.push(this); }
  observe(options: PerformanceObserverInit) { this.options = options; }
  deliver(entries: Partial<PerformanceEntry>[]) {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let monitor: typeof import("./performanceMonitor");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  preferences.listeners.clear();
  preferences.setEnabled(true);
  native.invoke.mockReset().mockResolvedValue(undefined);
  native.onMoved.mockReset().mockResolvedValue(vi.fn());
  TestObserver.instances = [];
  frames = new Map();
  nextFrame = 0;
  const testWindow = Object.assign(new EventTarget(), { location: { search: "", pathname: "/" } });
  const testDocument = Object.assign(new EventTarget(), {
    readyState: "loading", visibilityState: "visible", hasFocus: () => true,
  });
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", testDocument);
  vi.stubGlobal("PerformanceObserver", TestObserver);
  vi.stubGlobal("Element", class {});
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  monitor = await import("./performanceMonitor");
});

afterEach(() => {
  preferences.setEnabled(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("performance monitoring lifecycle", () => {
  it("installs no collectors when disabled and bypasses logging before any detail work", () => {
    preferences.setEnabled(false);
    monitor.installPerformanceMonitoring();
    const readDetail = vi.fn(() => 100);
    monitor.logPerformance("ui_history_merge", { get durationMs() { return readDetail(); } });
    expect(monitor.beginConversationSwitch({ cached: false, messageCount: 10, viewTransition: false, navigationKind: 1 })).toBeUndefined();
    monitor.markHistoryInteraction();
    expect(readDetail).not.toHaveBeenCalled();
    expect(monitor.getPerformanceRecords()).toEqual([]);
    expect(TestObserver.instances).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("disconnects observers, frames, listeners and all pending aggregations on disable", async () => {
    monitor.installPerformanceMonitoring();
    monitor.installPerformanceMonitoring();
    expect(TestObserver.instances).toHaveLength(4);
    expect(frames.size).toBe(1);
    TestObserver.instances.find(item => item.options?.type === "layout-shift")!.deliver([
      { startTime: performance.now(), value: 0.03, sources: [] } as Partial<PerformanceEntry>,
    ]);
    TestObserver.instances.find(item => item.options?.type === "event")!.deliver([
      { startTime: performance.now(), interactionId: 5, duration: 100 } as Partial<PerformanceEntry>,
    ]);
    monitor.beginConversationSwitch({ cached: false, messageCount: 1, viewTransition: false, navigationKind: 1 });
    window.dispatchEvent(new Event("load"));
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(4);
    const oldFrame = [...frames.values()][0]!;
    preferences.setEnabled(false);
    for (const observer of TestObserver.instances) expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    oldFrame(performance.now());
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frames.size).toBe(0);
    expect(monitor.getPerformanceRecords()).toEqual([]);
    expect(monitor.getActiveConversationTraceId()).toBeUndefined();
  });

  it("restarts once, rejecting old callbacks and buffered entries from the disabled interval", () => {
    monitor.installPerformanceMonitoring();
    const oldObserver = TestObserver.instances.find(item => item.options?.type === "longtask")!;
    preferences.setEnabled(false);
    const offTime = performance.now();
    vi.advanceTimersByTime(1_000);
    preferences.setEnabled(true);
    preferences.setEnabled(true);
    monitor.installPerformanceMonitoring();
    expect(frames.size).toBe(1);
    expect(TestObserver.instances).toHaveLength(8);
    oldObserver.deliver([{ startTime: performance.now(), duration: 100 }]);
    const observer = TestObserver.instances.filter(item => item.options?.type === "longtask").at(-1)!;
    observer.deliver([{ startTime: offTime, duration: 100 }, { startTime: performance.now(), duration: 80 }]);
    expect(monitor.getPerformanceRecords()).toHaveLength(1);
    expect(monitor.getPerformanceRecords()[0]?.durationMs).toBe(80);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops queued native writes and releases an asynchronously registered native listener", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    let finishTiming!: (value: { native: boolean; refreshRateHz: number }) => void;
    let finishRegistration!: (unlisten: () => void) => void;
    native.invoke.mockImplementation(() => new Promise(resolve => { finishTiming = resolve; }));
    native.onMoved.mockImplementation(() => new Promise(resolve => { finishRegistration = resolve; }));
    monitor.installPerformanceMonitoring();
    monitor.logPerformance("ui_history_merge", { durationMs: 20 });
    window.dispatchEvent(new Event("focus"));
    preferences.setEnabled(false);
    const unlisten = vi.fn();
    finishRegistration(unlisten);
    finishTiming({ native: true, refreshRateHz: 144 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unlisten).toHaveBeenCalledOnce();
    expect(monitor.getDisplayTiming().refreshRateHz).toBe(60);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a native write failure and history response arriving after disable", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    let failWrite!: (reason: Error) => void;
    let finishRead!: (value: unknown[]) => void;
    native.invoke.mockImplementation(command => new Promise((resolve, reject) => {
      if (command === "telegram_log_performance_batch") failWrite = reject;
      else if (command === "telegram_read_performance_records") finishRead = resolve;
    }));
    monitor.logPerformance("ui_history_merge", { durationMs: 20 });
    await vi.advanceTimersByTimeAsync(250);
    const reading = monitor.refreshPersistedPerformanceRecords();
    preferences.setEnabled(false);
    const records = monitor.getPerformanceRecords();
    failWrite(new Error("write failed"));
    finishRead([{ timestampMs: Date.now(), event: "ui_long_task", details: { durationMs: 100 } }]);
    await reading;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.getPerformanceRecords()).toBe(records);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops active geometry bursts and removes hot-path DOM reads while preserving scroll writes", async () => {
    const { observeConversationViewportDiagnostics } = await import("./conversationViewportDiagnostics");
    const { conversationTraceFor, writeConversationScrollTop, recordConversationMeasurement, recordConversationMessage } = await import("./conversationTrace");
    const readPosition = vi.fn(() => 0);
    const writePosition = vi.fn();
    const list = Object.defineProperty(Object.assign(new EventTarget(), { isConnected: true, clientHeight: 0 }), "scrollTop", {
      get: readPosition, set: writePosition,
    }) as unknown as HTMLElement;
    const readControl = vi.fn(() => ({}));
    const stop = observeConversationViewportDiagnostics(list, readControl, {
      chatId: "chat", readState: () => ({}),
      readModel: () => ({ messages: [], indexes: new Map(), firstItemIndex: 0 }),
    });
    const original = conversationTraceFor(list)!;
    original.trigger(1);
    expect(vi.getTimerCount()).toBe(2);
    preferences.setEnabled(false);
    expect(conversationTraceFor(list)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    readPosition.mockClear();
    const closest = vi.fn();
    writeConversationScrollTop(list, 42, 1);
    recordConversationMeasurement({ closest } as unknown as HTMLElement, 20, true);
    recordConversationMessage("chat", "message", 16);
    list.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writePosition).toHaveBeenCalledExactlyOnceWith(42);
    expect(readPosition).not.toHaveBeenCalled();
    expect(closest).not.toHaveBeenCalled();
    expect(readControl).not.toHaveBeenCalled();
    preferences.setEnabled(true);
    expect(conversationTraceFor(list)?.session).not.toBe(original.session);
    expect(vi.getTimerCount()).toBe(2);
    stop();
    preferences.setEnabled(false);
    preferences.setEnabled(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
