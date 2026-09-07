export interface ResourceRetryState { failures: number; notBefore: number }

/** Shared by message media and picker resources. In-flight downloads remain deduplicated by TDLib. */
export const createVisibleResourceRequest = <T>(options: {
  load: () => Promise<T>;
  onLoaded?: (value: T) => void;
  onFailed?: () => void;
  retryState?: ResourceRetryState;
}) => {
  const retryState = options.retryState ?? { failures: 0, notBefore: 0 };
  let visible = false;
  let disposed = false;
  let pending = false;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const request = () => {
    clearTimer();
    if (disposed || !visible || pending || completed) return;
    const delay = Math.max(0, retryState.notBefore - Date.now());
    if (delay) { timer = setTimeout(request, delay); return; }
    pending = true;
    void Promise.resolve().then(options.load).then((value) => {
      if (disposed) return;
      completed = true;
      retryState.failures = 0;
      retryState.notBefore = 0;
      options.onLoaded?.(value);
    }).catch(() => {
      if (disposed) return;
      retryState.failures += 1;
      retryState.notBefore = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(retryState.failures - 1, 6));
      options.onFailed?.();
    }).finally(() => {
      pending = false;
      if (!disposed && !completed) request();
    });
  };
  return {
    setVisible: (next: boolean) => { visible = next; request(); },
    retry: () => { if (completed || pending) return; retryState.notBefore = 0; request(); },
    dispose: () => { disposed = true; clearTimer(); },
  };
};
