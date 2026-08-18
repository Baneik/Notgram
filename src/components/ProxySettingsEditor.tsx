import {
  Check,
  Gauge,
  LoaderCircle,
  Network,
  Plus,
  Shuffle,
  Trash2,
} from "lucide-react";
import type { ProxyEndpoint, ProxyMode, ProxyProfile, ProxySettings, ProxyType } from "../telegram/types";

interface ProxySettingsEditorProps {
  settings: ProxySettings;
  busy: boolean;
  pending: boolean;
  latency?: number;
  onChange: (settings: ProxySettings) => void;
  onTest: () => void;
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

const defaultEndpoint = (): ProxyEndpoint => ({
  type: "http",
  server: "127.0.0.1",
  port: 7890,
  username: "",
  password: "",
  secret: "",
  httpOnly: false,
});

const newProfile = (position: number): ProxyProfile => ({
  id: crypto.randomUUID(),
  name: `代理 ${position}`,
  endpoint: defaultEndpoint(),
});

export function ProxySettingsEditor({
  settings,
  busy,
  pending,
  latency,
  onChange,
  onTest,
}: ProxySettingsEditorProps) {
  const activeProfile = settings.profiles.find(
    (profile) => profile.id === settings.activeProfileId,
  ) ?? settings.profiles[0];
  const activeEndpoint = settings.mode === "system"
    ? settings.system
    : activeProfile?.endpoint;

  const updateProfile = (profileId: string, update: (profile: ProxyProfile) => ProxyProfile) => {
    onChange({
      ...settings,
      profiles: settings.profiles.map((profile) =>
        profile.id === profileId ? update(profile) : profile),
    });
  };

  const updateEndpoint = <Key extends keyof ProxyEndpoint>(
    key: Key,
    value: ProxyEndpoint[Key],
  ) => {
    if (!activeProfile) return;
    updateProfile(activeProfile.id, (profile) => ({
      ...profile,
      endpoint: { ...profile.endpoint, [key]: value },
    }));
  };

  const addProfile = () => {
    if (settings.profiles.length >= 20) return;
    const profile = newProfile(settings.profiles.length + 1);
    onChange({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.id,
    });
  };

  const removeProfile = (profileId: string) => {
    if (settings.profiles.length <= 1) return;
    const profiles = settings.profiles.filter((profile) => profile.id !== profileId);
    onChange({
      ...settings,
      profiles,
      activeProfileId: settings.activeProfileId === profileId
        ? profiles[0].id
        : settings.activeProfileId,
      autoSwitch: profiles.length > 1 && settings.autoSwitch,
    });
  };

  return (
    <>
      <div className="proxy-mode" role="radiogroup" aria-label="代理模式">
        {modeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={settings.mode === option.value}
            className={settings.mode === option.value ? "is-active" : ""}
            onClick={() => onChange({ ...settings, mode: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>

      {settings.mode === "system" ? (
        <div className="proxy-system-status">
          <Network size={18} strokeWidth={1.8} />
          {settings.system ? (
            <div>
              <strong>{proxyTypeLabels[settings.system.type]}</strong>
              <span>{settings.system.server}:{settings.system.port}</span>
            </div>
          ) : (
            <div><strong>未检测到系统代理</strong><span>当前将使用直连</span></div>
          )}
        </div>
      ) : null}

      {settings.mode === "direct" ? (
        <div className="proxy-system-status">
          <Network size={18} strokeWidth={1.8} />
          <div><strong>直连</strong><span>TDLib 代理已停用</span></div>
        </div>
      ) : null}

      {settings.mode === "custom" && activeProfile ? (
        <div className="proxy-custom-settings">
          <div className="proxy-profile-list" role="list" aria-label="自定义代理">
            {settings.profiles.map((profile) => {
              const selected = profile.id === activeProfile.id;
              return (
                <div
                  key={profile.id}
                  className={`proxy-profile-row ${selected ? "is-active" : ""}`}
                  role="listitem"
                >
                  <button
                    className="proxy-profile-select"
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChange({ ...settings, activeProfileId: profile.id })}
                  >
                    {selected ? <Check size={16} /> : <Network size={16} />}
                    <span>
                      <strong>{profile.name}</strong>
                      <small>{profile.endpoint.server}:{profile.endpoint.port}</small>
                    </span>
                  </button>
                  <button
                    className="icon-button proxy-profile-remove"
                    type="button"
                    aria-label={`删除 ${profile.name}`}
                    title="删除代理"
                    disabled={settings.profiles.length <= 1}
                    onClick={() => removeProfile(profile.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
            <button
              className="proxy-profile-add"
              type="button"
              disabled={settings.profiles.length >= 20}
              onClick={addProfile}
            >
              <Plus size={16} />
              <span>添加代理</span>
            </button>
          </div>

          <label className="proxy-auto-switch">
            <span>
              <Shuffle size={16} />
              <span><strong>自动切换</strong><small>连续连接失败后轮换到下一项</small></span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.autoSwitch}
              disabled={settings.profiles.length < 2}
              onChange={(event) => onChange({ ...settings, autoSwitch: event.target.checked })}
            />
          </label>

          <div className="proxy-fields">
            <label className="auth-field">
              <span>名称</span>
              <input
                required
                maxLength={40}
                value={activeProfile.name}
                onChange={(event) => updateProfile(activeProfile.id, (profile) => ({
                  ...profile,
                  name: event.target.value,
                }))}
              />
            </label>
            <label className="auth-field">
              <span>代理类型</span>
              <select
                value={activeProfile.endpoint.type}
                onChange={(event) => updateEndpoint("type", event.target.value as ProxyType)}
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
                <option value="mtproto">MTProto</option>
              </select>
            </label>
            <div className="proxy-address-row">
              <label className="auth-field">
                <span>服务器</span>
                <input
                  required
                  value={activeProfile.endpoint.server}
                  onChange={(event) => updateEndpoint("server", event.target.value)}
                />
              </label>
              <label className="auth-field proxy-port">
                <span>端口</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={activeProfile.endpoint.port}
                  onChange={(event) => updateEndpoint("port", Number(event.target.value))}
                />
              </label>
            </div>

            {activeProfile.endpoint.type === "mtproto" ? (
              <label className="auth-field">
                <span>Secret</span>
                <input
                  required
                  type="password"
                  autoComplete="off"
                  value={activeProfile.endpoint.secret}
                  onChange={(event) => updateEndpoint("secret", event.target.value)}
                />
              </label>
            ) : (
              <div className="proxy-address-row">
                <label className="auth-field">
                  <span>用户名</span>
                  <input
                    autoComplete="username"
                    value={activeProfile.endpoint.username}
                    onChange={(event) => updateEndpoint("username", event.target.value)}
                  />
                </label>
                <label className="auth-field">
                  <span>密码</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={activeProfile.endpoint.password}
                    onChange={(event) => updateEndpoint("password", event.target.value)}
                  />
                </label>
              </div>
            )}

            {activeProfile.endpoint.type === "http" ? (
              <label className="proxy-checkbox">
                <input
                  type="checkbox"
                  checked={activeProfile.endpoint.httpOnly}
                  onChange={(event) => updateEndpoint("httpOnly", event.target.checked)}
                />
                <span>仅 HTTP，不使用 CONNECT</span>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="settings-inline-actions">
        <button
          className="dialog-secondary"
          type="button"
          disabled={busy || (settings.mode === "system" && !activeEndpoint)}
          onClick={onTest}
        >
          {pending ? <LoaderCircle className="spin" size={17} /> : <Gauge size={17} />}
          <span>测速</span>
        </button>
        {latency !== undefined ? (
          <span className="proxy-latency" role="status">延迟 {latency} ms</span>
        ) : null}
      </div>
    </>
  );
}
