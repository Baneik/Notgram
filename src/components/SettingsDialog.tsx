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
  SendHorizontal,
  ShieldCheck,
  SlidersHorizontal,
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
}

const categories: SettingsCategory[] = [
  { id: "account", get label() { return translate("我的账号"); }, icon: UserCircle },
  { id: "notgram", label: "Notgram", icon: SendHorizontal },
  { id: "notifications", get label() { return translate("通知与声音"); }, icon: Bell },
  { id: "chats", get label() { return translate("聊天设置"); }, icon: MessageCircle },
  { id: "advanced", get label() { return translate("高级设置"); }, icon: SlidersHorizontal },
  { id: "performance", get label() { return translate("性能监控"); }, icon: Activity },
  { id: "diagnostics", get label() { return translate("诊断与隐私"); }, icon: ShieldCheck },
  { id: "updates", get label() { return translate("软件更新"); }, icon: CloudDownload },
  { id: "power", get label() { return translate("电池和动画"); }, icon: BatteryCharging },
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
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const blockTypingStatus = usePreferencesStore((state) => state.blockTypingStatus);
  const blockZalgoText = usePreferencesStore((state) => state.blockZalgoText);
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
  const preferences: AppPreferences = {
    language,
    notificationsEnabled,
    notificationSound,
    notificationPreview,
    sendOnEnter,
    blockTypingStatus,
    blockZalgoText,
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
  };
  const setPreference = usePreferencesStore((state) => state.setPreference);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("account");
  const [detailOpen, setDetailOpen] = useState(false);
  const [compactViewport, setCompactViewport] = useState(false);
  const [draft, setDraft] = useState<ProxySettings>(emptySettings);
  const [storageDraft, setStorageDraft] = useState<StorageSettings>(emptyStorageSettings);
  const [preferenceError, setPreferenceError] = useState<string>();
  const [pendingZalgoTextPreference, setPendingZalgoTextPreference] = useState<boolean>();

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
  const ActiveIcon = active.icon;
  const busy = pending || storagePending;
  const settingsTitleRef = useRef<HTMLHeadingElement>(null);
  const activeCategoryButtonRef = useRef<HTMLButtonElement>(null);
  const settingsBackRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLFormElement>(
    onClose,
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
          aria-hidden={compactViewport && detailOpen ? true : undefined}
          inert={compactViewport && detailOpen ? true : undefined}
        >
          {categories.map((category) => {
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
          aria-hidden={compactViewport && !detailOpen ? true : undefined}
          inert={compactViewport && !detailOpen ? true : undefined}
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
            }
            onClick={() => {
              onChange("themeId", "notgram-light");
              onChange("chatFontSize", 14);
              onChange("interfaceScale", 100);
              onChange("unreadBadgePosition", "right");
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
              preferences.chatListRowHeight === 74 &&
              preferences.messageGroupSpacing === 10 &&
              preferences.messageRowSpacing === 1 &&
              preferences.messageBubblePadding === 8
            }
            onClick={() => {
              onChange("chatListRowHeight", 74);
              onChange("messageGroupSpacing", 10);
              onChange("messageRowSpacing", 1);
              onChange("messageBubblePadding", 8);
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
              <p>{translate("退出后将删除此账号在本机的 TDLib 数据和界面缓存，其他账号不受影响。")}</p>
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
            <h4 id="storage-heading">{translate("存储路径")}</h4>
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
              <span>{translate("清理全部缓存")}</span>
            </button>
          </div>
          {cacheCleanupResult && (
            <p className="cache-cleanup-result" role="status">{translate("已清理 {{value0}}，共 {{value1}} 个文件", {
                value0: formatBytes(cacheCleanupResult.removedBytes),
                value1: cacheCleanupResult.removedFiles,
              })}{cacheCleanupResult.skippedProtectedFiles > 0
                ? translate("；已保护 {{value0}} 个正在使用的文件", { value0: cacheCleanupResult.skippedProtectedFiles })
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
