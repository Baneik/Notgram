import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { installMemoryManagement } from "./memoryLifecycle";
import { isMemoryBackground, registerMemoryCache, setMemoryBackground } from "./memoryCacheBudget";
import { logPerformance } from "../utils/performanceMonitor";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn(async () => undefined) }));
vi.mock("../utils/performanceMonitor", () => ({ isPerformanceMonitoringEnabled: () => true, logPerformance: vi.fn() }));
let cleanup: (() => void) | undefined;
let unregister: (() => void) | undefined;
afterEach(() => { cleanup?.(); unregister?.(); setMemoryBackground(false); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("memory lifecycle", () => {
  it("reclaims hidden caches without suspending message delivery, resumes and removes timers", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", document);
    const trim = vi.fn(); const changed = vi.fn();
    unregister = registerMemoryCache("stickerPreviews", { read: () => ({ entries: 2, bytes: 64, pending: 1 }), trim, onBackgroundChanged: changed });
    cleanup = installMemoryManagement();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isMemoryBackground()).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(trim).toHaveBeenLastCalledWith(100_000);
    expect(logPerformance).toHaveBeenCalledWith("ui_memory_usage", expect.objectContaining({ cacheBytes: 64, cacheEntryCount: 2, background: true }));
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "notgram_sync_memory_target")).toBe(true);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenLastCalledWith(false);
    cleanup(); cleanup = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending background reclaim when the window returns", async () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", document);
    const trim = vi.fn();
    unregister = registerMemoryCache("sharedMedia", { read: () => ({ entries: 0, bytes: 0 }), trim });
    cleanup = installMemoryManagement();
    await vi.advanceTimersByTimeAsync(5_000);
    document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(trim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(trim).toHaveBeenCalledOnce();
    expect(isMemoryBackground()).toBe(false);
  });
});
