import { describe, expect, it, vi } from "vitest";
import {
  AppAutomation,
  type AutomationBridge,
  type AutomationSettings,
} from "./automation";

const settings = (overrides: Partial<AutomationSettings> = {}): AutomationSettings => ({
  enabled: false,
  port: 9333,
  active: false,
  restartRequired: false,
  launchOverride: false,
  ...overrides,
});

const bridge = (overrides: Partial<AutomationBridge> = {}): AutomationBridge => ({
  available: () => true,
  settings: async () => settings(),
  save: async (preferences) => settings({ ...preferences, restartRequired: true }),
  ...overrides,
});

describe("AppAutomation", () => {
  it("fails closed in browser previews", async () => {
    const read = vi.fn(async () => settings({ enabled: true, active: true }));
    const save = vi.fn(async () => settings({ enabled: true }));
    const automation = new AppAutomation(bridge({ available: () => false, settings: read, save }));

    await expect(automation.settings()).resolves.toEqual(settings());
    await expect(automation.save({ enabled: true, port: 9444 })).resolves.toEqual(settings());
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("persists only after an explicit save", async () => {
    const save = vi.fn(async (preferences) => settings({
      ...preferences,
      restartRequired: true,
    }));
    const automation = new AppAutomation(bridge({ save }));

    await expect(automation.settings()).resolves.toEqual(settings());
    await expect(automation.save({ enabled: true, port: 9444 })).resolves.toEqual(
      settings({ enabled: true, port: 9444, restartRequired: true }),
    );
    expect(save).toHaveBeenCalledOnce();
  });
});
