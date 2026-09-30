import { useCallback, useState } from "react";
import { useDocumentVisibility } from "./useDocumentVisibility";

type VisibilityListener = (visible: boolean) => void;

interface ObserverPool {
  observer: IntersectionObserver;
  listeners: Map<Element, Set<VisibilityListener>>;
}

const pools = new Map<Element | null, Map<string, ObserverPool>>();

const observerPool = (rootMargin: string, root: Element | null) => {
  let rootPools = pools.get(root);
  if (!rootPools) {
    rootPools = new Map();
    pools.set(root, rootPools);
  }
  const existing = rootPools.get(rootMargin);
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
    }, { root, rootMargin }),
  };
  rootPools.set(rootMargin, pool);
  return pool;
};

export const useElementVisibility = <T extends Element>(
  rootMargin = "120px",
  scrollRootSelector?: string,
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
    if (!element) return;
    const root = scrollRootSelector ? element.closest(scrollRootSelector) : null;
    const pool = observerPool(rootMargin, root);
    const listener: VisibilityListener = (next) => {
      setElementVisible((current) => current === next ? current : next);
    };
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
        if (pool.listeners.size === 0) {
          pool.observer.disconnect();
          const rootPools = pools.get(root);
          rootPools?.delete(rootMargin);
          if (rootPools?.size === 0) pools.delete(root);
        }
      }
    };
  }, [rootMargin, scrollRootSelector]);

  return [ref, elementVisible && documentVisible] as const;
};
