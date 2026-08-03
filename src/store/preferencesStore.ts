import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface AppPreferences {
  notificationsEnabled: boolean;
  notificationSound: boolean;
  notificationPreview: boolean;
  compactMode: boolean;
  sendOnEnter: boolean;
  autoplayAnimations: boolean;
  autoDownloadImages: boolean;
  autoDownloadVideos: boolean;
  autoDownloadAudio: boolean;
  autoDownloadFiles: boolean;
  autoDownloadLimitMb: number;
  reduceMotion: boolean;
  developerMode: boolean;
  chatFontSize: number;
  interfaceScale: number;
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
  autoDownloadImages: true,
  autoDownloadVideos: false,
  autoDownloadAudio: false,
  autoDownloadFiles: false,
  autoDownloadLimitMb: 10,
  reduceMotion: false,
  developerMode: false,
  chatFontSize: 14,
  interfaceScale: 100,
};

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value)
    ? Math.round(Math.max(minimum, Math.min(maximum, Number(value))))
    : fallback;

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
      autoDownloadImages: stored.autoDownloadImages ?? defaults.autoDownloadImages,
      autoDownloadVideos: stored.autoDownloadVideos ?? defaults.autoDownloadVideos,
      autoDownloadAudio: stored.autoDownloadAudio ?? defaults.autoDownloadAudio,
      autoDownloadFiles: stored.autoDownloadFiles ?? defaults.autoDownloadFiles,
      autoDownloadLimitMb: boundedInteger(
        stored.autoDownloadLimitMb,
        defaults.autoDownloadLimitMb,
        1,
        2_048,
      ),
      reduceMotion: stored.reduceMotion ?? defaults.reduceMotion,
      developerMode: stored.developerMode ?? defaults.developerMode,
      chatFontSize: boundedInteger(stored.chatFontSize, defaults.chatFontSize, 12, 20),
      interfaceScale: boundedInteger(stored.interfaceScale, defaults.interfaceScale, 80, 150),
    };
  } catch {
    return defaults;
  }
};

const initialPreferences = readPreferences();
let appliedInterfaceScale: number | undefined;

export const preferencesStore = createStore<PreferencesState>((set) => ({
  ...initialPreferences,
  setPreference: (key, value) => set({ [key]: value } as Partial<PreferencesState>),
}));

const applyPreferences = (preferences: AppPreferences) => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("compact-chat", preferences.compactMode);
  document.documentElement.classList.toggle("reduce-motion", preferences.reduceMotion);
  document.documentElement.style.setProperty("--chat-font-size", `${preferences.chatFontSize}px`);
  if (appliedInterfaceScale === preferences.interfaceScale) return;
  appliedInterfaceScale = preferences.interfaceScale;
  const scale = preferences.interfaceScale / 100;
  if (isTauri()) {
    document.documentElement.style.removeProperty("zoom");
    void getCurrentWebview().setZoom(scale).catch(() => {
      if (appliedInterfaceScale === preferences.interfaceScale) {
        document.documentElement.style.setProperty("zoom", String(scale));
      }
    });
  } else {
    document.documentElement.style.setProperty("zoom", String(scale));
  }
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
    autoDownloadImages: state.autoDownloadImages,
    autoDownloadVideos: state.autoDownloadVideos,
    autoDownloadAudio: state.autoDownloadAudio,
    autoDownloadFiles: state.autoDownloadFiles,
    autoDownloadLimitMb: state.autoDownloadLimitMb,
    reduceMotion: state.reduceMotion,
    developerMode: state.developerMode,
    chatFontSize: state.chatFontSize,
    interfaceScale: state.interfaceScale,
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
