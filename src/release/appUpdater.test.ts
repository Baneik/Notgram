import { describe, expect, it, vi } from "vitest";
import { AppUpdater, type AppUpdaterBridge, type AppUpdateProgress } from "./appUpdater";

const update = (overrides: Partial<Awaited<ReturnType<AppUpdaterBridge["check"]>>> = {}) => ({
  currentVersion: "0.5.0-rc.1",
  version: "0.5.0",
  date: "2026-08-03T00:00:00Z",
  body: " Release notes ",
  downloadAndInstall: vi.fn(async (onEvent: (event: {
    event: "Started" | "Progress" | "Finished";
    data?: { contentLength?: number; chunkLength?: number };
  }) => void) => {
    onEvent({ event: "Started", data: { contentLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 40 } });
    onEvent({ event: "Progress", data: { chunkLength: 60 } });
    onEvent({ event: "Finished" });
  }),
  close: vi.fn(async () => undefined),
  ...overrides,
});

const bridge = (overrides: Partial<AppUpdaterBridge> = {}): AppUpdaterBridge => ({
  available: () => true,
  currentVersion: async () => "0.5.0-rc.1",
  check: async () => null,
  relaunch: async () => undefined,
  ...overrides,
});

describe("AppUpdater", () => {
  it("does not contact the native updater outside Tauri", async () => {
    const check = vi.fn(async () => null);
    const updater = new AppUpdater(bridge({ available: () => false, check }));
    expect(await updater.check()).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it("returns bounded update metadata and closes stale update handles", async () => {
    const first = update({ body: ` ${"a".repeat(5_000)} ` });
    const second = update({ version: "0.5.1" });
    const check = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const updater = new AppUpdater(bridge({ check }));

    const firstInfo = await updater.check();
    expect(firstInfo?.notes).toHaveLength(4_000);
    expect(await updater.check()).toMatchObject({ version: "0.5.1" });
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("installs with cumulative progress and relaunches only after success", async () => {
    const candidate = update();
    const relaunch = vi.fn(async () => undefined);
    const updater = new AppUpdater(bridge({ check: async () => candidate, relaunch }));
    const progress: AppUpdateProgress[] = [];

    await updater.check();
    await updater.install((event) => progress.push(event));

    expect(progress.map((event) => event.fraction)).toEqual([0, 0.4, 1, 1]);
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("keeps a failed update available for a retry and does not relaunch", async () => {
    const failure = new Error("download failed");
    const candidate = update({ downloadAndInstall: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined) });
    const relaunch = vi.fn(async () => undefined);
    const updater = new AppUpdater(bridge({ check: async () => candidate, relaunch }));

    await updater.check();
    await expect(updater.install(() => undefined)).rejects.toThrow("download failed");
    expect(relaunch).not.toHaveBeenCalled();
    await updater.install(() => undefined);
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
