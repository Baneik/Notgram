import {
  ArrowLeft,
  BatteryCharging,
  Bell,
  Check,
  ChevronRight,
  CloudDownload,
  Code2,
  Gauge,
  HardDrive,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Moon,
  Network,
  RotateCcw,
  Save,
  SendHorizontal,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  UserCircle,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { CacheHealth } from "../store/telegramStore.cache";
import { useModalFocus } from "../hooks/useModalFocus";
import { requestDesktopNotificationPermission } from "../notifications/desktopNotifications";
import {
  usePreferencesStore,
  type AppPreferences,
} from "../store/preferencesStore";
import type {
  CacheCategory,
  CacheCleanupResult,
  CacheUsage,
  ProxyMode,
  ProxySettings,
  ProxyType,
  StorageSettings,
  TelegramAccount,
  User,
} from "../telegram/types";
import { Avatar } from "./Avatar";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { UpdateSettings } from "./UpdateSettings";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsCategoryId =
  | "account"
  | "notgram"
  | "notifications"
  | "chats"
  | "advanced"
  | "diagnostics"
  | "updates"
  | "power";

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  icon: LucideIcon;
  detail?: string;
}

const categories: SettingsCategory[] = [
  { id: "account", label: "我的账号", icon: UserCircle },
  { id: "notgram", label: "Notgram", icon: SendHorizontal },
  { id: "notifications", label: "通知与声音", icon: Bell },
  { id: "chats", label: "聊天设置", icon: MessageCircle },
  { id: "advanced", label: "高级设置", icon: SlidersHorizontal },
  { id: "diagnostics", label: "诊断与隐私", icon: ShieldCheck },
  { id: "updates", label: "软件更新", icon: CloudDownload },
  { id: "power", label: "电池和动画", icon: BatteryCharging },
];

const modeOptions: Array<{ value: ProxyMode; label: string }> = [
  { value: "system", label: "系统代理" },
  { value: "direct", label: "直连" },
  { value: "custom", label: "自定义" },
];

const proxyTypeLabels: Record<ProxyType, string> = {
  http: "HTTP",
  socks5: "SOCKS5",
  mtproto: "MTProto",
};

const emptySettings: ProxySettings = {
  mode: "system",
  custom: {
    type: "http",
    server: "127.0.0.1",
    port: 7890,
    username: "",
    password: "",
    secret: "",
    httpOnly: false,
  },
};

const emptyStorageSettings: StorageSettings = {
  cachePath: "",
  downloadPath: "",
  defaultCachePath: "",
  defaultDownloadPath: "",
};

const cacheHealthLabels: Record<CacheHealth, string> = {
  empty: "尚未生成",
  healthy: "健康",
  migrated: "已从旧版本迁移",
  invalid: "已失效，等待重建",
  rebuilt: "刚刚重建",
};

const cacheCategories: Array<{
  id: CacheCategory;
  key: "images" | "videos" | "audio" | "documents" | "other";
  label: string;
}> = [
  { id: "image", key: "images", label: "图片" },
  { id: "video", key: "videos", label: "视频" },
  { id: "audio", key: "audio", label: "音频" },
  { id: "document", key: "documents", label: "文件" },
  { id: "other", key: "other", label: "其他" },
];

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

