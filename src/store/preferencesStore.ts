import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ColorTheme = "light" | "dark";
export type UnreadBadgePosition = "right" | "avatar";

export interface AppPreferences {
  notificationsEnabled: boolean;
  notificationSound: boolean;
  notificationPreview: boolean;
  sendOnEnter: boolean;
  sendTypingStatus: boolean;
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
  chatListRowHeight: number;
  messageGroupSpacing: number;
  messageRowSpacing: number;
  messageBubblePadding: number;
  unreadBadgePosition: UnreadBadgePosition;
  colorTheme: ColorTheme;
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
  sendOnEnter: true,
  sendTypingStatus: true,
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
  chatListRowHeight: 74,
  messageGroupSpacing: 10,
  messageRowSpacing: 1,
  messageBubblePadding: 8,
  unreadBadgePosition: "right",
  colorTheme: "light",
};

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value)
    ? Math.round(Math.max(minimum, Math.min(maximum, Number(value))))
    : fallback;

const readPreferences = (): AppPreferences => {
  try {
    const serialized = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!serialized) return defaults;
    const stored = JSON.parse(serialized) as Partial<AppPreferences> & { compactMode?: boolean };
    const legacyCompact = stored.compactMode === true;
    return {
      notificationsEnabled: stored.notificationsEnabled ?? defaults.notificationsEnabled,
      notificationSound: stored.notificationSound ?? defaults.notificationSound,
      notificationPreview: stored.notificationPreview ?? defaults.notificationPreview,
      sendOnEnter: stored.sendOnEnter ?? defaults.sendOnEnter,
      sendTypingStatus: stored.sendTypingStatus ?? defaults.sendTypingStatus,
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
      chatListRowHeight: boundedInteger(
        stored.chatListRowHeight,
        legacyCompact ? 60 : defaults.chatListRowHeight,
        56,
        88,
      ),
      messageGroupSpacing: boundedInteger(
        stored.messageGroupSpacing,
        legacyCompact ? 5 : defaults.messageGroupSpacing,
        4,
        18,
      ),
      messageRowSpacing: boundedInteger(
        stored.messageRowSpacing,
        defaults.messageRowSpacing,
        0,
        6,
      ),
      messageBubblePadding: boundedInteger(
        stored.messageBubblePadding,
        legacyCompact ? 6 : defaults.messageBubblePadding,
        4,
        12,
      ),
      unreadBadgePosition: stored.unreadBadgePosition === "avatar"
        ? "avatar"
        : defaults.unreadBadgePosition,
      colorTheme: stored.colorTheme === "dark" ? "dark" : defaults.colorTheme,
    };
  } catch {
    return defaults;
  }
};

const initialPreferences = readPreferences();
let appliedInterfaceScale: number | undefined;
let appliedColorTheme: ColorTheme | undefined;

export const preferencesStore = createStore<PreferencesState>((set) => ({
  ...initialPreferences,
  setPreference: (key, value) => set({ [key]: value } as Partial<PreferencesState>),
}));

const applyPreferences = (preferences: AppPreferences) => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("reduce-motion", preferences.reduceMotion);
  document.documentElement.style.setProperty("--chat-font-size", `${preferences.chatFontSize}px`);
  document.documentElement.style.setProperty(
    "--chat-row-min-height",
    `${preferences.chatListRowHeight}px`,
  );
  document.documentElement.style.setProperty(
    "--message-group-spacing",
    `${preferences.messageGroupSpacing}px`,
  );
  document.documentElement.style.setProperty(
    "--message-row-spacing",
    `${preferences.messageRowSpacing}px`,
  );
  document.documentElement.style.setProperty(
    "--message-bubble-padding-y",
    `${preferences.messageBubblePadding}px`,
  );
  if (appliedInterfaceScale !== preferences.interfaceScale) {
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
  }
  if (appliedColorTheme !== preferences.colorTheme) {
    appliedColorTheme = preferences.colorTheme;
    document.documentElement.classList.toggle("theme-dark", preferences.colorTheme === "dark");
    document.documentElement.style.colorScheme = preferences.colorTheme;
    if (isTauri()) {
      void getCurrentWindow().setTheme(preferences.colorTheme).catch(() => undefined);
    }
  }
};

applyPreferences(initialPreferences);
preferencesStore.subscribe((state) => {
  const preferences: AppPreferences = {
    notificationsEnabled: state.notificationsEnabled,
    notificationSound: state.notificationSound,
    notificationPreview: state.notificationPreview,
    sendOnEnter: state.sendOnEnter,
    sendTypingStatus: state.sendTypingStatus,
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
    chatListRowHeight: state.chatListRowHeight,
    messageGroupSpacing: state.messageGroupSpacing,
    messageRowSpacing: state.messageRowSpacing,
    messageBubblePadding: state.messageBubblePadding,
    unreadBadgePosition: state.unreadBadgePosition,
    colorTheme: state.colorTheme,
  };
  applyPreferences(preferences);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain active for this session when persistence is unavailable.
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    preferencesStore.setState(readPreferences());
  });
}

export const usePreferencesStore = <T,>(selector: (state: PreferencesState) => T) =>
  useStore(preferencesStore, selector);
