import { afterEach, describe, expect, it, vi } from "vitest";
import { installConnectionRecoveryMonitor } from "./connectionRecoveryMonitor";

describe("connection recovery lifecycle", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setup = () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    const recover = vi.fn();
    dispose = installConnectionRecoveryMonitor(recover);
    return { window, document, recover };
  };

  it("nudges native recovery after timer suspension and coalesces foreground events", async () => {
    const { window, document, recover } = setup();
    vi.setSystemTime(200_000);
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(recover).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not force an online client to reconnect after a long tray stay", async () => {
    const { document, recover } = setup();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(recover).not.toHaveBeenCalled();
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(recover).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("handles native window focus without a visibility transition and removes listeners", async () => {
    const { window, recover } = setup();
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("focus"));
    expect(recover).toHaveBeenCalledExactlyOnceWith(false);
    dispose?.();
    recover.mockClear();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).not.toHaveBeenCalled();
  });
});
