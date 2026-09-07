const HEARTBEAT_INTERVAL_MS = 10_000;
const WAKE_DRIFT_MS = 25_000;
const FOREGROUND_REFRESH_MS = 60_000;

/** Detect both suspended timers and long tray/background stays with live timers. */
export const installConnectionRecoveryMonitor = (recover: (force: boolean) => void) => {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  let heartbeatAt = Date.now();
  let foregroundAt = heartbeatAt;
  let backgroundAt: number | undefined;
  let lastForcedAt = -Infinity;
  const request = (force: boolean) => {
    const now = Date.now();
    if (force) {
      if (now - lastForcedAt < HEARTBEAT_INTERVAL_MS) return;
      lastForcedAt = now;
    }
    recover(force);
  };
  const foreground = () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    const elapsed = now - (backgroundAt ?? foregroundAt);
    backgroundAt = undefined;
    foregroundAt = now;
    request(elapsed >= FOREGROUND_REFRESH_MS || now - heartbeatAt >= WAKE_DRIFT_MS);
  };
  const visibility = () => {
    if (document.visibilityState === "visible") foreground();
    else backgroundAt ??= Date.now();
  };
  const online = () => request(true);
  const blur = () => { backgroundAt ??= Date.now(); };
  window.addEventListener("online", online);
  window.addEventListener("focus", foreground);
  window.addEventListener("blur", blur);
  window.addEventListener("pageshow", foreground);
  document.addEventListener("visibilitychange", visibility);
  const timer = globalThis.setInterval(() => {
    const now = Date.now();
    const elapsed = now - heartbeatAt;
    heartbeatAt = now;
    if (elapsed >= WAKE_DRIFT_MS) request(true);
  }, HEARTBEAT_INTERVAL_MS);
  return () => {
    globalThis.clearInterval(timer);
    window.removeEventListener("online", online);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("blur", blur);
    window.removeEventListener("pageshow", foreground);
    document.removeEventListener("visibilitychange", visibility);
  };
};
