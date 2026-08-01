import { useEffect, useRef } from "react";
import { useTelegramStore } from "../store/telegramStore";

export const useVisibleFile = <T extends Element>(
  fileId: number | undefined,
  enabled: boolean,
  priority: number,
  rootMargin: string,
) => {
  const targetRef = useRef<T>(null);
  const cacheFile = useTelegramStore((state) => state.cacheFile);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled || fileId === undefined) return;

    let requested = false;
    const request = () => {
      if (requested) return;
      requested = true;
      void cacheFile(fileId, priority);
    };

    if (typeof IntersectionObserver === "undefined") {
      request();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      request();
    }, { rootMargin });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cacheFile, enabled, fileId, priority, rootMargin]);

  return targetRef;
};
