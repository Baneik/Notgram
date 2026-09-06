import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
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
import { setZalgoTextBlockingEnabled } from "../telegram/identityText";
import {
  AD_BLOCK_KEYWORD_LENGTH_LIMIT,
  AD_BLOCK_KEYWORD_LIMIT,
  AD_BLOCK_REGEX_LENGTH_LIMIT,
  AD_BLOCK_REGEX_LIMIT,
  sanitizeAdBlockEntries,
} from "../utils/adBlocking";
import {
  applyLanguagePreference,
  isLanguagePreference,
  type LanguagePreference,
} from "../i18n";

export type ColorTheme = ColorScheme;
export type UnreadBadgePosition = "right" | "avatar";
export type BackgroundStyle = "plain" | "soft";

export interface AppPreferences {
  language: LanguagePreference;
  notificationsEnabled: boolean;
  notificationSound: boolean;
  notificationPreview: boolean;
  deletedMessageArchiveEnabled: boolean;
  sendOnEnter: boolean;
  blockTypingStatus: boolean;
  blockZalgoText: boolean;
  adBlockingEnabled: boolean;
  blockSponsoredMessages: boolean;
  customAdBlockingEnabled: boolean;
  adBlockKeywords: string[];
  adBlockRegexRules: string[];
  developerMode: boolean;
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
  backgroundStyle: BackgroundStyle;
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
const LEGACY_DENSITY_DEFAULTS = {
  chatListRowHeight: 74,
  messageGroupSpacing: 10,
  messageRowSpacing: 1,
  messageBubblePadding: 8,
} as const;
const defaults: AppPreferences = {
  language: "system",
  notificationsEnabled: true,
  notificationSound: true,
  notificationPreview: true,
  deletedMessageArchiveEnabled: false,
  sendOnEnter: true,
  blockTypingStatus: true,
  blockZalgoText: true,
  adBlockingEnabled: true,
  blockSponsoredMessages: true,
  customAdBlockingEnabled: false,
  adBlockKeywords: [],
  adBlockRegexRules: [],
  developerMode: false,
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
  chatListRowHeight: 68,
  messageGroupSpacing: 4,
  messageRowSpacing: 1,
  messageBubblePadding: 4,
  unreadBadgePosition: "right",
  themeId: "notgram-light",
  backgroundStyle: "plain",
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
      sendTypingStatus?: boolean;
    };
    const legacyCompact = stored.compactMode === true;
    const legacyDensityDefaults = stored.chatListRowHeight === LEGACY_DENSITY_DEFAULTS.chatListRowHeight &&
      stored.messageGroupSpacing === LEGACY_DENSITY_DEFAULTS.messageGroupSpacing &&
      stored.messageRowSpacing === LEGACY_DENSITY_DEFAULTS.messageRowSpacing &&
      stored.messageBubblePadding === LEGACY_DENSITY_DEFAULTS.messageBubblePadding;
    const storedDensity = legacyDensityDefaults ? undefined : stored;
    const blockTypingStatus = stored.blockTypingStatus ?? (
      stored.sendTypingStatus === undefined
        ? defaults.blockTypingStatus
        : !stored.sendTypingStatus
    );
    return {
      language: isLanguagePreference(stored.language) ? stored.language : defaults.language,
      notificationsEnabled: stored.notificationsEnabled ?? defaults.notificationsEnabled,
      notificationSound: stored.notificationSound ?? defaults.notificationSound,
      notificationPreview: stored.notificationPreview ?? defaults.notificationPreview,
      deletedMessageArchiveEnabled: stored.deletedMessageArchiveEnabled ?? defaults.deletedMessageArchiveEnabled,
      sendOnEnter: stored.sendOnEnter ?? defaults.sendOnEnter,
      blockTypingStatus,
      blockZalgoText: stored.blockZalgoText ?? defaults.blockZalgoText,
      adBlockingEnabled: stored.adBlockingEnabled ?? defaults.adBlockingEnabled,
      blockSponsoredMessages: stored.blockSponsoredMessages ?? defaults.blockSponsoredMessages,
      customAdBlockingEnabled: stored.customAdBlockingEnabled ?? defaults.customAdBlockingEnabled,
      adBlockKeywords: sanitizeAdBlockEntries(
        stored.adBlockKeywords,
        AD_BLOCK_KEYWORD_LIMIT,
        AD_BLOCK_KEYWORD_LENGTH_LIMIT,
      ),
      adBlockRegexRules: sanitizeAdBlockEntries(
        stored.adBlockRegexRules,
        AD_BLOCK_REGEX_LIMIT,
        AD_BLOCK_REGEX_LENGTH_LIMIT,
      ),
      developerMode: stored.developerMode ?? defaults.developerMode,
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
        storedDensity?.chatListRowHeight,
        legacyCompact ? 60 : defaults.chatListRowHeight,
        56,
        88,
      ),
      messageGroupSpacing: boundedInteger(
        storedDensity?.messageGroupSpacing,
        legacyCompact ? 5 : defaults.messageGroupSpacing,
        4,
        18,
      ),
      messageRowSpacing: boundedInteger(
        storedDensity?.messageRowSpacing,
        defaults.messageRowSpacing,
        0,
        6,
      ),
      messageBubblePadding: boundedInteger(
        storedDensity?.messageBubblePadding,
        legacyCompact ? 6 : defaults.messageBubblePadding,
        4,
        12,
      ),
      unreadBadgePosition: stored.unreadBadgePosition === "avatar"
        ? "avatar"
        : defaults.unreadBadgePosition,
      themeId: resolveThemeId(stored.themeId, stored.colorTheme),
      backgroundStyle: stored.backgroundStyle === "soft" ? "soft" : defaults.backgroundStyle,
    };
  } catch {
    return defaults;
  }
};

