import { useCallback, useState } from "react";
import { useDocumentVisibility } from "./useDocumentVisibility";

type VisibilityListener = (visible: boolean) => void;

interface ObserverPool {
  observer: IntersectionObserver;
  listeners: Map<Element, Set<VisibilityListener>>;
}

const pools = new Map<string, ObserverPool>();

const observerPool = (rootMargin: string) => {
  const existing = pools.get(rootMargin);
  if (existing) return existing;
  const listeners = new Map<Element, Set<VisibilityListener>>();
  const pool: ObserverPool = {
    listeners,
    observer: new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        listeners.get(entry.target)?.forEach((listener) => {
          listener(entry.isIntersecting && entry.intersectionRatio > 0);
        });
      });
    }, { rootMargin }),
  };
  pools.set(rootMargin, pool);
  return pool;
};

export const useElementVisibility = <T extends Element>(
  rootMargin = "120px",
) => {
  const documentVisible = useDocumentVisibility();
  const [elementVisible, setElementVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const ref = useCallback((element: T | null) => {
    if (typeof IntersectionObserver === "undefined") {
      setElementVisible(true);
      return;
    }
    const pool = observerPool(rootMargin);
    const listener: VisibilityListener = (next) => {
      setElementVisible((current) => current === next ? current : next);
    };
    if (!element) return;
    let listeners = pool.listeners.get(element);
    if (!listeners) {
      listeners = new Set();
      pool.listeners.set(element, listeners);
      pool.observer.observe(element);
    }
    listeners.add(listener);

    return () => {
      const current = pool.listeners.get(element);
      current?.delete(listener);
      if (current?.size === 0) {
        pool.listeners.delete(element);
        pool.observer.unobserve(element);
      }
    };
  }, [rootMargin]);

  return [ref, elementVisible && documentVisible] as const;
};
