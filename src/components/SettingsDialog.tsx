import { StorageDataPanel } from "./StorageDataPanel";
import { translate } from "../i18n";
import {
  ArrowLeft,
  Activity,
  AtSign,
  BatteryCharging,
  Bell,
  Camera,
  CloudDownload,
  Code2,
  Gauge,
  FileText,
  Fingerprint,
  HardDrive,
  Languages,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Minus,
  Moon,
  Network,
  Pencil,
  Phone,
  RotateCcw,
  Save,
  Search,
  SendHorizontal,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserCircle,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { CacheHealth } from "../store/telegramStore.cache";
import type { ProfileState } from "../store/profileState";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { requestDesktopNotificationPermission } from "../notifications/desktopNotifications";
import {
  usePreferencesStore,
  type AppPreferences,
} from "../store/preferencesStore";
import type {
  CacheCategory,
  CacheCleanupResult,
  CacheUsage,
  ProxySettings,
  StorageSettings,
  UpdateCurrentUserProfileInput,
  User,
} from "../telegram/types";
import { Avatar } from "./Avatar";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { DesktopStartupSettings } from "./DesktopStartupSettings";
import { MotionPresence } from "./MotionPresence";
import { PerformanceMonitor } from "./PerformanceMonitor";
import { UpdateSettings } from "./UpdateSettings";
import { SafetySettings } from "./SafetySettings";
import { ProxySettingsEditor } from "./ProxySettingsEditor";
import type { LanguagePreference } from "../i18n";
import {
  AD_BLOCK_KEYWORD_LENGTH_LIMIT,
  AD_BLOCK_KEYWORD_LIMIT,
  AD_BLOCK_REGEX_LENGTH_LIMIT,
  AD_BLOCK_REGEX_LIMIT,
  isValidAdBlockRegex,
} from "../utils/adBlocking";

interface SettingsDialogProps {
  onClose: () => void;
  standalone?: boolean;
}

type SettingsCategoryId =
  | "account"
  | "notgram"
  | "notifications"
  | "chats"
  | "advanced"
  | "performance"
  | "diagnostics"
  | "updates"
  | "power";

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  icon: LucideIcon;
  searchTerms: string;
}

const searchTerms = (value: string) => decodeURIComponent(value);

const categories: SettingsCategory[] = [
  { id: "account", get label() { return translate("我的账号"); }, icon: UserCircle, searchTerms: searchTerms("%E8%B4%A6%E5%8F%B7 %E4%B8%AA%E4%BA%BA%E8%B5%84%E6%96%99 %E5%A4%B4%E5%83%8F %E6%89%8B%E6%9C%BA%E5%8F%B7 %E7%94%A8%E6%88%B7%E5%90%8D %E7%94%A8%E6%88%B7ID %E6%95%B0%E6%8D%AE%E4%B8%AD%E5%BF%83 %E7%AD%BE%E5%90%8D %E9%80%80%E5%87%BA%E7%99%BB%E5%BD%95") },
  { id: "notgram", label: "Notgram", icon: SendHorizontal, searchTerms: searchTerms("%E5%B9%BF%E5%91%8A %E5%B9%BF%E5%91%8A%E6%8B%A6%E6%88%AA %E5%B1%8F%E8%94%BD Zalgo %E8%87%AA%E5%AE%9A%E4%B9%89%E5%85%B3%E9%94%AE%E8%AF%8D %E6%AD%A3%E5%88%99 %E8%BE%93%E5%85%A5%E7%8A%B6%E6%80%81 %E6%92%A4%E5%9B%9E%E6%B6%88%E6%81%AF %E6%9C%AC%E5%9C%B0%E4%BF%9D%E5%AD%98 %E5%BC%80%E6%9C%BA%E5%90%AF%E5%8A%A8 %E5%90%AF%E5%8A%A8") },
  { id: "notifications", get label() { return translate("通知与声音"); }, icon: Bell, searchTerms: searchTerms("%E9%80%9A%E7%9F%A5 %E6%A1%8C%E9%9D%A2%E9%80%9A%E7%9F%A5 %E6%B6%88%E6%81%AF%E9%A2%84%E8%A7%88 %E5%A3%B0%E9%9F%B3 %E6%9D%83%E9%99%90") },
  { id: "chats", get label() { return translate("聊天设置"); }, icon: MessageCircle, searchTerms: searchTerms("%E8%81%8A%E5%A4%A9 %E6%98%BE%E7%A4%BA %E4%B8%BB%E9%A2%98 %E6%B5%85%E8%89%B2 %E6%B7%B1%E8%89%B2 %E8%83%8C%E6%99%AF%E6%A0%B7%E5%BC%8F %E7%AE%80%E6%B4%81 %E6%9F%94%E5%92%8C %E5%AD%97%E4%BD%93 %E7%BC%A9%E6%94%BE %E6%9C%AA%E8%AF%BB%E8%AE%A1%E6%95%B0 %E5%AF%86%E5%BA%A6 %E8%A1%8C%E9%AB%98 %E6%B6%88%E6%81%AF%E7%BB%84%E9%97%B4%E8%B7%9D %E5%90%8C%E7%BB%84%E6%B6%88%E6%81%AF %E6%B0%94%E6%B3%A1%E7%95%99%E7%99%BD Enter %E5%8F%91%E9%80%81") },
  { id: "advanced", get label() { return translate("高级设置"); }, icon: SlidersHorizontal, searchTerms: searchTerms("%E9%AB%98%E7%BA%A7 %E4%BB%A3%E7%90%86 %E7%BD%91%E7%BB%9C %E7%B3%BB%E7%BB%9F%E4%BB%A3%E7%90%86 %E7%9B%B4%E8%BF%9E %E8%87%AA%E5%AE%9A%E4%B9%89 HTTP SOCKS5 MTProto %E6%9C%8D%E5%8A%A1%E5%99%A8 %E7%AB%AF%E5%8F%A3 %E7%94%A8%E6%88%B7%E5%90%8D %E5%AF%86%E7%A0%81 %E8%87%AA%E5%8A%A8%E5%88%87%E6%8D%A2 %E6%B5%8B%E8%AF%95%E8%BF%9E%E6%8E%A5 %E7%BC%93%E5%AD%98 %E5%AD%98%E5%82%A8 %E7%BC%93%E5%AD%98%E8%B7%AF%E5%BE%84 %E4%B8%8B%E8%BD%BD%E8%B7%AF%E5%BE%84 %E6%B8%85%E7%90%86%E7%BC%93%E5%AD%98 %E4%BF%9D%E7%95%99%E5%A4%A9%E6%95%B0 %E4%B8%8B%E8%BD%BD %E8%87%AA%E5%8A%A8%E4%B8%8B%E8%BD%BD %E5%9B%BE%E7%89%87 %E8%A7%86%E9%A2%91 %E9%9F%B3%E9%A2%91 %E6%96%87%E4%BB%B6 %E8%AF%AD%E8%A8%80 %E6%95%B0%E6%8D%AE%E4%B8%AD%E5%BF%83") },
  { id: "performance", get label() { return translate("性能监控"); }, icon: Activity, searchTerms: searchTerms("%E6%80%A7%E8%83%BD %E7%9B%91%E6%8E%A7 %E5%90%AF%E5%8A%A8 %E6%B8%B2%E6%9F%93 %E5%86%85%E5%AD%98 %E5%BB%B6%E8%BF%9F") },
  { id: "diagnostics", get label() { return translate("诊断与隐私"); }, icon: ShieldCheck, searchTerms: searchTerms("%E8%AF%8A%E6%96%AD %E9%9A%90%E7%A7%81 %E5%B1%8F%E8%94%BD%E7%94%A8%E6%88%B7 %E4%BC%9A%E8%AF%9D %E6%9D%83%E9%99%90 %E5%B4%A9%E6%BA%83 %E4%B8%BE%E6%8A%A5") },
  { id: "updates", get label() { return translate("软件更新"); }, icon: CloudDownload, searchTerms: searchTerms("%E6%9B%B4%E6%96%B0 %E7%89%88%E6%9C%AC %E4%B8%8B%E8%BD%BD %E6%A3%80%E6%9F%A5%E6%9B%B4%E6%96%B0") },
  { id: "power", get label() { return translate("电池和动画"); }, icon: BatteryCharging, searchTerms: searchTerms("%E7%94%B5%E6%B1%A0 %E5%8A%A8%E7%94%BB %E8%87%AA%E5%8A%A8%E6%92%AD%E6%94%BE %E5%87%8F%E5%B0%91%E5%8A%A8%E6%80%81%E6%95%88%E6%9E%9C") },
];

