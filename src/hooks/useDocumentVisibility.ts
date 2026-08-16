import { useSyncExternalStore } from "react";

const subscribe = (onStoreChange: () => void) => {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
};

const getSnapshot = () => typeof document === "undefined" || document.visibilityState === "visible";

/** Shared visibility source for every continuous motion runtime. */
export const useDocumentVisibility = () => useSyncExternalStore(
  subscribe,
  getSnapshot,
  () => true,
);
