import { afterEach, expect, it, vi } from "vitest";
import { yieldToBackground } from "./yieldToBackground";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("allows a complete paint before using idle time and clears fallback work", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", {});
  const frames: FrameRequestCallback[] = [];
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { frames.push(callback); return frames.length; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("requestIdleCallback", vi.fn(callback => { idle.push(callback); return 1; }));
  const cancelIdle = vi.fn();
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  let done = false;
  const pending = yieldToBackground().then(() => { done = true; });
  frames.shift()!(0);
  await Promise.resolve();
  expect(done).toBe(false);
  expect(idle).toHaveLength(0);
  frames.shift()!(16);
  expect(done).toBe(false);
  idle.shift()!({ didTimeout: false, timeRemaining: () => 8 });
  await pending;
  expect(done).toBe(true);
  expect(cancelIdle).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases a backgrounded viewport without waiting for throttled frames", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", {});
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 9));
  const cancelFrame = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const pending = yieldToBackground();
  await vi.advanceTimersByTimeAsync(150);
  await pending;
  expect(cancelFrame).toHaveBeenCalledWith(9);
  expect(vi.getTimerCount()).toBe(0);
});
