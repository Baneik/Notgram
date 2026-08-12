import { describe, expect, it, vi } from "vitest";
import {
  AppDesktopSettings,
  type DesktopSettings,
  type DesktopSettingsBridge,
} from "./desktopSettings";

const settings = (overrides: Partial<DesktopSettings> = {}): DesktopSettings => ({
  launchOnStartup: false,
  supported: true,
  ...overrides,
});

const bridge = (overrides: Partial<DesktopSettingsBridge> = {}): DesktopSettingsBridge => ({
  available: () => true,
  settings: async () => settings(),
  setLaunchOnStartup: async (enabled) => settings({ launchOnStartup: enabled }),
  ...overrides,
});

describe("AppDesktopSettings", () => {
  it("keeps startup controls unavailable in browser previews", async () => {
    const read = vi.fn(async () => settings({ launchOnStartup: true }));
    const write = vi.fn(async () => settings({ launchOnStartup: true }));
    const desktop = new AppDesktopSettings(bridge({
      available: () => false,
      settings: read,
      setLaunchOnStartup: write,
    }));

    await expect(desktop.settings()).resolves.toEqual({
      launchOnStartup: false,
      supported: false,
    });
    await expect(desktop.setLaunchOnStartup(true)).resolves.toEqual({
      launchOnStartup: false,
      supported: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("updates the native startup setting only after an explicit toggle", async () => {
    const write = vi.fn(async (enabled: boolean) => settings({ launchOnStartup: enabled }));
    const desktop = new AppDesktopSettings(bridge({ setLaunchOnStartup: write }));

    await expect(desktop.settings()).resolves.toEqual(settings());
    expect(write).not.toHaveBeenCalled();
    await expect(desktop.setLaunchOnStartup(true)).resolves.toEqual(
      settings({ launchOnStartup: true }),
    );
    expect(write).toHaveBeenCalledOnce();
  });
});
