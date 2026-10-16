/** Give painted UI and queued input priority over the next history page.
 * The timeout also releases work when a WebView is hidden between frames. */
export const yieldToBackground = () => {
  if (typeof document === "undefined") return Promise.resolve();
  return new Promise<void>(resolve => {
    let frame: number | undefined;
    let idle: number | undefined;
    const finish = () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (idle !== undefined) cancelIdleCallback(idle);
      resolve();
    };
    const timer = setTimeout(finish, 150);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (typeof requestIdleCallback === "function") {
          idle = requestIdleCallback(finish, { timeout: 100 });
        } else finish();
      });
    });
  });
};