const initialPreferences = readPreferences();
setZalgoTextBlockingEnabled(initialPreferences.blockZalgoText);
const syncNativeDeveloperMode = (enabled: boolean) => {
  if (!isTauri()) return;
  void invoke("notgram_set_developer_mode", { enabled }).catch(() => undefined);
};

syncNativeDeveloperMode(initialPreferences.developerMode);
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
  setPreference: (key, value) => {
    set((state) => ({
      [key]: value,
      ...(key === "reduceMotion"
        ? {
            effectiveReduceMotion: effectiveReduceMotion({
              reduceMotion: Boolean(value),
              systemReduceMotion: state.systemReduceMotion,
            }),
          }
        : {}),
    }) as Partial<PreferencesState>);
    if (key === "developerMode") syncNativeDeveloperMode(Boolean(value));
  },
}));

const applyPreferences = (preferences: AppPreferences, systemMotionReduced: boolean) => {
  if (typeof document === "undefined") return;
  applyLanguagePreference(preferences.language);
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
  document.documentElement.dataset.backgroundStyle = preferences.backgroundStyle;
};

applyPreferences(initialPreferences, preferencesStore.getState().systemReduceMotion);
preferencesStore.subscribe((state) => {
  const preferences: AppPreferences = {
    language: state.language,
    notificationsEnabled: state.notificationsEnabled,
    notificationSound: state.notificationSound,
    notificationPreview: state.notificationPreview,
    deletedMessageArchiveEnabled: state.deletedMessageArchiveEnabled,
    sendOnEnter: state.sendOnEnter,
    blockTypingStatus: state.blockTypingStatus,
    blockZalgoText: state.blockZalgoText,
    adBlockingEnabled: state.adBlockingEnabled,
    blockSponsoredMessages: state.blockSponsoredMessages,
    customAdBlockingEnabled: state.customAdBlockingEnabled,
    adBlockKeywords: state.adBlockKeywords,
    adBlockRegexRules: state.adBlockRegexRules,
    developerMode: state.developerMode,
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
    backgroundStyle: state.backgroundStyle,
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
