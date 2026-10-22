import { describe, expect, it } from "vitest";
import { createSettingsBackup, decodeSettingsBackup, encodeSettingsBackup, MAX_BACKUP_BYTES, mergeSettingsBackups } from "./settingsBackup";
import { reviseBackup } from "./settingsSync";

const raw = (value: unknown) => btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), byte => String.fromCharCode(byte)).join(""));
describe("settings backup privacy and format", () => {
  it("round-trips UTF-8 keywords, regexes, shortcuts and display preferences", () => {
    const source = createSettingsBackup({ adBlockKeywords: ["推广", "emoji😀"], adBlockRegexRules: ["广告.*"], chatFontSize: 18, shortcuts: { nextChat: "Alt+KeyN" } as never });
    const encoded = encodeSettingsBackup(source);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeSettingsBackup(encoded)).toEqual(source);
    expect(decodeSettingsBackup(`\uFEFF${encoded}\n`).preferences.adBlockKeywords).toEqual(["推广", "emoji😀"]);
  });
  it("projects only safe fields even when stores or input contain personal information", () => {
    const unsafe = { chatFontSize: 18, developerMode: true, performanceMonitoringEnabled: true, accountId: "123", phone: "+123", chats: ["private"], proxySettings: { password: "secret" }, downloadPath: "C:/personal", webdav: { password: "dav-secret" } };
    const backup = createSettingsBackup(unsafe);
    expect(backup.preferences).toEqual({ chatFontSize: 18 });
    const decoded = decodeSettingsBackup(raw({ ...backup, preferences: unsafe, revisions: { phone: 3 } }));
    expect(decoded).toEqual(backup);
    expect(atob(encodeSettingsBackup(decoded))).not.toMatch(/secret|personal|phone|account|developerMode/);
  });
  it.each([
    { chatFontSize: 200 }, { chatFontSize: "18" }, { notificationSound: "false" },
    { themeId: "unknown" }, { language: "unknown" }, { shortcuts: null },
    { adBlockKeywords: [9] }, { adBlockKeywords: ["x".repeat(1024)] },
  ])("rejects invalid settings before application: %j", preferences => {
    expect(() => decodeSettingsBackup(raw({ format: "notgram-settings", version: 1, preferences, revisions: {} }))).toThrow("invalid-backup");
  });
  it.each(["not base64", "e30=", "", "a".repeat(MAX_BACKUP_BYTES + 1), raw({ format: "notgram-settings", version: 2, preferences: { chatFontSize: 18 }, revisions: {} })])("rejects damaged, oversized or unsupported input", text => {
    expect(() => decodeSettingsBackup(text)).toThrow("invalid-backup");
  });
  it("merges independent offline edits and newer same-field revisions", () => {
    const local = createSettingsBackup({ chatFontSize: 18, adBlockKeywords: ["local"] }, { chatFontSize: 30, adBlockKeywords: 10 });
    const remote = createSettingsBackup({ chatFontSize: 16, adBlockKeywords: ["remote"] }, { chatFontSize: 20, adBlockKeywords: 40 });
    expect(mergeSettingsBackups(local, remote).preferences).toEqual({ chatFontSize: 18, adBlockKeywords: ["remote"] });
    expect(mergeSettingsBackups(local, remote)).toEqual(mergeSettingsBackups(remote, local));
  });
  it("converges equal-clock conflicts and leaves partial backups partial", () => {
    const a = createSettingsBackup({ chatFontSize: 16 }, { chatFontSize: 20 });
    const b = createSettingsBackup({ chatFontSize: 18 }, { chatFontSize: 20 });
    expect(mergeSettingsBackups(a, b)).toEqual(mergeSettingsBackups(b, a));
    expect(Object.keys(decodeSettingsBackup(encodeSettingsBackup(a)).preferences)).toEqual(["chatFontSize"]);
  });
  it("only revises changed preferences, including changes under clock rollback", () => {
    const a = createSettingsBackup({ chatFontSize: 16, notificationSound: true }, { chatFontSize: 500, notificationSound: 100 });
    expect(reviseBackup(a, a.preferences, 10)).toEqual(a);
    expect(reviseBackup(a, { ...a.preferences, chatFontSize: 18 }, 10).revisions).toEqual({ chatFontSize: 501, notificationSound: 100 });
  });
  it("keeps imported maximum clocks serializable after a local edit", () => {
    const previous = createSettingsBackup({ chatFontSize: 16 }, { chatFontSize: Number.MAX_SAFE_INTEGER });
    const next = reviseBackup(previous, { chatFontSize: 18 });
    expect(() => encodeSettingsBackup(next)).not.toThrow();
  });
});
