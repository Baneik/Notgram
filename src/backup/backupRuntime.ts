import { defaultAppPreferences, preferencesStore } from "../store/preferencesStore";
import { effectiveReduceMotion } from "../utils/motionPreference";
import { createSettingsBackup, decodeSettingsBackup, encodeSettingsBackup, sameValue, type SettingsBackup } from "./settingsBackup";
import { reviseBackup, SettingsSync } from "./settingsSync";
import { webdavBridge, WEBDAV_CONFIG_EVENT, WEBDAV_SYNC_STATUS } from "./webdavBridge";

const REVISION_STORAGE = "notgram:backup:revisions:v1";
const readBackup = () => {
  try {
    const text = localStorage.getItem(REVISION_STORAGE);
    if (text) return decodeSettingsBackup(text);
  } catch { /* A damaged sync record must never prevent local settings from loading. */ }
  return createSettingsBackup(defaultAppPreferences);
};
let backup = reviseBackup(readBackup(), createSettingsBackup(preferencesStore.getState()).preferences);
let applying = false;
const persist = () => {
  try { localStorage.setItem(REVISION_STORAGE, encodeSettingsBackup(backup)); } catch { /* Session settings remain usable. */ }
};
export const currentSettingsBackup = () => reviseBackup(backup, createSettingsBackup(preferencesStore.getState()).preferences);

const apply = (value: SettingsBackup) => {
  applying = true;
  try {
    backup = createSettingsBackup({ ...preferencesStore.getState(), ...value.preferences }, value.revisions);
    preferencesStore.setState(state => ({
      ...backup.preferences,
      effectiveReduceMotion: effectiveReduceMotion({ reduceMotion: backup.preferences.reduceMotion ?? state.reduceMotion, systemReduceMotion: state.systemReduceMotion }),
    }));
    persist();
  } finally { applying = false; }
};

export function restoreSettingsBackup(text: string) {
  const imported = decodeSettingsBackup(text);
  // A deliberate restore is a new local edit, regardless of the age of the file.
  preferencesStore.setState(state => ({
    ...imported.preferences,
    effectiveReduceMotion: effectiveReduceMotion({ reduceMotion: imported.preferences.reduceMotion ?? state.reduceMotion, systemReduceMotion: state.systemReduceMotion }),
  }));
}

export function startSettingsBackupSync() {
  persist();
  const sync = new SettingsSync({
    snapshot: currentSettingsBackup,
    apply,
    config: webdavBridge.summary,
    request: webdavBridge.request,
    status: (state, error) => {
      // Store only bounded error codes, never native errors containing addresses or credentials.
      const code = error && /^(http-\d{3}|invalid-backup|missing-etag|conflict)$/.test(error) ? error : error ? "network" : undefined;
      try { localStorage.setItem(WEBDAV_SYNC_STATUS, JSON.stringify({ state, error: code, at: Date.now() })); } catch { /* Optional status. */ }
      window.dispatchEvent(new Event(WEBDAV_SYNC_STATUS));
    },
  });
  const unsubscribe = preferencesStore.subscribe(() => {
    if (applying) return;
    const next = currentSettingsBackup();
    if (sameValue(next, backup)) return;
    backup = next;
    persist();
    if (webdavBridge.available()) sync.changed();
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === WEBDAV_CONFIG_EVENT) sync.reconfigure();
  };
  const onOnline = () => { if (webdavBridge.available()) sync.changed(0); };
  const onConfig = () => sync.reconfigure();
  window.addEventListener("storage", onStorage);
  window.addEventListener(WEBDAV_CONFIG_EVENT, onConfig);
  window.addEventListener("online", onOnline);
  if (webdavBridge.available()) sync.changed(0);
  return () => {
    unsubscribe(); sync.stop();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(WEBDAV_CONFIG_EVENT, onConfig);
    window.removeEventListener("online", onOnline);
  };
}
