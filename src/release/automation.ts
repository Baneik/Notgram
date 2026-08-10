import { isTauri } from "@tauri-apps/api/core";

export interface AutomationPreferences {
  enabled: boolean;
  port: number;
}

export interface AutomationSettings extends AutomationPreferences {
  active: boolean;
  activePort?: number;
  restartRequired: boolean;
  launchOverride: boolean;
}

export interface AutomationBridge {
  available: () => boolean;
  settings: () => Promise<AutomationSettings>;
  save: (preferences: AutomationPreferences) => Promise<AutomationSettings>;
}

const disabledSettings: AutomationSettings = {
  enabled: false,
  port: 9333,
  active: false,
  restartRequired: false,
  launchOverride: false,
};

export class AppAutomation {
  constructor(private readonly bridge: AutomationBridge) {}

  isAvailable() {
    return this.bridge.available();
  }

  settings() {
    return this.isAvailable() ? this.bridge.settings() : Promise.resolve(disabledSettings);
  }

  save(preferences: AutomationPreferences) {
    return this.isAvailable() ? this.bridge.save(preferences) : Promise.resolve(disabledSettings);
  }
}

export const appAutomation = new AppAutomation({
  available: isTauri,
  settings: async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AutomationSettings>("notgram_automation_settings");
  },
  save: async (preferences) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AutomationSettings>("notgram_save_automation_settings", { preferences });
  },
});