const emptySettings: ProxySettings = {
  mode: "system",
  profiles: [{
    id: "proxy-1",
    get name() { return translate("代理 1"); },
    endpoint: {
      type: "http",
      server: "127.0.0.1",
      port: 7890,
      username: "",
      password: "",
      secret: "",
      httpOnly: false,
    },
  }],
  activeProfileId: "proxy-1",
  autoSwitch: false,
};

const emptyStorageSettings: StorageSettings = {
  cachePath: "",
  downloadPath: "",
  defaultCachePath: "",
  defaultDownloadPath: "",
};

const cacheHealthLabels: Record<CacheHealth, string> = {
  get empty() { return translate("尚未生成"); },
  get healthy() { return translate("健康"); },
  get migrated() { return translate("已从旧版本迁移"); },
  get invalid() { return translate("已失效，等待重建"); },
  get rebuilt() { return translate("刚刚重建"); },
};

const cacheCategories: Array<{
  id: CacheCategory;
  key: "images" | "videos" | "audio" | "documents" | "other";
  label: string;
}> = [
  { id: "image", key: "images", get label() { return translate("图片"); } },
  { id: "video", key: "videos", get label() { return translate("视频"); } },
  { id: "audio", key: "audio", get label() { return translate("音频"); } },
  { id: "document", key: "documents", get label() { return translate("文件"); } },
  { id: "other", key: "other", get label() { return translate("其他"); } },
];

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

