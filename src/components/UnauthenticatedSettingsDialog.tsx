import { LoaderCircle, Network, Save, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useTelegramStore } from "../store/telegramStore";
import type { ProxySettings } from "../telegram/types";
import { ProxySettingsEditor } from "./ProxySettingsEditor";

const defaultProxySettings: ProxySettings = {
  mode: "system",
  profiles: [{
    id: "proxy-1",
    name: "代理 1",
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

interface UnauthenticatedSettingsDialogProps {
  onClose: () => void;
}

export function UnauthenticatedSettingsDialog({ onClose }: UnauthenticatedSettingsDialogProps) {
  const settings = useTelegramStore((state) => state.proxySettings);
  const pending = useTelegramStore((state) => state.proxyPending);
  const error = useTelegramStore((state) => state.proxyError);
  const latency = useTelegramStore((state) => state.proxyLatencyMs);
  const load = useTelegramStore((state) => state.loadProxySettings);
  const save = useTelegramStore((state) => state.saveProxySettings);
  const test = useTelegramStore((state) => state.testProxy);
  const [draft, setDraft] = useState<ProxySettings>(defaultProxySettings);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useModalFocus<HTMLFormElement>(onClose, pending, titleRef);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await save(draft)) onClose();
  };

  const testDraft = () => {
    void test(draft);
  };

  return (
    <div
      className="dialog-backdrop auth-settings-backdrop"
      role="presentation"
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="login-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-settings-title"
        tabIndex={-1}
        onSubmit={submit}
      >
        <header className="login-settings-header">
          <div>
            <Network size={20} />
            <h2 ref={titleRef} id="login-settings-title" tabIndex={-1}>登录设置</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" disabled={pending} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="login-settings-body">
          <div className="login-settings-intro">
            <strong>代理连接</strong>
            <span>登录前仅可调整 Telegram 网络连接</span>
          </div>
          <ProxySettingsEditor
            settings={draft}
            busy={pending}
            pending={pending}
            latency={latency}
            onChange={setDraft}
            onTest={testDraft}
          />
          {error && <div className="auth-error" role="alert">{error}</div>}
        </div>

        <footer className="login-settings-actions">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>取消</button>
          <button className="dialog-save" type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            <span>保存代理</span>
          </button>
        </footer>
      </form>
    </div>
  );
}
