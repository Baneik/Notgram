import type { ProxySettings } from "./types";

export const proxyPreferences = (settings: ProxySettings) => ({
  mode: settings.mode,
  profiles: settings.profiles,
  activeProfileId: settings.activeProfileId,
  autoSwitch: settings.autoSwitch,
});

const samePreferences = (a: ProxySettings, b: ProxySettings) =>
  JSON.stringify(proxyPreferences(a)) === JSON.stringify(proxyPreferences(b));

/** Refresh discovery without discarding edits or hiding a concurrent save. */
export const mergeProxySettingsDraft = (
  draft: ProxySettings,
  previous: ProxySettings | undefined,
  next: ProxySettings,
): ProxySettings => {
  if (!previous || samePreferences(draft, previous) || samePreferences(draft, next)) {
    return structuredClone(next);
  }
  return {
    ...draft,
    system: next.system,
    systemStatus: next.systemStatus,
    runtimeProfileId: next.runtimeProfileId,
    revision: samePreferences(previous, next) ? next.revision : draft.revision,
  };
};