export function SettingsDialog({ onClose, standalone = false }: SettingsDialogProps) {
  const { t } = useTranslation();
  const settings = useTelegramStore((state) => state.proxySettings);
  const pending = useTelegramStore((state) => state.proxyPending);
  const error = useTelegramStore((state) => state.proxyError);
  const latency = useTelegramStore((state) => state.proxyLatencyMs);
  const storageSettings = useTelegramStore((state) => state.storageSettings);
  const storagePending = useTelegramStore((state) => state.storagePending);
  const storageError = useTelegramStore((state) => state.storageError);
  const cacheHealth = useTelegramStore((state) => state.cacheHealth);
  const cacheUsage = useTelegramStore((state) => state.cacheUsage);
  const cacheCleanupResult = useTelegramStore((state) => state.cacheCleanupResult);
  const accountPending = useTelegramStore((state) => state.accountPending);
  const accountError = useTelegramStore((state) => state.accountError);
  const authorization = useTelegramStore((state) => state.authorization);
  const transportKind = useTelegramStore((state) => state.transportKind);
  const accountProfile = useTelegramStore((state) => state.accountProfile);
  const currentUserId = useTelegramStore((state) => state.currentUserId);
  const currentUser = useTelegramStore((state) =>
    state.currentUserId ? state.users.get(state.currentUserId) : undefined,
  );
  const load = useTelegramStore((state) => state.loadProxySettings);
  const save = useTelegramStore((state) => state.saveProxySettings);
  const test = useTelegramStore((state) => state.testProxy);
  const loadStorage = useTelegramStore((state) => state.loadStorageSettings);
  const saveStorage = useTelegramStore((state) => state.saveStorageSettings);
  const rebuildCache = useTelegramStore((state) => state.rebuildCachedSnapshot);
  const loadCacheUsage = useTelegramStore((state) => state.loadCacheUsage);
  const clearMediaCache = useTelegramStore((state) => state.clearMediaCache);
  const logOutCurrentAccount = useTelegramStore((state) => state.logOutCurrentAccount);
  const loadCurrentUserProfile = useTelegramStore((state) => state.loadCurrentUserProfile);
  const updateCurrentUserProfile = useTelegramStore((state) => state.updateCurrentUserProfile);
  const changeCurrentUserAvatar = useTelegramStore((state) => state.changeCurrentUserAvatar);
  const notificationsEnabled = usePreferencesStore((state) => state.notificationsEnabled);
  const language = usePreferencesStore((state) => state.language);
  const notificationSound = usePreferencesStore((state) => state.notificationSound);
  const notificationPreview = usePreferencesStore((state) => state.notificationPreview);
  const deletedMessageArchiveEnabled = usePreferencesStore((state) => state.deletedMessageArchiveEnabled);
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const blockTypingStatus = usePreferencesStore((state) => state.blockTypingStatus);
  const blockZalgoText = usePreferencesStore((state) => state.blockZalgoText);
  const adBlockingEnabled = usePreferencesStore((state) => state.adBlockingEnabled);
  const blockSponsoredMessages = usePreferencesStore((state) => state.blockSponsoredMessages);
  const customAdBlockingEnabled = usePreferencesStore((state) => state.customAdBlockingEnabled);
  const adBlockKeywords = usePreferencesStore((state) => state.adBlockKeywords);
  const adBlockRegexRules = usePreferencesStore((state) => state.adBlockRegexRules);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const autoplayAnimations = usePreferencesStore((state) => state.autoplayAnimations);
  const autoDownloadImages = usePreferencesStore((state) => state.autoDownloadImages);
  const autoDownloadVideos = usePreferencesStore((state) => state.autoDownloadVideos);
  const autoDownloadAudio = usePreferencesStore((state) => state.autoDownloadAudio);
  const autoDownloadFiles = usePreferencesStore((state) => state.autoDownloadFiles);
  const autoDownloadLimitMb = usePreferencesStore((state) => state.autoDownloadLimitMb);
  const cacheRetentionDays = usePreferencesStore((state) => state.cacheRetentionDays);
  const reduceMotion = usePreferencesStore((state) => state.reduceMotion);
  const chatFontSize = usePreferencesStore((state) => state.chatFontSize);
  const interfaceScale = usePreferencesStore((state) => state.interfaceScale);
  const chatListRowHeight = usePreferencesStore((state) => state.chatListRowHeight);
  const messageGroupSpacing = usePreferencesStore((state) => state.messageGroupSpacing);
  const messageRowSpacing = usePreferencesStore((state) => state.messageRowSpacing);
  const messageBubblePadding = usePreferencesStore((state) => state.messageBubblePadding);
  const unreadBadgePosition = usePreferencesStore((state) => state.unreadBadgePosition);
  const themeId = usePreferencesStore((state) => state.themeId);
  const backgroundStyle = usePreferencesStore((state) => state.backgroundStyle);
  const preferences: AppPreferences = {
    language,
    notificationsEnabled,
    notificationSound,
    notificationPreview,
    deletedMessageArchiveEnabled,
    sendOnEnter,
    blockTypingStatus,
    blockZalgoText,
    adBlockingEnabled,
    blockSponsoredMessages,
    customAdBlockingEnabled,
    adBlockKeywords,
    adBlockRegexRules,
    developerMode,
    autoplayAnimations,
    autoDownloadImages,
    autoDownloadVideos,
    autoDownloadAudio,
    autoDownloadFiles,
    autoDownloadLimitMb,
    cacheRetentionDays,
    reduceMotion,
    chatFontSize,
    interfaceScale,
    chatListRowHeight,
    messageGroupSpacing,
    messageRowSpacing,
    messageBubblePadding,
    unreadBadgePosition,
    themeId,
    backgroundStyle,
  };
  const setPreference = usePreferencesStore((state) => state.setPreference);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("account");
  const [detailOpen, setDetailOpen] = useState(false);
  const [storageDetailsOpen, setStorageDetailsOpen] = useState(false);
  const [compactViewport, setCompactViewport] = useState(false);
  const [draft, setDraft] = useState<ProxySettings>(emptySettings);
  const [storageDraft, setStorageDraft] = useState<StorageSettings>(emptyStorageSettings);
  const [preferenceError, setPreferenceError] = useState<string>();
  const [pendingZalgoTextPreference, setPendingZalgoTextPreference] = useState<boolean>();
  const [settingsQuery, setSettingsQuery] = useState("");

  useEffect(() => {
    void load();
    void loadStorage();
  }, [load, loadStorage]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 620px)");
    const syncViewport = () => setCompactViewport(mediaQuery.matches);
    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);
    return () => mediaQuery.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  useEffect(() => {
    if (storageSettings) setStorageDraft(structuredClone(storageSettings));
  }, [storageSettings]);

  useEffect(() => {
    if (activeCategory === "advanced") void loadCacheUsage();
  }, [activeCategory, loadCacheUsage]);

  useEffect(() => {
    if (activeCategory === "account" && authorization.kind === "ready" && currentUserId) {
      void loadCurrentUserProfile();
    }
  }, [activeCategory, authorization.kind, currentUserId, loadCurrentUserProfile]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (activeCategory !== "advanced") return;
    const proxySaved = await save(draft);
    const storageSaved = await saveStorage(storageDraft);
    if (proxySaved && storageSaved) onClose();
  };

  const active = categories.find((category) => category.id === activeCategory) ?? categories[0];
  const visibleCategories = categories.filter((category) =>
    `${category.label} ${category.searchTerms}`.toLocaleLowerCase().includes(settingsQuery.trim().toLocaleLowerCase()),
  );
  const ActiveIcon = active.icon;
  const busy = pending || storagePending;
  const storageDetailsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeStorageDetails = () => {
    setStorageDetailsOpen(false);
    requestAnimationFrame(() => storageDetailsTriggerRef.current?.focus({ preventScroll: true }));
  };
  const settingsTitleRef = useRef<HTMLHeadingElement>(null);
  const activeCategoryButtonRef = useRef<HTMLButtonElement>(null);
  const settingsBackRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLFormElement>(
    () => storageDetailsOpen ? closeStorageDetails() : onClose(),
    busy || pendingZalgoTextPreference !== undefined,
    standalone ? settingsTitleRef : undefined,
  );

  useEffect(() => {
    if (!compactViewport || !detailOpen) return;
    const frame = requestAnimationFrame(() => {
      settingsBackRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [compactViewport, detailOpen]);

  const updatePreference = async <Key extends keyof AppPreferences>(
    key: Key,
    value: AppPreferences[Key],
  ) => {
    setPreferenceError(undefined);
    if (
      key === "notificationsEnabled" &&
      value === true &&
      !await requestDesktopNotificationPermission()
    ) {
      setPreferenceError(translate("系统通知权限未开启"));
      return;
    }
    if (key === "blockZalgoText") {
      setPendingZalgoTextPreference(Boolean(value));
      return;
    }
    setPreference(key, value);
  };

  const confirmZalgoTextPreference = async () => {
    if (pendingZalgoTextPreference === undefined) return false;
    setPreference("blockZalgoText", pendingZalgoTextPreference);
    try {
      if (isTauri()) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } else {
        globalThis.location.reload();
      }
      return true;
    } catch {
      setPendingZalgoTextPreference(undefined);
      setPreferenceError(translate("设置已保存，请手动重启 Notgram 后生效"));
      return false;
    }
  };

  return (
    <>
      <div
        className={standalone ? "settings-window-shell" : "dialog-backdrop"}
        role="presentation"
        onWheel={standalone ? undefined : (event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={standalone ? undefined : (event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        }}
      >
        <form
          ref={dialogRef}
          className={`settings-dialog ${detailOpen ? "show-detail" : ""}`}
          role="dialog"
          aria-modal={standalone ? undefined : "true"}
          aria-labelledby="settings-title"
          aria-hidden={pendingZalgoTextPreference !== undefined || undefined}
          inert={pendingZalgoTextPreference !== undefined || undefined}
          tabIndex={-1}
          onSubmit={submit}
        >
        <header className="settings-dialog-header">
          <h2
            ref={settingsTitleRef}
            id="settings-title"
            tabIndex={standalone ? -1 : undefined}
          >{translate("设置")}</h2>
          {!standalone && (
            <button className="icon-button" type="button" aria-label={translate("关闭")} title={translate("关闭")} onClick={onClose}>
              <X size={19} />
            </button>
          )}
        </header>

        <nav
          className="settings-categories"
          aria-label={translate("设置分类")}
          aria-hidden={storageDetailsOpen || (compactViewport && detailOpen) || undefined}
          inert={storageDetailsOpen || (compactViewport && detailOpen) || undefined}
        >
          <label className="settings-search-field">
            <Search size={15} strokeWidth={1.8} />
            <span className="sr-only">{translate("搜索设置")}</span>
            <input
              value={settingsQuery}
              onChange={(event) => setSettingsQuery(event.target.value)}
              placeholder={translate("搜索设置")}
              type="search"
            />
            {settingsQuery && <button type="button" aria-label={translate("清除搜索")} title={translate("清除搜索")} onClick={() => setSettingsQuery("")}><X size={14} /></button>}
          </label>
          {visibleCategories.length === 0 ? (
            <p className="settings-search-empty">{translate("没有匹配的设置")}</p>
          ) : visibleCategories.map((category) => {
            const Icon = category.icon;
            return (
              <button
                key={category.id}
                ref={activeCategory === category.id ? activeCategoryButtonRef : undefined}
                className={`settings-category ${activeCategory === category.id ? "is-active" : ""}`}
                type="button"
                aria-current={activeCategory === category.id ? "page" : undefined}
                onClick={() => {
                  setActiveCategory(category.id);
                  setDetailOpen(true);
                }}
              >
                <Icon size={21} strokeWidth={1.8} />
                <span>{category.label}</span>
              </button>
            );
          })}
        </nav>

        <main
          className={`settings-detail ${activeCategory === "advanced" ? "is-advanced" : ""}`}
          aria-hidden={storageDetailsOpen || (compactViewport && !detailOpen) || undefined}
          inert={storageDetailsOpen || (compactViewport && !detailOpen) || undefined}
        >
          <header className="settings-detail-header">
            <button
              ref={settingsBackRef}
              className="settings-mobile-back icon-button"
              type="button"
              aria-label={translate("返回设置分类")}
              title={translate("返回")}
              onClick={() => {
                setDetailOpen(false);
                requestAnimationFrame(() => {
                  activeCategoryButtonRef.current?.focus({ preventScroll: true });
                });
              }}
            >
              <ArrowLeft size={19} />
            </button>
            <ActiveIcon size={22} strokeWidth={1.8} />
            <h3>{active.label}</h3>
          </header>

          {activeCategory === "account" ? (
            <AccountSettings
              currentUser={currentUser}
              profileState={accountProfile}
              transportKind={transportKind}
              pending={accountPending}
              error={accountError}
              onLogOut={() => void logOutCurrentAccount()}
              onUpdate={updateCurrentUserProfile}
              onChangeAvatar={changeCurrentUserAvatar}
            />
          ) : activeCategory === "advanced" ? (
            <AdvancedSettings
              draft={draft}
              onOpenStorageDetails={(button) => {
                storageDetailsTriggerRef.current = button;
                setStorageDetailsOpen(true);
              }}
              storageDraft={storageDraft}
              busy={busy}
              pending={pending}
              error={error}
              storageError={storageError}
              cacheHealth={cacheHealth}
              cacheUsage={cacheUsage}
              cacheCleanupResult={cacheCleanupResult}
              latency={latency}
              setDraft={setDraft}
              setStorageDraft={setStorageDraft}
              onTest={() => void test(draft)}
              onRebuildCache={() => void rebuildCache()}
              onRefreshCache={() => void loadCacheUsage()}
              onClearCache={(categories, olderThanDays) => clearMediaCache(categories, olderThanDays)}
              autoDownload={{
                autoDownloadImages,
                autoDownloadVideos,
                autoDownloadAudio,
                autoDownloadFiles,
                autoDownloadLimitMb,
              }}
              onAutoDownloadToggle={(key, enabled) => setPreference(key, enabled)}
              onAutoDownloadLimitChange={(limitMb) => setPreference("autoDownloadLimitMb", limitMb)}
              language={language}
              onLanguageChange={(nextLanguage) => setPreference("language", nextLanguage)}
            />
          ) : activeCategory === "updates" ? (
            <UpdateSettings />
          ) : activeCategory === "performance" ? (
            <PerformanceMonitor />
          ) : activeCategory === "diagnostics" ? (
            <div className="settings-detail-scroll">
              <DiagnosticsSettings />
              <SafetySettings />
            </div>
          ) : (
            <PreferenceSettings
              category={activeCategory}
              preferences={preferences}
              error={preferenceError}
              onChange={(key, value) => void updatePreference(key, value)}
            />
          )}
        </main>
        {storageDetailsOpen && (
          <StorageDataPanel
            settings={storageDraft}
            setSettings={setStorageDraft}
            onClose={closeStorageDetails}
          />
        )}
        </form>
      </div>
      <MotionPresence present={pendingZalgoTextPreference !== undefined}>
        {pendingZalgoTextPreference !== undefined ? (
          <ConfirmActionDialog
            title={translate("{{value0}} Zalgo 文本屏蔽？", {
              value0: pendingZalgoTextPreference ? translate("开启") : translate("关闭"),
            })}
            description={translate("更改此设置后需要重启 Notgram。确认后软件将立即重启并应用新设置。")}
            confirmLabel={translate("重启 Notgram")}
            onConfirm={confirmZalgoTextPreference}
            onClose={() => setPendingZalgoTextPreference(undefined)}
          />
        ) : null}
      </MotionPresence>
    </>
  );
}

interface PreferenceSettingsProps {
  category: "notgram" | "notifications" | "chats" | "power";
  preferences: AppPreferences;
  error?: string;
  onChange: <Key extends keyof AppPreferences>(key: Key, value: AppPreferences[Key]) => void;
}

type BooleanPreferenceKey = {
  [Key in keyof AppPreferences]: AppPreferences[Key] extends boolean ? Key : never;
}[keyof AppPreferences];

function PreferenceSettings({
  category,
  preferences,
  error,
  onChange,
}: PreferenceSettingsProps) {
  const systemReduceMotion = usePreferencesStore((state) => state.systemReduceMotion);
  const options: Array<{
    key: BooleanPreferenceKey;
    label: string;
    disabled?: boolean;
  }> = category === "notgram"
    ? [
        { key: "blockZalgoText" as const, label: translate("屏蔽 Zalgo 文本") },
        { key: "blockTypingStatus" as const, label: translate("屏蔽输入状态") },
        { key: "deletedMessageArchiveEnabled" as const, label: translate("保留已撤回消息") },
      ]
    : category === "notifications"
    ? [
        { key: "notificationsEnabled" as const, label: translate("桌面通知") },
        { key: "notificationPreview" as const, label: translate("显示消息预览"), disabled: !preferences.notificationsEnabled },
        { key: "notificationSound" as const, label: translate("通知声音"), disabled: !preferences.notificationsEnabled },
      ]
    : category === "chats"
      ? [
          { key: "sendOnEnter" as const, label: translate("Enter 键发送") },
        ]
      : [
          { key: "autoplayAnimations" as const, label: translate("自动播放动画") },
          { key: "reduceMotion" as const, label: translate("减少动态效果") },
        ];

  return (
    <div className="settings-detail-scroll preference-settings">
      {category === "notgram" && <AdBlockingSettings preferences={preferences} onChange={onChange} />}
      {category === "notgram" && <DesktopStartupSettings />}
      {category === "chats" && (
        <section className="settings-section" aria-labelledby="chat-display-heading">
          <div className="settings-section-heading">
            <Gauge size={18} strokeWidth={1.8} />
            <div>
              <h4 id="chat-display-heading">{translate("显示")}</h4>
              <span>{translate("主题、字体与界面比例")}</span>
            </div>
          </div>
          <div className="display-preference-list">
            <div className="theme-preference">
              <strong>{translate("界面样式")}</strong>
              <div className="theme-segmented-control" aria-label={translate("界面样式")}>
                <button
                  type="button"
                  aria-pressed={preferences.themeId === "notgram-light"}
                  onClick={() => onChange("themeId", "notgram-light")}
                >
                  <Sun size={15} />{translate("浅色")}</button>
                <button
                  type="button"
                  aria-pressed={preferences.themeId === "notgram-dark"}
                  onClick={() => onChange("themeId", "notgram-dark")}
                >
                  <Moon size={15} />{translate("深色")}</button>
              </div>
            </div>
            <div className="theme-preference">
              <strong>{translate("背景样式")}</strong>
              <div className="theme-segmented-control" aria-label={translate("背景样式") }>
                <button
                  type="button"
                  aria-pressed={preferences.backgroundStyle === "plain"}
                  onClick={() => onChange("backgroundStyle", "plain")}
                >{translate("简洁")}</button>
                <button
                  type="button"
                  aria-pressed={preferences.backgroundStyle === "soft"}
                  onClick={() => onChange("backgroundStyle", "soft")}
                ><Sparkles size={15} />{translate("柔和")}</button>
              </div>
            </div>
            <NumericStepper
              label={translate("消息字体大小")}
              value={preferences.chatFontSize}
              minimum={12}
              maximum={20}
              suffix="px"
              onChange={(value) => onChange("chatFontSize", value)}
            />
            <NumericStepper
              label={translate("界面缩放比例")}
              value={preferences.interfaceScale}
              minimum={80}
              maximum={150}
              step={5}
              suffix="%"
              onChange={(value) => onChange("interfaceScale", value)}
            />
            <div className="theme-preference">
              <strong>{translate("未读消息计数器位置")}</strong>
              <div className="theme-segmented-control" aria-label={translate("未读消息计数器位置")}>
                <button
                  type="button"
                  aria-pressed={preferences.unreadBadgePosition === "right"}
                  onClick={() => onChange("unreadBadgePosition", "right")}
                >{translate("右侧")}</button>
                <button
                  type="button"
                  aria-pressed={preferences.unreadBadgePosition === "avatar"}
                  onClick={() => onChange("unreadBadgePosition", "avatar")}
                >{translate("头像右下角")}</button>
              </div>
            </div>
          </div>
          <button
            className="storage-reset display-reset"
            type="button"
            disabled={
              preferences.themeId === "notgram-light" &&
              preferences.chatFontSize === 14 &&
              preferences.interfaceScale === 100 &&
              preferences.unreadBadgePosition === "right"
              && preferences.backgroundStyle === "plain"
            }
            onClick={() => {
              onChange("themeId", "notgram-light");
              onChange("chatFontSize", 14);
              onChange("interfaceScale", 100);
              onChange("unreadBadgePosition", "right");
              onChange("backgroundStyle", "plain");
            }}
          >
            <RotateCcw size={15} strokeWidth={2} />{translate("恢复显示默认值")}</button>
        </section>
      )}
      {category === "chats" && (
        <section className="settings-section" aria-labelledby="chat-density-heading">
          <div className="settings-section-heading">
            <SlidersHorizontal size={18} strokeWidth={1.8} />
            <div>
              <h4 id="chat-density-heading">{translate("间距与密度")}</h4>
              <span>{translate("分别调整会话列表、消息分组和气泡留白")}</span>
            </div>
          </div>
          <div className="display-preference-list">
            <NumericStepper
              label={translate("会话列表行高")}
              value={preferences.chatListRowHeight}
              minimum={56}
              maximum={88}
              step={2}
              suffix="px"
              onChange={(value) => onChange("chatListRowHeight", value)}
            />
            <NumericStepper
              label={translate("消息组间距")}
              value={preferences.messageGroupSpacing}
              minimum={4}
              maximum={18}
              suffix="px"
              onChange={(value) => onChange("messageGroupSpacing", value)}
            />
            <NumericStepper
              label={translate("同组消息间距")}
              value={preferences.messageRowSpacing}
              minimum={0}
              maximum={6}
              suffix="px"
              onChange={(value) => onChange("messageRowSpacing", value)}
            />
            <NumericStepper
              label={translate("消息气泡纵向留白")}
              value={preferences.messageBubblePadding}
              minimum={4}
              maximum={12}
              suffix="px"
              onChange={(value) => onChange("messageBubblePadding", value)}
            />
          </div>
          <button
            className="storage-reset display-reset"
            type="button"
            disabled={
              preferences.chatListRowHeight === 68 &&
              preferences.messageGroupSpacing === 4 &&
              preferences.messageRowSpacing === 1 &&
              preferences.messageBubblePadding === 4
            }
            onClick={() => {
              onChange("chatListRowHeight", 68);
              onChange("messageGroupSpacing", 4);
              onChange("messageRowSpacing", 1);
              onChange("messageBubblePadding", 4);
            }}
          >
            <RotateCcw size={15} strokeWidth={2} />{translate("恢复间距默认值")}</button>
        </section>
      )}
      <section className="settings-section">
        <div className="preference-list">
          {options.map((option) => (
            <label className="preference-row" key={option.key}>
              <span>{option.label}</span>
              <input
                type="checkbox"
                role="switch"
                checked={preferences[option.key]}
                disabled={option.disabled}
                onChange={(event) => onChange(option.key, event.target.checked)}
              />
            </label>
          ))}
        </div>
        {category === "power" && systemReduceMotion && (
          <p className="preference-policy-note" role="status">{translate("系统已启用“减少动态效果”，Notgram 会自动停用过渡和动画播放。")}</p>
        )}
      </section>
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
}

function AdBlockingSettings({
  preferences,
  onChange,
}: {
  preferences: AppPreferences;
  onChange: PreferenceSettingsProps["onChange"];
}) {
  const [keywordDraft, setKeywordDraft] = useState("");
  const addKeywords = (value: string) => {
    const entries = value.split(/[，,\n]/).map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) return;
    const next = [...preferences.adBlockKeywords];
    for (const entry of entries) {
      if (entry.length > AD_BLOCK_KEYWORD_LENGTH_LIMIT || next.length >= AD_BLOCK_KEYWORD_LIMIT) break;
      if (!next.some((candidate) => candidate.localeCompare(entry, undefined, { sensitivity: "base" }) === 0)) {
        next.push(entry);
      }
    }
    onChange("adBlockKeywords", next);
    setKeywordDraft("");
  };
  const updateRegex = (index: number, value: string) => {
    const next = [...preferences.adBlockRegexRules];
    next[index] = value.slice(0, AD_BLOCK_REGEX_LENGTH_LIMIT);
    onChange("adBlockRegexRules", next);
  };
  return (
    <section className="settings-section ad-blocking-settings" aria-labelledby="ad-blocking-heading">
      <div className="settings-section-heading">
        <ShieldCheck size={18} strokeWidth={1.8} />
        <div>
          <h4 id="ad-blocking-heading">{translate("广告屏蔽")}</h4>
          <span>{translate("管理频道广告和自定义内容规则")}</span>
        </div>
      </div>
      <div className="preference-list ad-blocking-switches">
        <label className="preference-row">
          <span>{translate("广告屏蔽")}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={translate("广告屏蔽")}
            checked={preferences.adBlockingEnabled}
            onChange={(event) => onChange("adBlockingEnabled", event.target.checked)}
          />
        </label>
        <label className="preference-row">
          <span>{translate("屏蔽频道广告")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={preferences.blockSponsoredMessages}
            disabled={!preferences.adBlockingEnabled}
            onChange={(event) => onChange("blockSponsoredMessages", event.target.checked)}
          />
        </label>
        <label className="preference-row">
          <span>{translate("自定义屏蔽")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={preferences.customAdBlockingEnabled}
            disabled={!preferences.adBlockingEnabled}
            onChange={(event) => onChange("customAdBlockingEnabled", event.target.checked)}
          />
        </label>
      </div>
      <div className={`ad-blocking-editor ${!preferences.adBlockingEnabled || !preferences.customAdBlockingEnabled ? "is-disabled" : ""}`}>
        <div className="ad-blocking-editor-heading">
          <strong>{translate("关键词")}</strong>
          <span>{preferences.adBlockKeywords.length}/{AD_BLOCK_KEYWORD_LIMIT}</span>
        </div>
        <div className="ad-keyword-input-wrap">
          {preferences.adBlockKeywords.map((keyword) => (
            <span className="ad-keyword-chip" key={keyword}>
              <span>{keyword}</span>
              <button
                type="button"
                aria-label={translate("移除关键词 {{value0}}", { value0: keyword })}
                title={translate("移除关键词")}
                onClick={() => onChange("adBlockKeywords", preferences.adBlockKeywords.filter((candidate) => candidate !== keyword))}
              ><X size={12} /></button>
            </span>
          ))}
          <input
            className="ad-keyword-input"
            type="text"
            value={keywordDraft}
            maxLength={AD_BLOCK_KEYWORD_LENGTH_LIMIT}
            disabled={!preferences.adBlockingEnabled || !preferences.customAdBlockingEnabled || preferences.adBlockKeywords.length >= AD_BLOCK_KEYWORD_LIMIT}
            placeholder={translate("输入关键词后按 Enter")}
            aria-label={translate("添加屏蔽关键词")}
            onChange={(event) => setKeywordDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "," || event.key === "，") {
                event.preventDefault();
                addKeywords(keywordDraft);
              }
            }}
            onBlur={() => addKeywords(keywordDraft)}
            size={Math.max(8, Math.min(28, keywordDraft.length + 1))}
          />
        </div>
        <div className="ad-blocking-editor-heading ad-regex-heading">
          <strong>{translate("正则表达式")}</strong>
          <span>{preferences.adBlockRegexRules.length}/{AD_BLOCK_REGEX_LIMIT}</span>
        </div>
        <div className="ad-regex-list">
          {preferences.adBlockRegexRules.map((rule, index) => (
            <div className="ad-regex-row" key={index}>
              <textarea
                rows={2}
                value={rule}
                maxLength={AD_BLOCK_REGEX_LENGTH_LIMIT}
                disabled={!preferences.adBlockingEnabled || !preferences.customAdBlockingEnabled}
                aria-label={translate("正则表达式 {{value0}}", { value0: index + 1 })}
                aria-invalid={rule.trim() !== "" && !isValidAdBlockRegex(rule)}
                onChange={(event) => updateRegex(index, event.target.value)}
              />
              <button
                className="icon-button"
                type="button"
                aria-label={translate("移除正则表达式 {{value0}}", { value0: index + 1 })}
                title={translate("移除正则表达式")}
                onClick={() => onChange("adBlockRegexRules", preferences.adBlockRegexRules.filter((_, candidate) => candidate !== index))}
              ><Trash2 size={15} /></button>
              {rule.trim() !== "" && !isValidAdBlockRegex(rule) && <small className="ad-regex-error">{translate("正则表达式语法无效")}</small>}
            </div>
          ))}
        </div>
        <button
          className="account-command ad-regex-add"
          type="button"
          disabled={!preferences.adBlockingEnabled || !preferences.customAdBlockingEnabled || preferences.adBlockRegexRules.length >= AD_BLOCK_REGEX_LIMIT}
          onClick={() => onChange("adBlockRegexRules", [...preferences.adBlockRegexRules, ""])}
        ><Plus size={15} />{translate("添加正则表达式")}</button>
      </div>
    </section>
  );
}

interface NumericStepperProps {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}

function NumericStepper({
  label,
  value,
  minimum,
  maximum,
  step = 1,
  suffix,
  onChange,
}: NumericStepperProps) {
  const commit = (next: number) => onChange(Math.max(minimum, Math.min(maximum, next)));
  return (
    <div className="stepper-preference">
      <strong>{label}</strong>
      <div className="numeric-stepper" role="group" aria-label={label}>
        <button
          type="button"
          aria-label={translate("减小{{value0}}", { value0: label })}
          disabled={value <= minimum}
          onClick={() => commit(value - step)}
        >
          <Minus size={15} />
        </button>
        <label>
          <span className="sr-only">{label}</span>
          <input
            type="number"
            min={minimum}
            max={maximum}
            step={step}
            value={value}
            onChange={(event) => commit(Number(event.target.value))}
          />
          <span>{suffix}</span>
        </label>
        <button
          type="button"
          aria-label={translate("增大{{value0}}", { value0: label })}
          disabled={value >= maximum}
          onClick={() => commit(value + step)}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

interface AccountSettingsProps {
  currentUser?: User;
  profileState: ProfileState;
  transportKind: "mock" | "tauri";
  pending: boolean;
  error?: string;
  onLogOut: () => void;
  onUpdate: (input: UpdateCurrentUserProfileInput) => Promise<boolean>;
  onChangeAvatar: (file?: File) => Promise<boolean>;
}

function AccountSettings({
  currentUser,
  profileState,
  transportKind,
  pending,
  error,
  onLogOut,
  onUpdate,
  onChangeAvatar,
}: AccountSettingsProps) {
  const [logoutConfirmation, setLogoutConfirmation] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<UpdateCurrentUserProfileInput>({
    firstName: "",
    lastName: "",
    username: "",
    bio: "",
  });
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const profile = profileState.target?.kind === "current" ? profileState.value : undefined;
  const profilePending = profileState.updating === true;
  const showProfileLoading = useStableVisibility(profileState.loading && !profile);
  const usernameInvalid = Boolean(
    draft.username && !/^[A-Za-z0-9_]{5,32}$/.test(draft.username),
  );

  useEffect(() => {
    if (!profile || editing) return;
    setDraft({
      firstName: profile.firstName ?? currentUser?.firstName ?? profile.title,
      lastName: profile.lastName ?? currentUser?.lastName ?? "",
      username: profile.username ?? currentUser?.username ?? "",
      bio: profile.bio ?? "",
    });
  }, [currentUser?.firstName, currentUser?.lastName, currentUser?.username, editing, profile]);

  const saveProfile = async () => {
    if (!draft.firstName.trim() || usernameInvalid || profilePending) return;
    if (await onUpdate(draft)) setEditing(false);
  };

  const chooseAvatar = () => {
    if (transportKind === "mock") {
      avatarInputRef.current?.click();
    } else {
      void onChangeAvatar();
    }
  };

  return (
    <div className="settings-detail-scroll account-settings">
      {currentUser && showProfileLoading ? (
        <div className="settings-empty" role="status"><LoaderCircle className="spin" size={20} /><span>{translate("正在读取账号资料")}</span></div>
      ) : currentUser && profile ? (
        <section className="settings-section account-profile-section" aria-labelledby="account-profile-heading">
          <div className="settings-section-heading">
            <UserCircle size={18} strokeWidth={1.8} />
            <div>
              <h4 id="account-profile-heading">{translate("当前账号资料")}</h4>
              <span>{profile.statusLabel}</span>
            </div>
          </div>
          <div className="account-profile-card">
            <div className="account-profile-header">
              <div className="account-profile-avatar">
                <Avatar avatar={profile.avatar} size="large" />
                <button type="button" aria-label={translate("更换头像")} title={translate("更换头像")} disabled={profilePending} onClick={chooseAvatar}>
                  {profilePending ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />}
                </button>
                <input
                  ref={avatarInputRef}
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png"
                  tabIndex={-1}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void onChangeAvatar(file);
                  }}
                />
              </div>
              <div className="account-profile-summary">
                <strong>{profile.title}</strong>
                <span>{profile.bio || translate("未设置签名")}</span>
              </div>
              {!editing && (
                <button className="account-profile-edit" type="button" aria-label={translate("编辑账号资料")} title={translate("编辑资料")} onClick={() => setEditing(true)}>
                  <Pencil size={17} />
                </button>
              )}
            </div>

            {editing ? (
              <div className="account-profile-editor" role="group" aria-label={translate("编辑账号资料")}>
                <div className="account-name-fields">
                  <label><span>{translate("名字")}</span><input value={draft.firstName} maxLength={64} aria-invalid={!draft.firstName.trim()} onChange={(event) => setDraft((value) => ({ ...value, firstName: event.target.value }))} /></label>
                  <label><span>{translate("姓氏")}</span><input value={draft.lastName} maxLength={64} onChange={(event) => setDraft((value) => ({ ...value, lastName: event.target.value }))} /></label>
                </div>
                <label><span>{translate("用户名")}</span><div className="account-username-input"><AtSign size={15} /><input value={draft.username} maxLength={32} aria-invalid={usernameInvalid} onChange={(event) => setDraft((value) => ({ ...value, username: event.target.value }))} /></div></label>
                <label><span>{translate("签名")}</span><textarea value={draft.bio} maxLength={140} rows={3} onChange={(event) => setDraft((value) => ({ ...value, bio: event.target.value }))} /></label>
                {usernameInvalid && <small className="account-field-error">{translate("用户名需包含 5 至 32 个英文字母、数字或下划线")}</small>}
                <div className="account-profile-editor-actions">
                  <button className="dialog-secondary" type="button" disabled={profilePending} onClick={() => setEditing(false)}><X size={16} /><span>{translate("取消")}</span></button>
                  <button className="dialog-save" type="button" disabled={profilePending || !draft.firstName.trim() || usernameInvalid} onClick={() => void saveProfile()}>
                    {profilePending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}<span>{translate("保存资料")}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="account-profile-details">
                <div><Phone size={18} /><span><small>{translate("手机号")}</small><strong>{profile.phoneNumber || translate("未提供")}</strong></span></div>
                <div><AtSign size={18} /><span><small>{translate("用户名")}</small><strong>{profile.username ? `@${profile.username}` : translate("未设置")}</strong></span></div>
                <div><Fingerprint size={18} /><span><small>{translate("用户 ID")}</small><strong>{profile.userId}</strong></span></div>
                <div><Network size={18} /><span><small>{translate("数据中心")}</small><strong>{profile.dataCenterId ? `DC${profile.dataCenterId}, ${profile.dataCenterLocation}` : profile.dataCenterLocation}</strong></span></div>
                <div className="account-profile-bio"><FileText size={18} /><span><small>{translate("签名")}</small><strong>{profile.bio || translate("未设置")}</strong></span></div>
              </div>
            )}
          </div>
          {profileState.updateError && <div className="settings-error" role="alert">{profileState.updateError}</div>}
          {logoutConfirmation ? (
            <div className="account-logout-confirm" role="group" aria-label={translate("确认退出登录")}>
              <p>{translate("退出后将删除此账号的本地草稿、待发送消息与附件、下载记录及缓存。已下载或另存的文件会保留。其他账号不受影响。")}</p>
              <div>
                <button className="dialog-secondary" type="button" disabled={pending} onClick={() => setLogoutConfirmation(false)}>{translate("取消")}</button>
                <button className="dialog-danger" type="button" disabled={pending} onClick={onLogOut}>
                  {pending && <LoaderCircle className="spin" size={16} />}{translate("退出登录")}</button>
              </div>
            </div>
          ) : (
            <button className="account-command is-danger" type="button" disabled={pending} onClick={() => setLogoutConfirmation(true)}>
              <LogOut size={18} />
              <span>{translate("退出当前账号")}</span>
            </button>
          )}
        </section>
      ) : profileState.error ? (
        <div className="settings-error" role="alert">{profileState.error}</div>
      ) : null}

      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
}

interface AdvancedSettingsProps {
  onOpenStorageDetails: (button: HTMLButtonElement) => void;
  draft: ProxySettings;
  storageDraft: StorageSettings;
  busy: boolean;
  pending: boolean;
  error?: string;
  storageError?: string;
  cacheHealth: CacheHealth;
  cacheUsage?: CacheUsage;
  cacheCleanupResult?: CacheCleanupResult;
  latency?: number;
  setDraft: Dispatch<SetStateAction<ProxySettings>>;
  setStorageDraft: Dispatch<SetStateAction<StorageSettings>>;
  onTest: () => void;
  onRebuildCache: () => void;
  onRefreshCache: () => void;
  onClearCache: (categories: CacheCategory[], olderThanDays?: number) => Promise<boolean>;
  autoDownload: Pick<AppPreferences,
    | "autoDownloadImages"
    | "autoDownloadVideos"
    | "autoDownloadAudio"
    | "autoDownloadFiles"
    | "autoDownloadLimitMb"
  >;
  onAutoDownloadToggle: (
    key: "autoDownloadImages" | "autoDownloadVideos" | "autoDownloadAudio" | "autoDownloadFiles",
    enabled: boolean,
  ) => void;
  onAutoDownloadLimitChange: (limitMb: number) => void;
  language: LanguagePreference;
  onLanguageChange: (language: LanguagePreference) => void;
}

function AdvancedSettings({
  onOpenStorageDetails,
  draft,
  storageDraft,
  busy,
  pending,
  error,
  storageError,
  cacheHealth,
  cacheUsage,
  cacheCleanupResult,
  latency,
  setDraft,
  setStorageDraft,
  onTest,
  onRebuildCache,
  onRefreshCache,
  onClearCache,
  autoDownload,
  onAutoDownloadToggle,
  onAutoDownloadLimitChange,
  language,
  onLanguageChange,
}: AdvancedSettingsProps) {
  const { t } = useTranslation();
  const [selectedCacheCategories, setSelectedCacheCategories] = useState<CacheCategory[]>(
    cacheCategories.map((category) => category.id),
  );
  const cacheRetentionDays = usePreferencesStore((state) => state.cacheRetentionDays);
  const setCacheRetentionDays = usePreferencesStore((state) => state.setPreference);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const setDeveloperMode = usePreferencesStore((state) => state.setPreference);
  const toggleCacheCategory = (category: CacheCategory, selected: boolean) => {
    setSelectedCacheCategories((current) => selected
      ? [...new Set([...current, category])]
      : current.filter((item) => item !== category));
  };

  return (
    <>
      <div className="settings-detail-scroll">
        <section className="settings-section" aria-labelledby="language-heading">
          <div className="settings-section-heading">
            <Languages size={18} strokeWidth={1.8} aria-hidden="true" />
            <div>
              <h4 id="language-heading">{t("界面语言")}</h4>
              <span>{t("选择 Notgram 显示语言")}</span>
            </div>
          </div>
          <label className="auth-field">
            <span>{t("语言")}</span>
            <select
              value={language}
              aria-label={t("界面语言")}
              onChange={(event) => onLanguageChange(event.target.value as LanguagePreference)}
            >
              <option value="system">{t("跟随系统")}</option>
              <option value="zh-CN" lang="zh-CN">简体中文</option>
              <option value="en" lang="en">English</option>
              <option value="ja" lang="ja">日本語</option>
            </select>
          </label>
        </section>

        <section className="settings-section" aria-labelledby="connection-heading">
        <div className="settings-section-heading">
          <Network size={18} strokeWidth={1.8} />
          <div>
            <h4 id="connection-heading">{translate("连接")}</h4>
            <span>{translate("Telegram 网络与代理")}</span>
          </div>
        </div>

        <ProxySettingsEditor
          settings={draft}
          busy={busy}
          pending={pending}
          latency={latency}
          onChange={setDraft}
          onTest={onTest}
        />
        </section>

        <section className="settings-section" aria-labelledby="storage-heading">
        <div className="settings-section-heading">
          <HardDrive size={18} strokeWidth={1.8} />
          <div>
            <div className="storage-heading-title">
              <h4 id="storage-heading">{translate("存储路径")}</h4>
              {isTauri() && (
                <button className="storage-reset" type="button" onClick={(event) => onOpenStorageDetails(event.currentTarget)}>
                  {translate("存储详情")}
                </button>
              )}
            </div>
            <span>{translate("缓存路径重启后生效")}</span>
          </div>
        </div>
        <label className="auth-field">
          <span>{translate("缓存路径")}</span>
          <input
            value={storageDraft.cachePath}
            placeholder={storageDraft.defaultCachePath}
            onChange={(event) => setStorageDraft((current) => ({ ...current, cachePath: event.target.value }))}
          />
        </label>
        <label className="auth-field">
          <span>{translate("下载路径")}</span>
          <input
            value={storageDraft.downloadPath}
            placeholder={storageDraft.defaultDownloadPath}
            onChange={(event) => setStorageDraft((current) => ({ ...current, downloadPath: event.target.value }))}
          />
        </label>
        <button
          className="storage-reset"
          type="button"
          disabled={busy}
          onClick={() => setStorageDraft((current) => ({
            ...current,
            cachePath: current.defaultCachePath,
            downloadPath: current.defaultDownloadPath,
          }))}
        >
          <RotateCcw size={15} strokeWidth={2} />
          <span>{translate("恢复默认路径")}</span>
        </button>
        <div className="settings-inline-actions">
          <button
            className="storage-reset"
            type="button"
            disabled={busy}
            onClick={onRebuildCache}
          >
            <RotateCcw size={15} strokeWidth={2} />
            <span>{translate("重建界面缓存")}</span>
          </button>
          <span className="cache-health" role="status">{translate("缓存状态：")}{cacheHealthLabels[cacheHealth]}
          </span>
        </div>
        </section>

        <section className="settings-section" aria-labelledby="media-cache-heading">
          <div className="settings-section-heading">
            <HardDrive size={18} strokeWidth={1.8} />
            <div>
              <h4 id="media-cache-heading">{translate("媒体缓存")}</h4>
              <span>{translate("当前消息、播放中和下载中的文件会受到保护")}</span>
            </div>
          </div>
          <div className="cache-usage-summary" aria-live="polite">
            <strong>{cacheUsage ? formatBytes(cacheUsage.total.bytes) : translate("正在统计")}</strong>
            <span>{cacheUsage ? translate("{{value0}} 个文件", { value0: cacheUsage.total.files }) : translate("请稍候")}</span>
            <button
              className="storage-reset"
              type="button"
              disabled={busy}
              onClick={onRefreshCache}
            >
              <RotateCcw className={busy ? "spin" : undefined} size={15} strokeWidth={2} />
              <span>{translate("刷新")}</span>
            </button>
          </div>
          {cacheUsage && (
            <div className="cache-category-list" aria-label={translate("缓存类型")}>
              {cacheCategories.map((category) => {
                const usage = cacheUsage[category.key];
                return (
                  <label className="cache-category-row" key={category.id}>
                    <input
                      type="checkbox"
                      checked={selectedCacheCategories.includes(category.id)}
                      disabled={busy}
                      onChange={(event) => toggleCacheCategory(category.id, event.target.checked)}
                    />
                    <span>{category.label}</span>
                    <small>{formatBytes(usage.bytes)} · {translate("{{value0}} 个", { value0: usage.files })}</small>
                  </label>
                );
              })}
            </div>
          )}
          <label className="auth-field cache-retention-field">
            <span>{translate("自动清理周期")}</span>
            <select
              value={cacheRetentionDays}
              disabled={busy}
              onChange={(event) => setCacheRetentionDays("cacheRetentionDays", Number(event.target.value))}
            >
              <option value={0}>{translate("不自动清理")}</option>
              <option value={7}>{translate("7 天前")}</option>
              <option value={30}>{translate("30 天前")}</option>
              <option value={90}>{translate("90 天前")}</option>
            </select>
          </label>
          <div className="cache-cleanup-actions">
            <button
              className="dialog-secondary"
              type="button"
              disabled={busy || selectedCacheCategories.length === 0}
              onClick={() => void onClearCache(
                selectedCacheCategories,
                cacheRetentionDays || undefined,
              )}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              <span>{translate("清理所选")}</span>
            </button>
            <button
              className="dialog-danger"
              type="button"
              disabled={busy || !cacheUsage || cacheUsage.total.files === 0}
              onClick={() => void onClearCache(cacheCategories.map((category) => category.id))}
            >
              <Trash2 size={16} />
              <span>{translate("清理全部媒体缓存")}</span>
            </button>
          </div>
          {cacheCleanupResult && (
            <p className="cache-cleanup-result" role="status">{translate("已清理 {{value0}}，共 {{value1}} 个文件", {
                value0: formatBytes(cacheCleanupResult.removedBytes),
                value1: cacheCleanupResult.removedFiles,
              })}{cacheCleanupResult.skippedProtectedFiles > 0
                ? translate("；已保留 {{value0}} 个受保护文件", { value0: cacheCleanupResult.skippedProtectedFiles })
                : ""}
              {cacheCleanupResult.failedFiles > 0
                ? translate("；{{value0}} 个文件清理失败", { value0: cacheCleanupResult.failedFiles })
                : ""}
            </p>
          )}
        </section>

        <section className="settings-section" aria-labelledby="auto-download-heading">
          <div className="settings-section-heading">
            <CloudDownload size={18} strokeWidth={1.8} />
            <div>
              <h4 id="auto-download-heading">{translate("自动下载")}</h4>
              <span>{translate("浏览会话时会提前缓存上方约 1.5 屏的封面，下载目录不受影响")}</span>
            </div>
          </div>
          <div className="preference-list">
            {([
              ["autoDownloadImages", translate("图片、贴纸与动画")],
              ["autoDownloadVideos", translate("视频与视频消息")],
              ["autoDownloadAudio", translate("音频与语音")],
              ["autoDownloadFiles", translate("普通文件")],
            ] as const).map(([key, label]) => (
              <label className="preference-row" key={key}>
                <span>{label}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={autoDownload[key]}
                  onChange={(event) => onAutoDownloadToggle(key, event.target.checked)}
                />
              </label>
            ))}
          </div>
          <label className="auth-field auto-download-limit">
            <span>{translate("单个文件上限")}</span>
            <span className="auto-download-limit-control">
              <input
                type="number"
                min={1}
                max={2048}
                value={autoDownload.autoDownloadLimitMb}
                onChange={(event) => onAutoDownloadLimitChange(
                  Math.max(1, Math.min(2_048, Number(event.target.value) || 1)),
                )}
              />
              <small>MB</small>
            </span>
          </label>
        </section>

        <section className="settings-section" aria-labelledby="developer-mode-heading">
          <div className="settings-section-heading">
            <Code2 size={18} strokeWidth={1.8} />
            <div>
              <h4 id="developer-mode-heading">{translate("开发者模式")}</h4>
              <span>{translate("启用调试辅助操作")}</span>
            </div>
          </div>
          <div className="preference-list">
            <label className="preference-row">
              <span>{translate("开发者模式")}</span>
              <input
                type="checkbox"
                role="switch"
                checked={developerMode}
                onChange={(event) => setDeveloperMode("developerMode", event.target.checked)}
              />
            </label>
          </div>
        </section>

        {error && <div className="auth-error settings-error" role="alert">{error}</div>}
        {storageError && <div className="auth-error settings-error" role="alert">{storageError}</div>}
      </div>

      <footer className="settings-actions">
        <button className="auth-submit dialog-save" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
          <span>{translate("保存更改")}</span>
        </button>
      </footer>
    </>
  );
}
