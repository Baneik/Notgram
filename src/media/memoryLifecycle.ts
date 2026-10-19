import { invoke, isTauri } from "@tauri-apps/api/core";
import { isPerformanceMonitoringEnabled, logPerformance } from "../utils/performanceMonitor";
import { readMemoryCacheUsage, setMemoryBackground, sweepMemoryCaches } from "./memoryCacheBudget";

/** Keep message delivery running while reclaiming resources owned by idle caches. */
export const installMemoryManagement = () => {
  let reclaimTimer: ReturnType<typeof setTimeout> | undefined;
  const sample = () => {
    if (!isPerformanceMonitoringEnabled()) return;
    const caches = readMemoryCacheUsage();
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    logPerformance("ui_memory_usage", {
      cacheBytes: caches.reduce((sum, cache) => sum + cache.bytes, 0),
      activeCacheBytes: caches.reduce((sum, cache) => sum + (cache.activeBytes ?? 0), 0),
      cacheEntryCount: caches.reduce((sum, cache) => sum + cache.entries, 0),
      pendingCount: caches.reduce((sum, cache) => sum + (cache.pending ?? 0), 0),
      heapBytes: heap?.usedJSHeapSize,
      background: document.visibilityState === "hidden",
    });
  };
  const sweep = () => { sweepMemoryCaches(); sample(); };
  const visibilityChanged = () => {
    const hidden = document.visibilityState === "hidden";
    setMemoryBackground(hidden);
    if (reclaimTimer !== undefined) clearTimeout(reclaimTimer);
    reclaimTimer = hidden ? setTimeout(sweep, 15_000) : undefined;
    if (isTauri()) void invoke("notgram_sync_memory_target").catch(() => undefined);
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();
  const interval = setInterval(sweep, 30_000);
  return () => {
    clearInterval(interval);
    if (reclaimTimer !== undefined) clearTimeout(reclaimTimer);
    document.removeEventListener("visibilitychange", visibilityChanged);
    setMemoryBackground(false);
  };
};
