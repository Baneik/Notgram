const HEARTBEAT_INTERVAL_MS = 10_000;
const WAKE_DRIFT_MS = 25_000;

/** Native recovery owns OS wake detection; a throttled WebView is not an offline connection. */
export const installConnectionRecoveryMonitor = (recover: (force: boolean) => void) => {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  let heartbeatAt = Date.now();
  let lastRequestAt = -Infinity;
  const request = () => {
    const now = Date.now();
    if (now - lastRequestAt < HEARTBEAT_INTERVAL_MS) return;
    lastRequestAt = now;
    recover(false);
  };
  const foreground = () => { if (document.visibilityState === "visible") request(); };
  window.addEventListener("online", request);
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
    window.removeEventListener("online", request);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("pageshow", foreground);
    document.removeEventListener("visibilitychange", foreground);
  };
};
