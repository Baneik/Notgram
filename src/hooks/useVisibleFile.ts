import { useEffect, useRef } from "react";
import { useTelegramStore } from "../store/telegramStore";

export const useVisibleFile = <T extends Element>(
  fileId: number | undefined,
  enabled: boolean,
  priority: number,
  rootMargin: string,
) => {
  const targetRef = useRef<T>(null);
  const retryStateRef = useRef({ fileId: undefined as number | undefined, failures: 0, notBefore: 0 });
  const cacheFile = useTelegramStore((state) => state.cacheFile);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled || fileId === undefined) return;

    if (retryStateRef.current.fileId !== fileId) {
      retryStateRef.current = { fileId, failures: 0, notBefore: 0 };
    }

    let visible = false;
    let disposed = false;
    let requested = false;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const request = () => {
      if (disposed || !visible || requested) return;
      const wait = Math.max(0, retryStateRef.current.notBefore - Date.now());
      if (wait > 0) {
        retryTimer = globalThis.setTimeout(request, wait);
        return;
      }
      requested = true;
      void cacheFile(fileId, priority)
        .then(() => {
          retryStateRef.current = { fileId, failures: 0, notBefore: 0 };
        })
        .catch(() => {
          const failures = retryStateRef.current.failures + 1;
          const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
          retryStateRef.current = { fileId, failures, notBefore: Date.now() + delay };
          requested = false;
          if (!disposed && visible) {
            retryTimer = globalThis.setTimeout(request, delay);
          }
        });
    };

    if (typeof IntersectionObserver === "undefined") {
      visible = true;
      request();
      return () => {
        disposed = true;
        if (retryTimer) globalThis.clearTimeout(retryTimer);
      };
    }

    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) request();
      else if (retryTimer) globalThis.clearTimeout(retryTimer);
    }, { rootMargin });
    observer.observe(target);
    return () => {
      disposed = true;
      observer.disconnect();
      if (retryTimer) globalThis.clearTimeout(retryTimer);
    };
  }, [cacheFile, enabled, fileId, priority, rootMargin]);

  return targetRef;
};
