import { Gauge, HardDrive, LoaderCircle, Network, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { ProxyMode, ProxySettings, ProxyType, StorageSettings } from "../telegram/types";

interface ProxySettingsDialogProps {
  onClose: () => void;
}

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

export function ProxySettingsDialog({ onClose }: ProxySettingsDialogProps) {
  const settings = useTelegramStore((state) => state.proxySettings);
  const pending = useTelegramStore((state) => state.proxyPending);
  const error = useTelegramStore((state) => state.proxyError);
  const latency = useTelegramStore((state) => state.proxyLatencyMs);
  const storageSettings = useTelegramStore((state) => state.storageSettings);
  const storagePending = useTelegramStore((state) => state.storagePending);
  const storageError = useTelegramStore((state) => state.storageError);
  const load = useTelegramStore((state) => state.loadProxySettings);
  const save = useTelegramStore((state) => state.saveProxySettings);
  const test = useTelegramStore((state) => state.testProxy);
  const loadStorage = useTelegramStore((state) => state.loadStorageSettings);
  const saveStorage = useTelegramStore((state) => state.saveStorageSettings);
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
    const proxySaved = await save(draft);
    const storageSaved = await saveStorage(storageDraft);
    if (proxySaved && storageSaved) onClose();
  };

  const activeEndpoint = draft.mode === "system" ? draft.system : draft.custom;
  const busy = pending || storagePending;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="proxy-dialog" role="dialog" aria-modal="true" aria-labelledby="proxy-title">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">CONNECTION</span>
            <h2 id="proxy-title">设置</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <form className="proxy-form" onSubmit={submit}>
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
              <div><strong>直连</strong><span>TDLib 代理将被停用</span></div>
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

          <section className="storage-fields" aria-label="存储路径">
            <div className="storage-heading">
              <HardDrive size={18} strokeWidth={1.8} />
              <div>
                <strong>存储路径</strong>
                <span>缓存路径重启后生效；下载默认保存到软件目录 downloads。</span>
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

          {error && <div className="auth-error" role="alert">{error}</div>}
          {storageError && <div className="auth-error" role="alert">{storageError}</div>}
          {latency !== undefined && <div className="proxy-latency" role="status">延迟 {latency} ms</div>}

          <footer className="dialog-actions">
            <button
              className="dialog-secondary"
              type="button"
              disabled={busy || (draft.mode === "system" && !activeEndpoint)}
              onClick={() => void test(draft)}
            >
              {pending ? <LoaderCircle className="spin" size={17} /> : <Gauge size={17} />}
              <span>测速</span>
            </button>
            <button className="auth-submit dialog-save" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
              <span>保存</span>
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
