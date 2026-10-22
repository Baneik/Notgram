import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsBackup, decodeSettingsBackup, encodeSettingsBackup, type SettingsBackup } from "./settingsBackup";
import { SettingsSync, type SyncDependencies } from "./settingsSync";
import type { WebDavResponse } from "./webdavBridge";

afterEach(() => vi.useRealTimers());
const response = (backup: SettingsBackup, etag = '"v1"'): WebDavResponse => ({ status: 200, body: encodeSettingsBackup(backup), etag });
function setup(local = createSettingsBackup({ chatFontSize: 14 }), remote = local) {
  let value = local;
  const dependencies = {
    snapshot: () => value,
    apply: vi.fn((backup: SettingsBackup) => { value = backup; }),
    config: vi.fn(async () => ({ enabled: true, url: "https://example.com/dav", hasUsername: true, hasPassword: true, generation: "one" })),
    request: vi.fn<SyncDependencies["request"]>(async () => response(remote)),
    status: vi.fn<SyncDependencies["status"]>(),
  };
  return { sync: new SettingsSync(dependencies), dependencies, set: (backup: SettingsBackup) => { value = backup; } };
}

describe("background WebDAV synchronization", () => {
  it("reads once on startup without uploading identical settings", async () => {
    const { sync, dependencies } = setup();
    await sync.run();
    expect(dependencies.request.mock.calls).toEqual([["GET", "one"]]);
    expect(dependencies.status).toHaveBeenLastCalledWith("synced");
  });
  it("downloads newer settings without echoing them to the server", async () => {
    const remote = createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 });
    const { sync, dependencies } = setup(createSettingsBackup({ chatFontSize: 14 }), remote);
    await sync.run();
    expect(dependencies.apply).toHaveBeenCalledWith(remote);
    expect(dependencies.request).toHaveBeenCalledTimes(1);
  });
  it("does not upload untouched defaults absent from a partial cloud backup", async () => {
    const local = createSettingsBackup({ chatFontSize: 14, notificationSound: true });
    const { sync, dependencies } = setup(local, createSettingsBackup({ chatFontSize: 14 }));
    await sync.run();
    expect(dependencies.request.mock.calls).toEqual([["GET", "one"]]);
    expect(dependencies.status).toHaveBeenLastCalledWith("synced");
  });
  it("uploads local changes with the observed ETag", async () => {
    const local = createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 });
    const { sync, dependencies } = setup(local, createSettingsBackup({ chatFontSize: 14 }));
    dependencies.request.mockResolvedValueOnce(response(createSettingsBackup({ chatFontSize: 14 }))).mockResolvedValueOnce({ status: 204, body: "", etag: null });
    await sync.run();
    expect(dependencies.request.mock.calls[1]).toEqual(["PUT", "one", encodeSettingsBackup(local), '"v1"', false]);
  });
  it("creates a missing cloud file only after an actual settings edit", async () => {
    const { sync, dependencies, set } = setup();
    dependencies.request.mockResolvedValue({ status: 404, body: "", etag: null });
    await sync.run();
    expect(dependencies.request).toHaveBeenCalledTimes(1);
    set(createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 }));
    dependencies.request.mockResolvedValueOnce({ status: 404, body: "", etag: null }).mockResolvedValueOnce({ status: 201, body: "", etag: null });
    await sync.run();
    expect(dependencies.request.mock.lastCall?.slice(0, 2)).toEqual(["PUT", "one"]);
    expect(dependencies.request.mock.lastCall?.slice(3)).toEqual([undefined, true]);
  });
  it("debounces edits and reads the final preferences", async () => {
    vi.useFakeTimers();
    const { sync, dependencies, set } = setup();
    for (const size of [16, 17, 18]) {
      set(createSettingsBackup({ chatFontSize: size }, { chatFontSize: 30 }));
      sync.changed();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(dependencies.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(decodeSettingsBackup(dependencies.request.mock.calls[1][2]!).preferences.chatFontSize).toBe(18);
    sync.stop();
  });
  it.each([401, 403, 500])("preserves local settings and never PUTs after HTTP %d", async status => {
    const { sync, dependencies } = setup();
    dependencies.request.mockResolvedValue({ status, body: "", etag: null });
    await sync.run();
    expect(dependencies.request).toHaveBeenCalledTimes(1);
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(dependencies.status).toHaveBeenLastCalledWith("error", `http-${status}`);
  });
  it("does not overwrite a malformed remote backup", async () => {
    const { sync, dependencies } = setup();
    dependencies.request.mockResolvedValue({ status: 200, body: "broken", etag: '"v1"' });
    await sync.run();
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(dependencies.request).toHaveBeenCalledTimes(1);
    expect(dependencies.status).toHaveBeenLastCalledWith("error", "invalid-backup");
  });
  it.each([null, 'W/"v1"'])("refuses unsafe replacement without a strong ETag %s", async etag => {
    const { sync, dependencies } = setup(createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 }));
    dependencies.request.mockResolvedValue({ ...response(createSettingsBackup({ chatFontSize: 14 })), etag });
    await sync.run();
    expect(dependencies.request).toHaveBeenCalledTimes(1);
    expect(dependencies.status).toHaveBeenLastCalledWith("error", "missing-etag");
  });
  it("rereads and merges after a conditional write conflict", async () => {
    const local = createSettingsBackup({ chatFontSize: 18, notificationSound: true }, { chatFontSize: 30 });
    const cloud = createSettingsBackup({ chatFontSize: 14, notificationSound: false }, { notificationSound: 40 });
    const { sync, dependencies } = setup(local);
    dependencies.request.mockResolvedValueOnce(response(createSettingsBackup({ chatFontSize: 14 })))
      .mockResolvedValueOnce({ status: 412, body: "", etag: null })
      .mockResolvedValueOnce(response(cloud, '"v2"'))
      .mockResolvedValueOnce({ status: 204, body: "", etag: null });
    await sync.run();
    const call = dependencies.request.mock.lastCall!;
    expect(call[0]).toBe("PUT");
    expect(call[3]).toBe('"v2"');
    expect(decodeSettingsBackup(call[2]!).preferences).toEqual({ chatFontSize: 18, notificationSound: false });
  });
  it("ignores an old response after a configuration change", async () => {
    const { sync, dependencies } = setup();
    let release!: (response: WebDavResponse) => void;
    dependencies.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const run = sync.run();
    await vi.waitFor(() => expect(dependencies.request).toHaveBeenCalled());
    sync.reconfigure();
    release(response(createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 })));
    await run;
    expect(dependencies.apply).not.toHaveBeenCalled();
    sync.stop();
  });
  it("releases the controller after a network failure and retries with fresh state", async () => {
    const { sync, dependencies } = setup();
    dependencies.request.mockRejectedValueOnce(new Error("network"));
    await sync.run();
    expect(dependencies.status).toHaveBeenLastCalledWith("error", "network");
    await sync.run();
    expect(dependencies.status).toHaveBeenLastCalledWith("synced");
  });
  it("never contacts the server while disabled", async () => {
    const { sync, dependencies } = setup();
    dependencies.config.mockResolvedValue({ enabled: false, url: "", hasUsername: false, hasPassword: false, generation: "two" });
    await sync.run();
    expect(dependencies.request).not.toHaveBeenCalled();
  });
  it("bounds repeated concurrent-write conflicts", async () => {
    const { sync, dependencies } = setup(createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 }));
    dependencies.request.mockImplementation(async method => method === "GET"
      ? response(createSettingsBackup({ chatFontSize: 14 })) : { status: 412, body: "", etag: null });
    await sync.run();
    expect(dependencies.request).toHaveBeenCalledTimes(6);
    expect(dependencies.status).toHaveBeenLastCalledWith("error", "conflict");
  });
  it("serializes changes made during upload and follows them with a fresh read", async () => {
    vi.useFakeTimers();
    const local = createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 30 });
    const { sync, dependencies, set } = setup(local);
    let release!: (response: WebDavResponse) => void;
    dependencies.request.mockResolvedValueOnce(response(createSettingsBackup({ chatFontSize: 14 })))
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const run = sync.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.request).toHaveBeenCalledTimes(2);
    set(createSettingsBackup({ chatFontSize: 20 }, { chatFontSize: 40 }));
    sync.changed();
    release({ status: 204, body: "", etag: null });
    await run;
    dependencies.request.mockResolvedValueOnce(response(local)).mockResolvedValueOnce({ status: 204, body: "", etag: null });
    await vi.advanceTimersByTimeAsync(1200);
    expect(dependencies.request.mock.calls.map(call => call[0])).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(decodeSettingsBackup(dependencies.request.mock.lastCall![2]!).preferences.chatFontSize).toBe(20);
    sync.stop();
  });
});
