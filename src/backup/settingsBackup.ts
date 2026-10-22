import type { AppPreferences } from "../store/preferencesStore";
import { normalizeShortcutBindings } from "../shortcuts/shortcuts";
import { isLanguagePreference } from "../i18n";
import { THEME_IDS } from "../theme/theme";
import {
  AD_BLOCK_KEYWORD_LENGTH_LIMIT, AD_BLOCK_KEYWORD_LIMIT,
  AD_BLOCK_REGEX_LENGTH_LIMIT, AD_BLOCK_REGEX_LIMIT, sanitizeAdBlockEntries,
} from "../utils/adBlocking";

const booleanKeys = [
  "notificationsEnabled", "notificationSound", "notificationPreview", "deletedMessageArchiveEnabled",
  "sendOnEnter", "blockTypingStatus", "blockReadReceipts", "blockZalgoText", "adBlockingEnabled",
  "blockSponsoredMessages", "customAdBlockingEnabled", "autoplayAnimations", "autoDownloadImages",
  "autoDownloadVideos", "autoDownloadAudio", "autoDownloadFiles", "reduceMotion",
] as const satisfies readonly (keyof AppPreferences)[];
const numberBounds = {
  autoDownloadLimitMb: [1, 2048], cacheRetentionDays: [0, 365], chatFontSize: [12, 20],
  quoteCollapseLines: [1, 100], interfaceScale: [80, 150], chatListRowHeight: [56, 88],
  messageGroupSpacing: [4, 18], messageRowSpacing: [0, 6], messageBubblePadding: [4, 12],
} as const;

// This allowlist is the privacy boundary. Never serialize a store or localStorage wholesale.
export const backupKeys = [
  ...booleanKeys, ...Object.keys(numberBounds) as (keyof typeof numberBounds)[],
  "shortcuts", "language", "adBlockKeywords", "adBlockRegexRules", "unreadBadgePosition",
  "themeId", "backgroundStyle",
] as const;
export type BackupKey = typeof backupKeys[number];
export type BackupPreferences = Pick<AppPreferences, BackupKey>;
export interface SettingsBackup {
  format: "notgram-settings";
  version: 1;
  preferences: Partial<BackupPreferences>;
  revisions: Partial<Record<BackupKey, number>>;
}
export const MAX_BACKUP_BYTES = 1_400_000;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function pickBackupPreferences(source: Partial<AppPreferences>): Partial<BackupPreferences> {
  const result: Record<string, unknown> = {};
  for (const key of backupKeys) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if ((booleanKeys as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") throw new Error("invalid-backup");
      result[key] = value;
    } else if (Object.hasOwn(numberBounds, key)) {
      const [minimum, maximum] = numberBounds[key as keyof typeof numberBounds];
      if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error("invalid-backup");
      }
      result[key] = value;
    } else if (key === "shortcuts") {
      if (!record(value)) throw new Error("invalid-backup");
      result[key] = normalizeShortcutBindings(value);
    } else if (key === "adBlockKeywords" || key === "adBlockRegexRules") {
      const limit = key === "adBlockKeywords" ? AD_BLOCK_KEYWORD_LIMIT : AD_BLOCK_REGEX_LIMIT;
      const length = key === "adBlockKeywords" ? AD_BLOCK_KEYWORD_LENGTH_LIMIT : AD_BLOCK_REGEX_LENGTH_LIMIT;
      if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== "string" || item.length > length)) {
        throw new Error("invalid-backup");
      }
      result[key] = sanitizeAdBlockEntries(value, limit, length);
    } else {
      const valid = key === "language" ? isLanguagePreference(value)
        : key === "themeId" ? (THEME_IDS as readonly unknown[]).includes(value)
        : key === "unreadBadgePosition" ? value === "right" || value === "avatar"
        : value === "plain" || value === "soft";
      if (!valid) throw new Error("invalid-backup");
      result[key] = value;
    }
  }
  return result as Partial<BackupPreferences>;
}

export function createSettingsBackup(preferences: Partial<AppPreferences>, revisions: SettingsBackup["revisions"] = {}): SettingsBackup {
  const safePreferences = pickBackupPreferences(preferences);
  const safeRevisions: SettingsBackup["revisions"] = {};
  for (const key of backupKeys) {
    if (!Object.hasOwn(safePreferences, key)) continue;
    const revision = revisions[key] ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid-backup");
    safeRevisions[key] = revision;
  }
  return { format: "notgram-settings", version: 1, preferences: safePreferences, revisions: safeRevisions };
}

export function encodeSettingsBackup(backup: SettingsBackup): string {
  const bytes = new TextEncoder().encode(JSON.stringify(createSettingsBackup(backup.preferences, backup.revisions)));
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  const encoded = btoa(chunks.join(""));
  if (encoded.length > MAX_BACKUP_BYTES) throw new Error("invalid-backup");
  return encoded;
}

export function decodeSettingsBackup(text: string): SettingsBackup {
  try {
    if (text.length > MAX_BACKUP_BYTES) throw new Error();
    const compact = text.trim().replace(/[\r\n]/g, "");
    if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error();
    const bytes = Uint8Array.from(atob(compact), character => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(value) || value.format !== "notgram-settings" || value.version !== 1 ||
      !record(value.preferences) || !record(value.revisions)) throw new Error();
    const backup = createSettingsBackup(value.preferences, value.revisions);
    if (!Object.keys(backup.preferences).length) throw new Error();
    return backup;
  } catch {
    throw new Error("invalid-backup");
  }
}

export function mergeSettingsBackups(local: SettingsBackup, remote: SettingsBackup): SettingsBackup {
  const preferences = { ...local.preferences };
  const revisions = { ...local.revisions };
  for (const key of backupKeys) {
    if (!Object.hasOwn(remote.preferences, key)) continue;
    const localRevision = local.revisions[key] ?? 0;
    const remoteRevision = remote.revisions[key] ?? 0;
    // Equal clocks converge deterministically without storing a device or account identifier.
    if (!Object.hasOwn(local.preferences, key) || remoteRevision > localRevision ||
      (remoteRevision === localRevision && JSON.stringify(remote.preferences[key])! > JSON.stringify(local.preferences[key])!)) {
      Object.assign(preferences, { [key]: remote.preferences[key] });
      revisions[key] = remoteRevision;
    }
  }
  return createSettingsBackup(preferences, revisions);
}
