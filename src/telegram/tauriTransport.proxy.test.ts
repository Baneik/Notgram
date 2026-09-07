import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEventListener } from "./transport";
import type { ProxySettings } from "./types";

type Internal = {
  listener?: TelegramEventListener;
  settingsOnly: boolean;
  handleUpdate: (update: TdObject) => void;
  finishInitialChatSync: () => void;
  requestImmediateConnectionRecovery: (force: boolean) => void;
  request: (request: TdObject) => Promise<TdObject>;
};
const settings = (port = 7890): ProxySettings => ({
  mode: "system", profiles: [], activeProfileId: "", autoSwitch: false, revision: 3,
  systemStatus: { kind: "resolved" },
  system: { type: "http", server: "127.0.0.1", port, username: "", password: "", secret: "", httpOnly: false },
});
const setup = (invoke = vi.fn().mockResolvedValue(undefined)) => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  internal.listener = vi.fn();
  internal.finishInitialChatSync();
  return { transport, internal, invoke };
};
const native = (phase: string, state = "connectionStateReady") => ({ "@type": "updateNotgramConnectionState", phase, state });

describe("native proxy recovery boundary", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("saves intent and its revision through the native owner without TDLib mutations", async () => {
    const { transport, invoke } = setup();
    await transport.saveProxySettings(settings());
    expect(invoke).toHaveBeenCalledExactlyOnceWith("telegram_save_proxy_settings", {
      preferences: { mode: "system", profiles: [], activeProfileId: "", autoSwitch: false }, revision: 3,
    }, undefined);
  });

  it("does not blame the proxy when persistence fails", async () => {
    const { transport, internal } = setup(vi.fn().mockRejectedValue(new Error("disk full")));
    await expect(transport.saveProxySettings(settings())).rejects.toThrow("disk full");
    expect(internal.listener).not.toHaveBeenCalledWith({ type: "connection.changed", status: "proxyError" });
  });

  it("coalesces wake signals and waits for native verification after acknowledgement", async () => {
    const { internal, invoke } = setup();
    internal.handleUpdate(native("idle"));
    internal.handleUpdate(native("recovering"));
    internal.requestImmediateConnectionRecovery(true);
    internal.requestImmediateConnectionRecovery(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("telegram_recover_connection", { force: true }, undefined);
    expect(internal.listener).toHaveBeenLastCalledWith({ type: "connection.changed", status: "recovering" });
    // A delayed raw READY must not overwrite a recovery in progress.
    internal.handleUpdate({ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } });
    expect(internal.listener).toHaveBeenLastCalledWith({ type: "connection.changed", status: "recovering" });
    internal.handleUpdate(native("idle"));
    expect(internal.listener).toHaveBeenLastCalledWith({ type: "connection.changed", status: "online" });
  });

  it("keeps settings windows from recovering or shutting down the shared client", async () => {
    const { internal, invoke, transport } = setup();
    internal.settingsOnly = true;
    internal.requestImmediateConnectionRecovery(true);
    await transport.disconnect();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not install a second JS watchdog when connection updates arrive", async () => {
    vi.useFakeTimers();
    const { internal, invoke } = setup();
    internal.handleUpdate({ "@type": "updateConnectionState", state: { "@type": "connectionStateConnectingToProxy" } });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("surfaces failure to dispatch a recovery signal without leaking native details", async () => {
    const { internal } = setup(vi.fn().mockRejectedValue(new Error("private native details")));
    internal.requestImmediateConnectionRecovery(true);
    await vi.waitFor(() => expect(internal.listener).toHaveBeenCalledWith({ type: "sync.error", message: "无法请求连接恢复，后台将继续重试" }));
  });

  it("tests freshly detected system settings rather than the settings dialog snapshot", async () => {
    const { transport, internal, invoke } = setup(vi.fn().mockResolvedValue(settings(7891)));
    internal.request = vi.fn().mockResolvedValue({ seconds: 0.02 });
    await expect(transport.testProxy(settings())).resolves.toBe(20);
    expect(invoke).toHaveBeenCalledWith("telegram_proxy_settings", {}, undefined);
    expect(internal.request).toHaveBeenCalledWith(expect.objectContaining({ "@type": "pingProxy", proxy: expect.objectContaining({ port: 7891 }) }));
  });

  it("never turns unsupported system settings into a direct speed test", async () => {
    const { transport, internal } = setup(vi.fn().mockResolvedValue({ ...settings(), system: undefined, systemStatus: { kind: "unsupported" } }));
    internal.request = vi.fn();
    await expect(transport.testProxy(settings())).rejects.toThrow("系统代理暂不可用");
    expect(internal.request).not.toHaveBeenCalled();
  });
});