export function SettingsDialog({ onClose }: SettingsDialogProps) {
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
  const accounts = useTelegramStore((state) => state.accounts);
  const activeAccountId = useTelegramStore((state) => state.activeAccountId);
  const accountPending = useTelegramStore((state) => state.accountPending);
  const accountError = useTelegramStore((state) => state.accountError);
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
  const addAccount = useTelegramStore((state) => state.addAccount);
  const switchAccount = useTelegramStore((state) => state.switchAccount);
  const logOutCurrentAccount = useTelegramStore((state) => state.logOutCurrentAccount);
  const notificationsEnabled = usePreferencesStore((state) => state.notificationsEnabled);
  const notificationSound = usePreferencesStore((state) => state.notificationSound);
  const notificationPreview = usePreferencesStore((state) => state.notificationPreview);
  const compactMode = usePreferencesStore((state) => state.compactMode);
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const sendTypingStatus = usePreferencesStore((state) => state.sendTypingStatus);
  const autoplayAnimations = usePreferencesStore((state) => state.autoplayAnimations);
  const autoDownloadImages = usePreferencesStore((state) => state.autoDownloadImages);
  const autoDownloadVideos = usePreferencesStore((state) => state.autoDownloadVideos);
  const autoDownloadAudio = usePreferencesStore((state) => state.autoDownloadAudio);
  const autoDownloadFiles = usePreferencesStore((state) => state.autoDownloadFiles);
  const autoDownloadLimitMb = usePreferencesStore((state) => state.autoDownloadLimitMb);
  const reduceMotion = usePreferencesStore((state) => state.reduceMotion);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const chatFontSize = usePreferencesStore((state) => state.chatFontSize);
  const interfaceScale = usePreferencesStore((state) => state.interfaceScale);
  const colorTheme = usePreferencesStore((state) => state.colorTheme);
  const preferences: AppPreferences = {
    notificationsEnabled,
    notificationSound,
    notificationPreview,
    compactMode,
    sendOnEnter,
    sendTypingStatus,
    autoplayAnimations,
    autoDownloadImages,
    autoDownloadVideos,
    autoDownloadAudio,
    autoDownloadFiles,
    autoDownloadLimitMb,
    reduceMotion,
    developerMode,
    chatFontSize,
    interfaceScale,
    colorTheme,
  };
  const setPreference = usePreferencesStore((state) => state.setPreference);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("account");
  const [detailOpen, setDetailOpen] = useState(false);
  const [draft, setDraft] = useState<ProxySettings>(emptySettings);
  const [storageDraft, setStorageDraft] = useState<StorageSettings>(emptyStorageSettings);
  const [preferenceError, setPreferenceError] = useState<string>();

  useEffect(() => {
    void load();
    void loadStorage();
  }, [load, loadStorage]);

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  useEffect(() => {
    if (storageSettings) setStorageDraft(structuredClone(storageSettings));
  }, [storageSettings]);

  useEffect(() => {
    if (activeCategory === "advanced") void loadCacheUsage();
  }, [activeCategory, loadCacheUsage]);

  const updateCustom = <K extends keyof ProxySettings["custom"]>(
    key: K,
    value: ProxySettings["custom"][K],
  ) => setDraft((current) => ({
    ...current,
    custom: { ...current.custom, [key]: value },
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (activeCategory !== "advanced") return;
    const proxySaved = await save(draft);
    const storageSaved = await saveStorage(storageDraft);
    if (proxySaved && storageSaved) onClose();
  };

  const active = categories.find((category) => category.id === activeCategory) ?? categories[0];
  const ActiveIcon = active.icon;
  const activeEndpoint = draft.mode === "system" ? draft.system : draft.custom;
  const busy = pending || storagePending;
  const dialogRef = useModalFocus<HTMLFormElement>(onClose, busy);

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
      setPreferenceError("系统通知权限未开启");
      return;
    }
    setPreference(key, value);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form
        ref={dialogRef}
        className={`settings-dialog ${detailOpen ? "show-detail" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onSubmit={submit}
      >
        <header className="settings-dialog-header">
          <h2 id="settings-title">设置</h2>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <nav className="settings-categories" aria-label="设置分类">
          {categories.map((category) => {
            const Icon = category.icon;
            const detail = category.id === "account"
              ? currentUser?.displayName ?? (currentUserId ? "Telegram 账号" : undefined)
              : category.detail;
            return (
              <button
                key={category.id}
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
                {detail && <small>{detail}</small>}
                <ChevronRight className="settings-category-chevron" size={17} />
              </button>
            );
          })}
        </nav>

        <main className={`settings-detail ${activeCategory === "advanced" ? "is-advanced" : ""}`}>
          <header className="settings-detail-header">
            <button
              className="settings-mobile-back icon-button"
              type="button"
              aria-label="返回设置分类"
              title="返回"
              onClick={() => setDetailOpen(false)}
            >
              <ArrowLeft size={19} />
            </button>
            <ActiveIcon size={22} strokeWidth={1.8} />
            <h3>{active.label}</h3>
          </header>

          {activeCategory === "account" ? (
            <AccountSettings
              accounts={accounts}
              activeAccountId={activeAccountId}
              currentUser={currentUser}
              pending={accountPending}
              error={accountError}
              onAdd={() => void addAccount()}
              onSwitch={(accountId) => void switchAccount(accountId)}
              onLogOut={() => void logOutCurrentAccount()}
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
              activeEndpoint={activeEndpoint}
              setDraft={setDraft}
              setStorageDraft={setStorageDraft}
              updateCustom={updateCustom}
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
              developerMode={developerMode}
              onDeveloperModeChange={(enabled) => setPreference("developerMode", enabled)}
            />
          ) : activeCategory === "updates" ? (
            <UpdateSettings />
          ) : activeCategory === "diagnostics" ? (
            <DiagnosticsSettings />
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
  const options: Array<{
    key: BooleanPreferenceKey;
    label: string;
    disabled?: boolean;
  }> = category === "notgram"
    ? [
        { key: "sendTypingStatus" as const, label: "发送输入状态" },
      ]
    : category === "notifications"
    ? [
        { key: "notificationsEnabled" as const, label: "桌面通知" },
        { key: "notificationPreview" as const, label: "显示消息预览", disabled: !preferences.notificationsEnabled },
        { key: "notificationSound" as const, label: "通知声音", disabled: !preferences.notificationsEnabled },
      ]
    : category === "chats"
      ? [
          { key: "compactMode" as const, label: "紧凑会话密度" },
          { key: "sendOnEnter" as const, label: "Enter 键发送" },
        ]
      : [
          { key: "autoplayAnimations" as const, label: "自动播放动画" },
          { key: "reduceMotion" as const, label: "减少动态效果" },
        ];

  return (
    <div className="settings-detail-scroll preference-settings">
      {category === "chats" && (
        <section className="settings-section" aria-labelledby="chat-display-heading">
          <div className="settings-section-heading">
            <Gauge size={18} strokeWidth={1.8} />
            <div>
              <h4 id="chat-display-heading">显示</h4>
              <span>主题、字体与界面比例</span>
            </div>
          </div>
          <div className="display-preference-list">
            <div className="theme-preference">
              <strong>界面样式</strong>
              <div className="theme-segmented-control" aria-label="界面样式">
                <button
                  type="button"
                  aria-pressed={preferences.colorTheme === "light"}
                  onClick={() => onChange("colorTheme", "light")}
                >
                  <Sun size={15} />
                  浅色
                </button>
                <button
                  type="button"
                  aria-pressed={preferences.colorTheme === "dark"}
                  onClick={() => onChange("colorTheme", "dark")}
                >
                  <Moon size={15} />
                  深色
                </button>
              </div>
            </div>
            <label className="range-preference">
              <span><strong>消息字体大小</strong><output>{preferences.chatFontSize} px</output></span>
              <input
                type="range"
                min={12}
                max={20}
                step={1}
                value={preferences.chatFontSize}
                aria-label="消息字体大小"
                onChange={(event) => onChange("chatFontSize", Number(event.target.value))}
              />
            </label>
            <label className="range-preference">
              <span><strong>界面缩放比例</strong><output>{preferences.interfaceScale}%</output></span>
              <input
                type="range"
                min={80}
                max={150}
                step={5}
                value={preferences.interfaceScale}
                aria-label="界面缩放比例"
                onChange={(event) => onChange("interfaceScale", Number(event.target.value))}
              />
            </label>
          </div>
          <button
            className="storage-reset display-reset"
            type="button"
            disabled={
              preferences.colorTheme === "light" &&
              preferences.chatFontSize === 14 &&
              preferences.interfaceScale === 100
            }
            onClick={() => {
              onChange("colorTheme", "light");
              onChange("chatFontSize", 14);
              onChange("interfaceScale", 100);
            }}
          >
            <RotateCcw size={15} strokeWidth={2} />
            恢复显示默认值
          </button>
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
      </section>
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
}

interface AccountSettingsProps {
  accounts: TelegramAccount[];
  activeAccountId: string;
  currentUser?: User;
  pending: boolean;
  error?: string;
  onAdd: () => void;
  onSwitch: (accountId: string) => void;
  onLogOut: () => void;
}

function AccountSettings({
  accounts,
  activeAccountId,
  currentUser,
  pending,
  error,
  onAdd,
  onSwitch,
  onLogOut,
}: AccountSettingsProps) {
  const [logoutConfirmation, setLogoutConfirmation] = useState(false);
  const visibleAccounts = accounts.some((account) => account.id === activeAccountId) || !currentUser
    ? accounts
    : [
        ...accounts,
        {
          id: activeAccountId,
          userId: currentUser.id,
          displayName: currentUser.displayName,
          avatar: currentUser.avatar,
        },
      ];

  return (
    <div className="settings-detail-scroll account-settings">
      <section className="settings-section" aria-labelledby="accounts-heading">
        <div className="settings-section-heading">
          <UserCircle size={18} strokeWidth={1.8} />
          <div>
            <h4 id="accounts-heading">已登录账号</h4>
            <span>账号数据分别存储，切换时会重新连接 Telegram</span>
          </div>
        </div>
        <div className="account-list">
          {visibleAccounts.map((account) => {
            const active = account.id === activeAccountId;
            return (
              <button
                className={`account-row ${active ? "is-active" : ""}`}
                type="button"
                key={account.id}
                disabled={pending || active}
                aria-current={active ? "true" : undefined}
                onClick={() => onSwitch(account.id)}
              >
                <Avatar avatar={account.avatar} size="medium" />
                <span className="account-row-copy">
                  <strong>{account.displayName}</strong>
                  <small>{active ? "当前账号" : "切换到此账号"}</small>
                </span>
                {active && <Check size={18} strokeWidth={2.2} />}
              </button>
            );
          })}
        </div>
        <button className="account-command" type="button" disabled={pending} onClick={onAdd}>
          {pending ? <LoaderCircle className="spin" size={18} /> : <UserPlus size={18} />}
          <span>添加账号</span>
        </button>
      </section>

      {currentUser && (
        <section className="settings-section account-session-section" aria-labelledby="session-heading">
          <div className="settings-section-heading">
            <LogOut size={18} strokeWidth={1.8} />
            <div>
              <h4 id="session-heading">当前会话</h4>
              <span>{currentUser.displayName}</span>
            </div>
          </div>
          {logoutConfirmation ? (
            <div className="account-logout-confirm" role="group" aria-label="确认退出登录">
              <p>退出后将删除此账号在本机的 TDLib 数据和界面缓存，其他账号不受影响。</p>
              <div>
                <button className="dialog-secondary" type="button" disabled={pending} onClick={() => setLogoutConfirmation(false)}>取消</button>
                <button className="dialog-danger" type="button" disabled={pending} onClick={onLogOut}>
                  {pending && <LoaderCircle className="spin" size={16} />}
                  退出登录
                </button>
              </div>
            </div>
          ) : (
            <button className="account-command is-danger" type="button" disabled={pending} onClick={() => setLogoutConfirmation(true)}>
              <LogOut size={18} />
              <span>退出当前账号</span>
            </button>
          )}
        </section>
      )}

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
  activeEndpoint?: ProxySettings["custom"];
  developerMode: boolean;
  setDraft: Dispatch<SetStateAction<ProxySettings>>;
  setStorageDraft: Dispatch<SetStateAction<StorageSettings>>;
  updateCustom: <K extends keyof ProxySettings["custom"]>(
    key: K,
    value: ProxySettings["custom"][K],
  ) => void;
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
  onDeveloperModeChange: (enabled: boolean) => void;
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
  activeEndpoint,
  developerMode,
  setDraft,
  setStorageDraft,
  updateCustom,
  onTest,
  onRebuildCache,
  onRefreshCache,
  onClearCache,
  autoDownload,
  onAutoDownloadToggle,
  onAutoDownloadLimitChange,
  onDeveloperModeChange,
}: AdvancedSettingsProps) {
  const [selectedCacheCategories, setSelectedCacheCategories] = useState<CacheCategory[]>(
    cacheCategories.map((category) => category.id),
  );
  const [cacheRetentionDays, setCacheRetentionDays] = useState(0);
  const toggleCacheCategory = (category: CacheCategory, selected: boolean) => {
    setSelectedCacheCategories((current) => selected
      ? [...new Set([...current, category])]
      : current.filter((item) => item !== category));
  };

  return (
    <>
      <div className="settings-detail-scroll">
        <section className="settings-section" aria-labelledby="connection-heading">
        <div className="settings-section-heading">
          <Network size={18} strokeWidth={1.8} />
          <div>
            <h4 id="connection-heading">连接</h4>
            <span>Telegram 网络与代理</span>
          </div>
        </div>

        <div className="proxy-mode" role="radiogroup" aria-label="代理模式">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={draft.mode === option.value}
              className={draft.mode === option.value ? "is-active" : ""}
              onClick={() => setDraft((current) => ({ ...current, mode: option.value }))}
            >
              {option.label}
            </button>
          ))}
        </div>

        {draft.mode === "system" && (
          <div className="proxy-system-status">
            <Network size={18} strokeWidth={1.8} />
            {draft.system ? (
              <div>
                <strong>{proxyTypeLabels[draft.system.type]}</strong>
                <span>{draft.system.server}:{draft.system.port}</span>
              </div>
            ) : (
              <div><strong>未检测到系统代理</strong><span>当前将使用直连</span></div>
            )}
          </div>
        )}

        {draft.mode === "direct" && (
          <div className="proxy-system-status">
            <Network size={18} strokeWidth={1.8} />
            <div><strong>直连</strong><span>TDLib 代理已停用</span></div>
          </div>
        )}

        {draft.mode === "custom" && (
          <div className="proxy-fields">
            <label className="auth-field">
              <span>代理类型</span>
              <select value={draft.custom.type} onChange={(event) => updateCustom("type", event.target.value as ProxyType)}>
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
                <option value="mtproto">MTProto</option>
              </select>
            </label>
            <div className="proxy-address-row">
              <label className="auth-field">
                <span>服务器</span>
                <input required value={draft.custom.server} onChange={(event) => updateCustom("server", event.target.value)} />
              </label>
              <label className="auth-field proxy-port">
                <span>端口</span>
                <input required type="number" min={1} max={65535} value={draft.custom.port} onChange={(event) => updateCustom("port", Number(event.target.value))} />
              </label>
            </div>

            {draft.custom.type === "mtproto" ? (
              <label className="auth-field">
                <span>Secret</span>
                <input required type="password" autoComplete="off" value={draft.custom.secret} onChange={(event) => updateCustom("secret", event.target.value)} />
              </label>
            ) : (
              <div className="proxy-address-row">
                <label className="auth-field">
                  <span>用户名</span>
                  <input autoComplete="username" value={draft.custom.username} onChange={(event) => updateCustom("username", event.target.value)} />
                </label>
                <label className="auth-field">
                  <span>密码</span>
                  <input type="password" autoComplete="current-password" value={draft.custom.password} onChange={(event) => updateCustom("password", event.target.value)} />
                </label>
              </div>
            )}

            {draft.custom.type === "http" && (
              <label className="proxy-checkbox">
                <input type="checkbox" checked={draft.custom.httpOnly} onChange={(event) => updateCustom("httpOnly", event.target.checked)} />
                <span>仅 HTTP，不使用 CONNECT</span>
              </label>
            )}
          </div>
        )}

        <div className="settings-inline-actions">
          <button
            className="dialog-secondary"
            type="button"
            disabled={busy || (draft.mode === "system" && !activeEndpoint)}
            onClick={onTest}
          >
            {pending ? <LoaderCircle className="spin" size={17} /> : <Gauge size={17} />}
            <span>测速</span>
          </button>
          {latency !== undefined && <span className="proxy-latency" role="status">延迟 {latency} ms</span>}
        </div>
        </section>

        <section className="settings-section" aria-labelledby="storage-heading">
        <div className="settings-section-heading">
          <HardDrive size={18} strokeWidth={1.8} />
          <div>
            <h4 id="storage-heading">存储路径</h4>
            <span>缓存路径重启后生效</span>
          </div>
        </div>
        <label className="auth-field">
          <span>缓存路径</span>
          <input
            value={storageDraft.cachePath}
            placeholder={storageDraft.defaultCachePath}
            onChange={(event) => setStorageDraft((current) => ({ ...current, cachePath: event.target.value }))}
          />
        </label>
        <label className="auth-field">
          <span>下载路径</span>
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
          <span>恢复默认路径</span>
        </button>
        <div className="settings-inline-actions">
          <button
            className="storage-reset"
            type="button"
            disabled={busy}
            onClick={onRebuildCache}
          >
            <RotateCcw size={15} strokeWidth={2} />
            <span>重建界面缓存</span>
          </button>
          <span className="cache-health" role="status">
            缓存状态：{cacheHealthLabels[cacheHealth]}
          </span>
        </div>
        </section>

        <section className="settings-section" aria-labelledby="media-cache-heading">
          <div className="settings-section-heading">
            <HardDrive size={18} strokeWidth={1.8} />
            <div>
              <h4 id="media-cache-heading">媒体缓存</h4>
              <span>当前消息、播放中和下载中的文件会受到保护</span>
            </div>
          </div>
          <div className="cache-usage-summary" aria-live="polite">
            <strong>{cacheUsage ? formatBytes(cacheUsage.total.bytes) : "正在统计"}</strong>
            <span>{cacheUsage ? `${cacheUsage.total.files} 个文件` : "请稍候"}</span>
            <button
              className="storage-reset"
              type="button"
              disabled={busy}
              onClick={onRefreshCache}
            >
              <RotateCcw className={busy ? "spin" : undefined} size={15} strokeWidth={2} />
              <span>刷新</span>
            </button>
          </div>
          {cacheUsage && (
            <div className="cache-category-list" aria-label="缓存类型">
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
                    <small>{formatBytes(usage.bytes)} · {usage.files} 个</small>
                  </label>
                );
              })}
            </div>
          )}
          <label className="auth-field cache-retention-field">
            <span>清理范围</span>
            <select
              value={cacheRetentionDays}
              disabled={busy}
              onChange={(event) => setCacheRetentionDays(Number(event.target.value))}
            >
              <option value={0}>全部时间</option>
              <option value={7}>7 天前</option>
              <option value={30}>30 天前</option>
              <option value={90}>90 天前</option>
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
              <span>清理所选</span>
            </button>
            <button
              className="dialog-danger"
              type="button"
              disabled={busy || !cacheUsage || cacheUsage.total.files === 0}
              onClick={() => void onClearCache(cacheCategories.map((category) => category.id))}
            >
              <Trash2 size={16} />
              <span>清理全部缓存</span>
            </button>
          </div>
          {cacheCleanupResult && (
            <p className="cache-cleanup-result" role="status">
              已清理 {formatBytes(cacheCleanupResult.removedBytes)}，共 {cacheCleanupResult.removedFiles} 个文件
              {cacheCleanupResult.skippedProtectedFiles > 0
                ? `；已保护 ${cacheCleanupResult.skippedProtectedFiles} 个正在使用的文件`
                : ""}
            </p>
          )}
        </section>

        <section className="settings-section" aria-labelledby="auto-download-heading">
          <div className="settings-section-heading">
            <CloudDownload size={18} strokeWidth={1.8} />
            <div>
              <h4 id="auto-download-heading">自动下载</h4>
              <span>浏览会话时会提前缓存上方约 1.5 屏的封面，下载目录不受影响</span>
            </div>
          </div>
          <div className="preference-list">
            {([
              ["autoDownloadImages", "图片、贴纸与动画"],
              ["autoDownloadVideos", "视频与视频消息"],
              ["autoDownloadAudio", "音频与语音"],
              ["autoDownloadFiles", "普通文件"],
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
            <span>单个文件上限</span>
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

        <section className="settings-section" aria-labelledby="developer-heading">
          <div className="settings-section-heading">
            <Code2 size={18} strokeWidth={1.8} />
            <div>
              <h4 id="developer-heading">开发者选项</h4>
              <span>消息诊断工具</span>
            </div>
          </div>
          <div className="preference-list">
            <label className="preference-row">
              <span>开发者模式</span>
              <input
                type="checkbox"
                role="switch"
                checked={developerMode}
                onChange={(event) => onDeveloperModeChange(event.target.checked)}
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
          <span>保存更改</span>
        </button>
      </footer>
    </>
  );
}
