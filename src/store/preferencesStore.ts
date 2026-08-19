import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  applyThemeToDocument,
  colorThemeForThemeId,
  resolveThemeId,
  type ColorScheme,
  type ThemeId,
} from "../theme/theme";
import { effectiveReduceMotion } from "../utils/motionPreference";

export type ColorTheme = ColorScheme;
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
  cacheRetentionDays: number;
  reduceMotion: boolean;
  chatFontSize: number;
  interfaceScale: number;
  chatListRowHeight: number;
  messageGroupSpacing: number;
  messageRowSpacing: number;
  messageBubblePadding: number;
  unreadBadgePosition: UnreadBadgePosition;
  themeId: ThemeId;
}

interface PreferencesState extends AppPreferences {
  systemReduceMotion: boolean;
  effectiveReduceMotion: boolean;
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
  cacheRetentionDays: 7,
  reduceMotion: false,
  chatFontSize: 14,
  interfaceScale: 100,
  chatListRowHeight: 74,
  messageGroupSpacing: 10,
  messageRowSpacing: 1,
  messageBubblePadding: 8,
  unreadBadgePosition: "right",
  themeId: "notgram-light",
};

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value)
    ? Math.round(Math.max(minimum, Math.min(maximum, Number(value))))
    : fallback;

const readPreferences = (): AppPreferences => {
  try {
    const serialized = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!serialized) return defaults;
    const stored = JSON.parse(serialized) as Partial<AppPreferences> & {
      colorTheme?: ColorTheme;
      compactMode?: boolean;
    };
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
      cacheRetentionDays: boundedInteger(
        stored.cacheRetentionDays,
        defaults.cacheRetentionDays,
        0,
        365,
      ),
      reduceMotion: stored.reduceMotion ?? defaults.reduceMotion,
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
      themeId: resolveThemeId(stored.themeId, stored.colorTheme),
    };
  } catch {
    return defaults;
  }
};

const initialPreferences = readPreferences();
const readSystemReduceMotion = () => typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const initialSystemReduceMotion = readSystemReduceMotion();
let appliedInterfaceScale: number | undefined;
let appliedThemeId: ThemeId | undefined;

export const preferencesStore = createStore<PreferencesState>((set) => ({
  ...initialPreferences,
  systemReduceMotion: initialSystemReduceMotion,
  effectiveReduceMotion: effectiveReduceMotion({
    reduceMotion: initialPreferences.reduceMotion,
    systemReduceMotion: initialSystemReduceMotion,
  }),
  setPreference: (key, value) => set((state) => ({
    [key]: value,
    ...(key === "reduceMotion"
      ? {
          effectiveReduceMotion: effectiveReduceMotion({
            reduceMotion: Boolean(value),
            systemReduceMotion: state.systemReduceMotion,
          }),
        }
      : {}),
  }) as Partial<PreferencesState>),
}));

const applyPreferences = (preferences: AppPreferences, systemMotionReduced: boolean) => {
  if (typeof document === "undefined") return;
  const reduceMotion = effectiveReduceMotion({
    reduceMotion: preferences.reduceMotion,
    systemReduceMotion: systemMotionReduced,
  });
  document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  document.documentElement.dataset.motion = reduceMotion ? "reduced" : "full";
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
  if (appliedThemeId !== preferences.themeId) {
    appliedThemeId = preferences.themeId;
    const colorScheme = colorThemeForThemeId(preferences.themeId);
    applyThemeToDocument(preferences.themeId);
    if (isTauri()) {
      void getCurrentWindow().setTheme(colorScheme).catch(() => undefined);
    }
  }
};

applyPreferences(initialPreferences, preferencesStore.getState().systemReduceMotion);
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
    cacheRetentionDays: state.cacheRetentionDays,
    reduceMotion: state.reduceMotion,
    chatFontSize: state.chatFontSize,
    interfaceScale: state.interfaceScale,
    chatListRowHeight: state.chatListRowHeight,
    messageGroupSpacing: state.messageGroupSpacing,
    messageRowSpacing: state.messageRowSpacing,
    messageBubblePadding: state.messageBubblePadding,
    unreadBadgePosition: state.unreadBadgePosition,
    themeId: state.themeId,
  };
  applyPreferences(preferences, state.systemReduceMotion);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences remain active for this session when persistence is unavailable.
  }
});

if (typeof window !== "undefined") {
  const reducedMotionQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;
  const syncSystemMotion = (matches: boolean) => {
    preferencesStore.setState((state) => ({
      systemReduceMotion: matches,
      effectiveReduceMotion: effectiveReduceMotion({
        reduceMotion: state.reduceMotion,
        systemReduceMotion: matches,
      }),
    }));
  };
  if (reducedMotionQuery) {
    const onSystemMotionChange = (event: MediaQueryListEvent) => syncSystemMotion(event.matches);
    if (typeof reducedMotionQuery.addEventListener === "function") {
      reducedMotionQuery.addEventListener("change", onSystemMotionChange);
    } else {
      reducedMotionQuery.addListener(onSystemMotionChange);
    }
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    const next = readPreferences();
    preferencesStore.setState((state) => ({
      ...next,
      effectiveReduceMotion: effectiveReduceMotion({
        reduceMotion: next.reduceMotion,
        systemReduceMotion: state.systemReduceMotion,
      }),
    }));
  });
}

export const usePreferencesStore = <T,>(selector: (state: PreferencesState) => T) =>
  useStore(preferencesStore, selector);
