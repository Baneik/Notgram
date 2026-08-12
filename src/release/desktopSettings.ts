import { invoke, isTauri } from "@tauri-apps/api/core";

export interface DesktopSettings {
  launchOnStartup: boolean;
  supported: boolean;
}

const browserDefaults: DesktopSettings = {
  launchOnStartup: false,
  supported: false,
};

export interface DesktopSettingsBridge {
  available: () => boolean;
  settings: () => Promise<DesktopSettings>;
  setLaunchOnStartup: (enabled: boolean) => Promise<DesktopSettings>;
}

const nativeBridge: DesktopSettingsBridge = {
  available: isTauri,
  settings: () => invoke<DesktopSettings>("notgram_desktop_settings"),
  setLaunchOnStartup: (enabled) => invoke<DesktopSettings>(
    "notgram_set_launch_on_startup",
    { enabled },
  ),
};

export class AppDesktopSettings {
  constructor(private readonly bridge: DesktopSettingsBridge = nativeBridge) {}

  async settings(): Promise<DesktopSettings> {
    if (!this.bridge.available()) return browserDefaults;
    return this.bridge.settings();
  }

  async setLaunchOnStartup(enabled: boolean): Promise<DesktopSettings> {
    if (!this.bridge.available()) return browserDefaults;
    return this.bridge.setLaunchOnStartup(enabled);
  }
}

export const desktopSettings = new AppDesktopSettings();
