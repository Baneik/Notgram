import { isTauri } from "@tauri-apps/api/core";

export interface DiagnosticsSettings {
  crashReportingEnabled: boolean;
}

export interface DiagnosticsBridge {
  available: () => boolean;
  settings: () => Promise<DiagnosticsSettings>;
  setCrashReportingEnabled: (enabled: boolean) => Promise<DiagnosticsSettings>;
  exportBundle: () => Promise<boolean>;
}

const disabledSettings: DiagnosticsSettings = { crashReportingEnabled: false };

export class AppDiagnostics {
  constructor(private readonly bridge: DiagnosticsBridge) {}

  isAvailable() {
    return this.bridge.available();
  }

  async settings() {
    return this.isAvailable() ? this.bridge.settings() : disabledSettings;
  }

  async setCrashReportingEnabled(enabled: boolean) {
    if (!this.isAvailable()) return disabledSettings;
    return this.bridge.setCrashReportingEnabled(enabled);
  }

  async exportBundle() {
    return this.isAvailable() ? this.bridge.exportBundle() : false;
  }
}

export const appDiagnostics = new AppDiagnostics({
  available: isTauri,
  settings: async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DiagnosticsSettings>("notgram_diagnostics_settings");
  },
  setCrashReportingEnabled: async (enabled) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DiagnosticsSettings>("notgram_set_crash_reporting_enabled", { enabled });
  },
  exportBundle: async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("notgram_export_diagnostics");
  },
});
