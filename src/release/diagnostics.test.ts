import { describe, expect, it, vi } from "vitest";
import { AppDiagnostics, type DiagnosticsBridge } from "./diagnostics";

const bridge = (overrides: Partial<DiagnosticsBridge> = {}): DiagnosticsBridge => ({
  available: () => true,
  settings: async () => ({ crashReportingEnabled: false }),
  setCrashReportingEnabled: async (enabled) => ({ crashReportingEnabled: enabled }),
  exportBundle: async () => true,
  ...overrides,
});

describe("AppDiagnostics", () => {
  it("fails closed without invoking native diagnostics in browser previews", async () => {
    const settings = vi.fn(async () => ({ crashReportingEnabled: true }));
    const setCrashReportingEnabled = vi.fn(async () => ({ crashReportingEnabled: true }));
    const exportBundle = vi.fn(async () => true);
    const diagnostics = new AppDiagnostics(bridge({
      available: () => false,
      settings,
      setCrashReportingEnabled,
      exportBundle,
    }));

    await expect(diagnostics.settings()).resolves.toEqual({ crashReportingEnabled: false });
    await expect(diagnostics.setCrashReportingEnabled(true)).resolves.toEqual({ crashReportingEnabled: false });
    await expect(diagnostics.exportBundle()).resolves.toBe(false);
    expect(settings).not.toHaveBeenCalled();
    expect(setCrashReportingEnabled).not.toHaveBeenCalled();
    expect(exportBundle).not.toHaveBeenCalled();
  });

  it("changes crash consent and exports only after explicit calls", async () => {
    const setCrashReportingEnabled = vi.fn(async (enabled: boolean) => ({
      crashReportingEnabled: enabled,
    }));
    const exportBundle = vi.fn(async () => true);
    const diagnostics = new AppDiagnostics(bridge({ setCrashReportingEnabled, exportBundle }));

    await expect(diagnostics.settings()).resolves.toEqual({ crashReportingEnabled: false });
    await expect(diagnostics.setCrashReportingEnabled(true)).resolves.toEqual({ crashReportingEnabled: true });
    await expect(diagnostics.exportBundle()).resolves.toBe(true);
    expect(setCrashReportingEnabled).toHaveBeenCalledOnce();
    expect(exportBundle).toHaveBeenCalledOnce();
  });
});
