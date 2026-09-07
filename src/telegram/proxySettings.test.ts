import { describe, expect, it } from "vitest";
import { mergeProxySettingsDraft } from "./proxySettings";
import type { ProxySettings } from "./types";

const saved: ProxySettings = { mode: "system", profiles: [], activeProfileId: "", autoSwitch: false, revision: 1 };
describe("proxy settings drafts", () => {
  it("loads the initial configuration and refreshes untouched drafts", () => {
    const next = { ...saved, revision: 2, mode: "direct" as const };
    expect(mergeProxySettingsDraft(saved, undefined, next)).toEqual(next);
    expect(mergeProxySettingsDraft(saved, saved, next)).toEqual(next);
  });
  it("preserves unsaved edits during system discovery and advances its revision", () => {
    const draft = { ...saved, mode: "custom" as const };
    const next = { ...saved, revision: 2, systemStatus: { kind: "unavailable" as const } };
    expect(mergeProxySettingsDraft(draft, saved, next)).toMatchObject({ mode: "custom", revision: 2, systemStatus: next.systemStatus });
  });
  it("keeps the old revision when another window saves conflicting intent", () => {
    const draft = { ...saved, mode: "custom" as const };
    const next = { ...saved, mode: "direct" as const, revision: 2 };
    expect(mergeProxySettingsDraft(draft, saved, next)).toMatchObject({ mode: "custom", revision: 1 });
  });
});
