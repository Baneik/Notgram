import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeSettingsBackup, encodeSettingsBackup, createSettingsBackup } from "./settingsBackup";

let values: Map<string, string>;
let stop: (() => void) | undefined;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.resetModules(); });

it("keeps a pristine startup clean and ignores runtime and diagnostic state", async () => {
  const runtime = await import("./backupRuntime");
  const { preferencesStore } = await import("../store/preferencesStore");
  stop = runtime.startSettingsBackupSync();
  const original = values.get("notgram:backup:revisions:v1");
  expect(Object.values(runtime.currentSettingsBackup().revisions).every(value => value === 0)).toBe(true);
  preferencesStore.setState({ systemReduceMotion: true, developerMode: true, performanceMonitoringEnabled: false });
  expect(values.get("notgram:backup:revisions:v1")).toBe(original);
});

it("recognizes preexisting customized settings so the first cloud backup includes them", async () => {
  values.set("notgram:preferences:v1", JSON.stringify({ chatFontSize: 18 }));
  const runtime = await import("./backupRuntime");
  stop = runtime.startSettingsBackupSync();
  const backup = decodeSettingsBackup(values.get("notgram:backup:revisions:v1")!);
  expect(backup.preferences.chatFontSize).toBe(18);
  expect(backup.revisions.chatFontSize).toBeGreaterThan(0);
  expect(backup.revisions.notificationSound).toBe(0);
});

it("restores validated partial settings atomically while preserving non-backup preferences", async () => {
  const runtime = await import("./backupRuntime");
  const { preferencesStore } = await import("../store/preferencesStore");
  stop = runtime.startSettingsBackupSync();
  preferencesStore.getState().setPreference("developerMode", true);
  const imported = encodeSettingsBackup(createSettingsBackup({ chatFontSize: 18, reduceMotion: true }));
  runtime.restoreSettingsBackup(imported);
  expect(preferencesStore.getState().chatFontSize).toBe(18);
  expect(preferencesStore.getState().effectiveReduceMotion).toBe(true);
  expect(preferencesStore.getState().developerMode).toBe(true);
  const snapshot = runtime.currentSettingsBackup();
  expect(() => runtime.restoreSettingsBackup("broken")).toThrow("invalid-backup");
  expect(runtime.currentSettingsBackup()).toEqual(snapshot);
  expect(snapshot.revisions.chatFontSize).toBeGreaterThan(0);
});

it("retains pending revisions across application restarts", async () => {
  const runtime = await import("./backupRuntime");
  const { preferencesStore } = await import("../store/preferencesStore");
  stop = runtime.startSettingsBackupSync();
  preferencesStore.getState().setPreference("adBlockKeywords", ["测试😀"]);
  const original = runtime.currentSettingsBackup();
  stop(); stop = undefined;
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  const restarted = await import("./backupRuntime");
  stop = restarted.startSettingsBackupSync();
  expect(restarted.currentSettingsBackup()).toEqual(original);
});

it("preserves the existing next-startup policy for Zalgo normalization", async () => {
  const runtime = await import("./backupRuntime");
  const { preferencesStore } = await import("../store/preferencesStore");
  const identity = await import("../telegram/identityText");
  stop = runtime.startSettingsBackupSync();
  const before = identity.normalizeIdentityText("a\u0301");
  runtime.restoreSettingsBackup(encodeSettingsBackup(createSettingsBackup({ blockZalgoText: false })));
  expect(preferencesStore.getState().blockZalgoText).toBe(false);
  expect(identity.normalizeIdentityText("a\u0301")).toBe(before);
  stop(); stop = undefined;
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  await import("../store/preferencesStore");
  const restartedIdentity = await import("../telegram/identityText");
  expect(restartedIdentity.normalizeIdentityText("a\u0301")).toBe("a\u0301");
});
