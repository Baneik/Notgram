import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export interface AppPreferences {
  notificationsEnabled: boolean;
  notificationSound: boolean;
  notificationPreview: boolean;
  compactMode: boolean;
  sendOnEnter: boolean;
  autoplayAnimations: boolean;
  reduceMotion: boolean;
  developerMode: boolean;
}

interface PreferencesState extends AppPreferences {
  setPreference: <Key extends keyof AppPreferences>(
    key: Key,
    value: AppPreferences[Key],
  ) => void;
}

const STORAGE_KEY = "notgram:preferences:v1";
const defaults: AppPreferences = {
  notificationsEnabled: true,
  notificationSound: true,
  notificationPreview: true,
  compactMode: false,
  sendOnEnter: true,
  autoplayAnimations: true,
  reduceMotion: false,
  developerMode: false,
};

const readPreferences = (): AppPreferences => {
  try {
    const serialized = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!serialized) return defaults;
    const stored = JSON.parse(serialized) as Partial<AppPreferences>;
    return {
      notificationsEnabled: stored.notificationsEnabled ?? defaults.notificationsEnabled,
      notificationSound: stored.notificationSound ?? defaults.notificationSound,
      notificationPreview: stored.notificationPreview ?? defaults.notificationPreview,
      compactMode: stored.compactMode ?? defaults.compactMode,
      sendOnEnter: stored.sendOnEnter ?? defaults.sendOnEnter,
      autoplayAnimations: stored.autoplayAnimations ?? defaults.autoplayAnimations,
      reduceMotion: stored.reduceMotion ?? defaults.reduceMotion,
      developerMode: stored.developerMode ?? defaults.developerMode,
    };
  } catch {
    return defaults;
  }
};

const initialPreferences = readPreferences();

export const preferencesStore = createStore<PreferencesState>((set) => ({
  ...initialPreferences,
  setPreference: (key, value) => set({ [key]: value } as Partial<PreferencesState>),
}));

const applyPreferences = (preferences: AppPreferences) => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("compact-chat", preferences.compactMode);
  document.documentElement.classList.toggle("reduce-motion", preferences.reduceMotion);
};

applyPreferences(initialPreferences);
preferencesStore.subscribe((state) => {
  const preferences: AppPreferences = {
    notificationsEnabled: state.notificationsEnabled,
    notificationSound: state.notificationSound,
    notificationPreview: state.notificationPreview,
    compactMode: state.compactMode,
    sendOnEnter: state.sendOnEnter,
    autoplayAnimations: state.autoplayAnimations,
    reduceMotion: state.reduceMotion,
    developerMode: state.developerMode,
  };
  applyPreferences(preferences);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain active for this session when persistence is unavailable.
  }
});

export const usePreferencesStore = <T,>(selector: (state: PreferencesState) => T) =>
  useStore(preferencesStore, selector);
