const HEARTBEAT_INTERVAL_MS = 10_000;
const WAKE_DRIFT_MS = 25_000;

/** Native recovery owns OS wake detection; a throttled WebView is not an offline connection. */
export const installConnectionRecoveryMonitor = (recover: (force: boolean) => void) => {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  let heartbeatAt = Date.now();
  let lastRequestAt = -Infinity;
  let lastForcedAt = -Infinity;
  const request = (force = false) => {
    const now = Date.now();
    if (now - (force ? lastForcedAt : lastRequestAt) < HEARTBEAT_INTERVAL_MS) return;
    lastRequestAt = now;
    if (force) lastForcedAt = now;
    recover(force);
  };
  const foreground = () => { if (document.visibilityState === "visible") request(); };
  const online = () => request(true);
  window.addEventListener("online", online);
  window.addEventListener("focus", foreground);
  window.addEventListener("pageshow", foreground);
  document.addEventListener("visibilitychange", foreground);
  const timer = globalThis.setInterval(() => {
    const now = Date.now();
    const elapsed = now - heartbeatAt;
    heartbeatAt = now;
    if (elapsed >= WAKE_DRIFT_MS) request();
  }, HEARTBEAT_INTERVAL_MS);
  return () => {
    globalThis.clearInterval(timer);
    window.removeEventListener("online", online);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("pageshow", foreground);
    document.removeEventListener("visibilitychange", foreground);
  };
};
