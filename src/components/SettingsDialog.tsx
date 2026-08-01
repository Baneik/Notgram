import {
  ArrowLeft,
  BatteryCharging,
  Bell,
  ChevronRight,
  Folder,
  Gauge,
  HardDrive,
  Languages,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Network,
  RotateCcw,
  Save,
  SlidersHorizontal,
  UserCircle,
  Volume2,
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
import type { ProxyMode, ProxySettings, ProxyType, StorageSettings } from "../telegram/types";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsCategoryId =
  | "account"
  | "notifications"
  | "privacy"
  | "chats"
  | "folders"
  | "advanced"
  | "devices"
  | "power"
  | "language";

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  icon: LucideIcon;
  detail?: string;
}

const categories: SettingsCategory[] = [
  { id: "account", label: "我的账号", icon: UserCircle },
  { id: "notifications", label: "通知与声音", icon: Bell },
  { id: "privacy", label: "隐私和安全", icon: LockKeyhole },
  { id: "chats", label: "聊天设置", icon: MessageCircle },
  { id: "folders", label: "文件夹", icon: Folder },
  { id: "advanced", label: "高级设置", icon: SlidersHorizontal },
  { id: "devices", label: "扬声器和摄像头", icon: Volume2 },
  { id: "power", label: "电池和动画", icon: BatteryCharging },
  { id: "language", label: "语言", icon: Languages, detail: "简体中文 (beta)" },
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

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useTelegramStore((state) => state.proxySettings);
  const pending = useTelegramStore((state) => state.proxyPending);
  const error = useTelegramStore((state) => state.proxyError);
  const latency = useTelegramStore((state) => state.proxyLatencyMs);
  const storageSettings = useTelegramStore((state) => state.storageSettings);
  const storagePending = useTelegramStore((state) => state.storagePending);
  const storageError = useTelegramStore((state) => state.storageError);
  const currentUserId = useTelegramStore((state) => state.currentUserId);
  const currentUser = useTelegramStore((state) =>
    state.currentUserId ? state.users.get(state.currentUserId) : undefined,
  );
  const load = useTelegramStore((state) => state.loadProxySettings);
  const save = useTelegramStore((state) => state.saveProxySettings);
  const test = useTelegramStore((state) => state.testProxy);
  const loadStorage = useTelegramStore((state) => state.loadStorageSettings);
  const saveStorage = useTelegramStore((state) => state.saveStorageSettings);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("account");
  const [detailOpen, setDetailOpen] = useState(false);
  const [draft, setDraft] = useState<ProxySettings>(emptySettings);
  const [storageDraft, setStorageDraft] = useState<StorageSettings>(emptyStorageSettings);

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

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form
        className={`settings-dialog ${detailOpen ? "show-detail" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
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

          {activeCategory === "advanced" ? (
            <AdvancedSettings
              draft={draft}
              storageDraft={storageDraft}
              busy={busy}
              pending={pending}
              error={error}
              storageError={storageError}
              latency={latency}
              activeEndpoint={activeEndpoint}
              setDraft={setDraft}
              setStorageDraft={setStorageDraft}
              updateCustom={updateCustom}
              onTest={() => void test(draft)}
            />
          ) : (
            <div className="settings-empty">
              <ActiveIcon size={34} strokeWidth={1.5} />
              <span>暂无设置项</span>
            </div>
          )}
        </main>
      </form>
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
  latency?: number;
  activeEndpoint?: ProxySettings["custom"];
  setDraft: Dispatch<SetStateAction<ProxySettings>>;
  setStorageDraft: Dispatch<SetStateAction<StorageSettings>>;
  updateCustom: <K extends keyof ProxySettings["custom"]>(
    key: K,
    value: ProxySettings["custom"][K],
  ) => void;
  onTest: () => void;
}

function AdvancedSettings({
  draft,
  storageDraft,
  busy,
  pending,
  error,
  storageError,
  latency,
  activeEndpoint,
  setDraft,
  setStorageDraft,
  updateCustom,
  onTest,
}: AdvancedSettingsProps) {
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
