import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlaybackController, type VideoSource, type VideoState } from "./videoPlayback";
import { mediaPlaybackCoordinator } from "./mediaPlayback";
import { updateMediaStreamPlayback } from "./mediaStream";
import type { ViewerMessage } from "../utils/mediaViewerModel";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, convertFileSrc: (path: string) => path }));
vi.mock("./mediaStream", () => ({ updateMediaStreamPlayback: vi.fn().mockResolvedValue(undefined) }));

const message = (fileId = 42): ViewerMessage => ({
  id: `video${fileId}`, chatId: "chat", senderId: "sender", sentAt: "", outgoing: false, delivery: "read",
  content: { kind: "media", mediaType: "video", fileId, size: 1000, fileName: "video.mp4", sizeLabel: "1KB", duration: 100 },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let controller: VideoPlaybackController;
beforeEach(() => { vi.useFakeTimers(); vi.mocked(updateMediaStreamPlayback).mockReset().mockResolvedValue(undefined); controller = new VideoPlaybackController(); });
afterEach(async () => { controller.close(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

const setup = (value = message()) => {
  const stream = vi.fn().mockResolvedValue("stream:42");
  const suspend = vi.fn().mockResolvedValue(undefined);
  const publish = vi.fn<(source: VideoSource) => void>();
  const command = vi.fn();
  controller.open(() => value, { stream, suspend }, publish, command);
  return { stream, suspend, publish, command, value };
};

describe("application video ownership", () => {
  it("grants only the latest seek after ownership validation and suppresses stale playback positions", async () => {
    const current = setup(); await vi.advanceTimersByTimeAsync(0);
    const source = current.publish.mock.lastCall![0];
    const first = deferred<void>(), second = deferred<void>();
    vi.mocked(updateMediaStreamPlayback).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const early = controller.seek(source.key, source.revision, 20);
    const latest = controller.seek(source.key, source.revision, 60);
    controller.state(source.key, source.revision, { ...source, currentTime: 1, phase: "playing", paused: false });
    expect(updateMediaStreamPlayback).toHaveBeenCalledTimes(2);
    expect(current.command).not.toHaveBeenCalled();
    first.resolve(); await early;
    expect(current.command).not.toHaveBeenCalled();
    second.resolve(); await latest;
    expect(current.command).toHaveBeenCalledExactlyOnceWith("seek", source.revision, 60);
    controller.state(source.key, source.revision, { ...source, currentTime: 60, phase: "paused" });
    expect(updateMediaStreamPlayback).toHaveBeenLastCalledWith(42, 60, 100, true, "stream:42");
  });

  it("never grants an acknowledged seek after its viewer closes", async () => {
    const current = setup(); await vi.advanceTimersByTimeAsync(0);
    const source = current.publish.mock.lastCall![0], native = deferred<void>();
    vi.mocked(updateMediaStreamPlayback).mockImplementationOnce(() => native.promise);
    const pending = controller.seek(source.key, source.revision, 30);
    controller.close(); current.command.mockClear(); native.resolve(); await pending;
    expect(current.command).not.toHaveBeenCalled();
  });

  it("releases an acquisition that arrives after close and publishes no late source", async () => {
    const pending = deferred<string>();
    const suspend = vi.fn().mockResolvedValue(undefined), publish = vi.fn();
    controller.open(() => message(), { stream: () => pending.promise, suspend }, publish, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    controller.close(); pending.resolve("stream:late"); await vi.advanceTimersByTimeAsync(0);
    expect(suspend).toHaveBeenCalledExactlyOnceWith(42, "stream:late");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("serializes old release before another acquisition of the same file", async () => {
    const pending = deferred<string>(), order: string[] = [];
    controller.open(() => message(), { stream: () => pending.promise, suspend: async () => { order.push("released"); } }, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    controller.open(() => message(), { stream: async () => { order.push("acquired"); return "new"; } }, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0); expect(order).toEqual([]);
    pending.resolve("old"); await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["released", "acquired"]);
  });

  it("does not block a different file behind a cancelled source", async () => {
    const pending = deferred<string>();
    controller.open(() => message(), { stream: () => pending.promise }, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const next = setup(message(43)); await vi.advanceTimersByTimeAsync(0);
    expect(next.stream).toHaveBeenCalledOnce();
    pending.resolve("old");
  });

  it("retains the lease when a download adds a local source", async () => {
    const current = setup(); await vi.advanceTimersByTimeAsync(0);
    current.value.content.localPath = "downloaded.mp4";
    controller.close(); await vi.advanceTimersByTimeAsync(0);
    expect(current.suspend).toHaveBeenCalledExactlyOnceWith(42, "stream:42");
  });

  it("does not activate playback from delayed state messages after audio takes ownership", async () => {
    const current = setup(); await vi.advanceTimersByTimeAsync(0);
    const source = current.publish.mock.lastCall![0];
    const audio = { pause: vi.fn() };
    mediaPlaybackCoordinator.activate("audio", audio);
    expect(current.command).toHaveBeenLastCalledWith("pause", source.revision);
    controller.state(source.key, source.revision, { ...source, phase: "playing", paused: false });
    expect(audio.pause).not.toHaveBeenCalled();
    controller.requestPlay(source.key, source.revision);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(current.command).toHaveBeenLastCalledWith("play", source.revision);
    mediaPlaybackCoordinator.release(audio);
  });

  it("cancels pending autoplay when audio starts during preparation", async () => {
    const pending = deferred<string>(), publish = vi.fn();
    controller.open(() => message(), { stream: () => pending.promise }, publish, vi.fn());
    const preparing = publish.mock.lastCall![0];
    controller.state(preparing.key, preparing.revision, { ...preparing, phase: "preparing", paused: true });
    const audio = { pause: vi.fn() }; mediaPlaybackCoordinator.activate("audio", audio);
    pending.resolve("late"); await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall![0]).toMatchObject({ autoplay: false, source: "late" });
    mediaPlaybackCoordinator.release(audio);
  });

  it("rejects actions from a previous source revision and retains progress on retry", async () => {
    const current = setup(); await vi.advanceTimersByTimeAsync(0);
    const source = current.publish.mock.lastCall![0];
    const state: VideoState = { ...source, currentTime: 35, phase: "failed", paused: true, volume: 0.6, rate: 1.5 };
    controller.state(source.key, source.revision, state);
    controller.retry(source.key, source.revision); await vi.advanceTimersByTimeAsync(0);
    const retried = current.publish.mock.lastCall![0];
    expect(retried).toMatchObject({ currentTime: 35, volume: 0.6, rate: 1.5, source: "stream:42" });
    expect(retried.revision).not.toBe(source.revision);
    current.command.mockClear(); controller.requestPlay(source.key, source.revision);
    expect(current.command).not.toHaveBeenCalled();
    expect(current.suspend).toHaveBeenCalledOnce();
  });

  it("reports source failure and retries without replacing the window session", async () => {
    const stream = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("recovered"), publish = vi.fn();
    controller.open(() => message(), { stream }, publish, vi.fn()); await vi.advanceTimersByTimeAsync(0);
    const failed = publish.mock.lastCall![0]; expect(failed).toMatchObject({ phase: "failed", failure: "source" });
    controller.retry(failed.key, failed.revision); await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall![0]).toMatchObject({ source: "recovered", failure: undefined });
  });

  it("leases local files without replacing their local playback source", async () => {
    const value = message(); value.content.localPath = "/cached.mp4";
    const current = setup(value); await vi.advanceTimersByTimeAsync(0);
    expect(current.publish.mock.lastCall![0]).toMatchObject({ source: "/cached.mp4", streaming: false });
    controller.close(); await vi.advanceTimersByTimeAsync(0);
    expect(current.suspend).toHaveBeenCalledExactlyOnceWith(42, "stream:42");
  });

  it("uses the recovered stream even while the viewer still describes a failed local path", async () => {
    const value = message(); value.content.localPath = "/stale.mp4";
    const stream = vi.fn().mockResolvedValue("fresh-stream"), suspend = vi.fn(), recover = vi.fn().mockResolvedValue(true), publish = vi.fn();
    controller.open(() => value, { stream, suspend, recover }, publish, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const source = publish.mock.lastCall![0];
    controller.retry(source.key, source.revision); await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledExactlyOnceWith(42, 32);
    expect(publish.mock.lastCall![0]).toMatchObject({ source: "fresh-stream", streaming: true });
  });

  it("makes a timed-out acquisition retryable and retires its eventual result", async () => {
    const late = deferred<string>();
    const stream = vi.fn().mockImplementationOnce(() => late.promise).mockResolvedValueOnce("retry");
    const suspend = vi.fn().mockResolvedValue(undefined), publish = vi.fn();
    controller.open(() => message(), { stream, suspend }, publish, vi.fn());
    await vi.advanceTimersByTimeAsync(15_000);
    const failed = publish.mock.lastCall![0]; expect(failed.failure).toBe("network");
    controller.retry(failed.key, failed.revision);
    late.resolve("late"); await vi.advanceTimersByTimeAsync(0);
    expect(suspend).toHaveBeenCalledExactlyOnceWith(42, "late");
    expect(publish.mock.lastCall![0]).toMatchObject({ source: "retry", failure: undefined });
    expect(publish.mock.calls.some(([value]) => value.source === "late")).toBe(false);
  });
});
