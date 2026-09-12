import { useEffect, useRef } from "react";
import { telegramStore } from "../store/telegramStore";
import { createVisibleResourceRequest } from "../utils/visibleResourceRequest";

export const useVisibleFile = <T extends Element>(
  fileId: number | undefined,
  enabled: boolean,
  priority: number,
  rootMargin: string,
  eager = false,
) => {
  const targetRef = useRef<T>(null);
  const retryStateRef = useRef({ fileId: undefined as number | undefined, failures: 0, notBefore: 0 });

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled || fileId === undefined) return;

    if (retryStateRef.current.fileId !== fileId) {
      retryStateRef.current = { fileId, failures: 0, notBefore: 0 };
    }

    const accountId = telegramStore.getState().activeAccountId;
    let disposed = false;
    const request = createVisibleResourceRequest({
      load: () => {
        const state = telegramStore.getState();
        if (disposed || state.activeAccountId !== accountId) return Promise.resolve();
        return state.cacheFile(fileId, priority);
      },
      retryState: retryStateRef.current,
    });
    globalThis.addEventListener?.("online", request.retry);
    const dispose = () => {
      disposed = true;
      request.dispose();
      globalThis.removeEventListener?.("online", request.retry);
    };

    if (eager || typeof IntersectionObserver === "undefined") {
      request.setVisible(true);
      return dispose;
    }

    const observer = new IntersectionObserver((entries) => {
      request.setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin });
    observer.observe(target);
    return () => {
      dispose();
      observer.disconnect();
    };
  }, [eager, enabled, fileId, priority, rootMargin]);

  return targetRef;
};
