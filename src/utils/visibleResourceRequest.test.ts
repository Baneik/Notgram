import { afterEach, expect, it, vi } from "vitest";
import { createVisibleResourceRequest } from "./visibleResourceRequest";

afterEach(() => vi.useRealTimers());

it("retries a transient failure without remounting, and stops after success", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ready");
  const onLoaded = vi.fn();
  const request = createVisibleResourceRequest({ load, onLoaded });
  request.setVisible(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(onLoaded).toHaveBeenCalledWith("ready");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(2);
  request.dispose();
});

it("does not retry hidden resources and resumes immediately on recovery", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValue(new Error("offline"));
  const request = createVisibleResourceRequest({ load });
  request.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  request.setVisible(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(load).toHaveBeenCalledTimes(1);
  request.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  request.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
  request.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(3);
});

it("ignores late results after disposal and avoids concurrent requests", async () => {
  let finish!: (value: string) => void;
  const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const onLoaded = vi.fn();
  const request = createVisibleResourceRequest({ load, onLoaded });
  request.setVisible(true);
  request.retry();
  await Promise.resolve();
  request.dispose();
  finish("old account");
  await Promise.resolve();
  await Promise.resolve();
  expect(load).toHaveBeenCalledOnce();
  expect(onLoaded).not.toHaveBeenCalled();
});
