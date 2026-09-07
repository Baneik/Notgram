import { useEffect, useRef } from "react";
import { telegramStore } from "../store/telegramStore";
import { createVisibleResourceRequest } from "../utils/visibleResourceRequest";

export const useVisibleFile = <T extends Element>(
  fileId: number | undefined,
  enabled: boolean,
  priority: number,
  rootMargin: string,
) => {
  const targetRef = useRef<T>(null);
  const retryStateRef = useRef({ fileId: undefined as number | undefined, failures: 0, notBefore: 0 });

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled || fileId === undefined) return;

    if (retryStateRef.current.fileId !== fileId) {
      retryStateRef.current = { fileId, failures: 0, notBefore: 0 };
    }

    const request = createVisibleResourceRequest({
      load: () => telegramStore.getState().cacheFile(fileId, priority),
      retryState: retryStateRef.current,
    });
    globalThis.addEventListener?.("online", request.retry);
    const dispose = () => {
      request.dispose();
      globalThis.removeEventListener?.("online", request.retry);
    };

    if (typeof IntersectionObserver === "undefined") {
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
  }, [enabled, fileId, priority, rootMargin]);

  return targetRef;
};
