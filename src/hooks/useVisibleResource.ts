import { useEffect, useRef, useState } from "react";
import { createVisibleResourceRequest } from "../utils/visibleResourceRequest";

/** A keyed resource cannot display a previous account/file's result while its next read is pending. */
export const useVisibleResource = <T>(key: string | undefined, visible: boolean, cached: T | undefined, load: () => Promise<T | undefined>) => {
  const loadRef = useRef(load);
  const requestRef = useRef<ReturnType<typeof createVisibleResourceRequest<T>> | undefined>(undefined);
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  const [failedKey, setFailedKey] = useState<string>();
  const value = cached !== undefined ? cached : loaded && loaded.key === key ? loaded.value : undefined;
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (key === undefined || value !== undefined) return;
    const request = createVisibleResourceRequest({
      load: async () => {
        const result = await loadRef.current();
        if (result === undefined) throw new Error("Resource unavailable");
        return result;
      },
      onLoaded: (result) => { setLoaded({ key, value: result }); setFailedKey(undefined); },
      onFailed: () => setFailedKey(key),
    });
    requestRef.current = request;
    globalThis.addEventListener("online", request.retry);
    return () => {
      request.dispose();
      if (requestRef.current === request) requestRef.current = undefined;
      globalThis.removeEventListener("online", request.retry);
    };
  }, [key, value]);
  useEffect(() => { requestRef.current?.setVisible(visible); }, [key, value, visible]);
  return { value, failed: failedKey === key && value === undefined };
};
