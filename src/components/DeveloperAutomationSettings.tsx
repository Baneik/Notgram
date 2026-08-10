import { LoaderCircle, Network } from "lucide-react";
import { useEffect, useState } from "react";
import {
  appAutomation,
  type AutomationPreferences,
  type AutomationSettings,
} from "../release/automation";

const initialSettings: AutomationSettings = {
  enabled: false,
  port: 9333,
  active: false,
  restartRequired: false,
  launchOverride: false,
};

interface DeveloperAutomationSettingsProps {
  developerMode: boolean;
}

export function DeveloperAutomationSettings({
  developerMode,
}: DeveloperAutomationSettingsProps) {
  const supported = appAutomation.isAvailable();
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState<AutomationPreferences>(initialSettings);
  const [activity, setActivity] = useState<"loading" | "saving" | undefined>(
    supported ? "loading" : undefined,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    void appAutomation.settings().then((next) => {
      if (!mounted) return;
      setSettings(next);
      setDraft({ enabled: next.enabled, port: next.port });
      setFailed(false);
    }).catch(() => {
      if (mounted) setFailed(true);
    }).finally(() => {
      if (mounted) setActivity(undefined);
    });
    return () => { mounted = false; };
  }, []);

  const changed = draft.enabled !== settings.enabled || draft.port !== settings.port;
  const save = async () => {
    setActivity("saving");
    setFailed(false);
    try {
      const next = await appAutomation.save(draft);
      setSettings(next);
      setDraft({ enabled: next.enabled, port: next.port });
    } catch {
      setFailed(true);
    } finally {
      setActivity(undefined);
    }
  };

  const status = (() => {
    if (!supported) return "浏览器预览不开放原生调试端口";
    if (activity === "loading") return "正在读取调试设置";
    if (activity === "saving") return "正在保存调试设置";
    if (failed) return "调试设置保存失败";
    if (settings.launchOverride && settings.activePort) {
      return `当前由启动参数临时监听 127.0.0.1:${settings.activePort}`;
    }
    if (settings.restartRequired) return "设置已保存，完全退出并重新打开 Notgram 后生效";
    if (settings.activePort) return `正在监听 127.0.0.1:${settings.activePort}`;
    return "当前关闭，不接受 Playwright 连接";
  })();

  return (
    <div
      className="developer-automation-settings"
      data-automation-active={settings.active ? "true" : "false"}
    >
      <div className="preference-list">
        <label className="preference-row">
          <span>允许本机 Playwright 调试</span>
          <input
            type="checkbox"
            role="switch"
            checked={draft.enabled}
            disabled={Boolean(activity) || !supported || (!developerMode && !draft.enabled)}
            onChange={(event) => setDraft((current) => ({
              ...current,
              enabled: event.target.checked,
            }))}
          />
        </label>
      </div>
      <label className="auth-field automation-port-field">
        <span>本机端口</span>
        <input
          type="number"
          min={1024}
          max={65535}
          value={draft.port}
          disabled={Boolean(activity) || !supported || !developerMode}
          onChange={(event) => setDraft((current) => ({
            ...current,
            port: Math.max(1_024, Math.min(65_535, Number(event.target.value) || 9_333)),
          }))}
        />
      </label>
      <div className="settings-inline-actions">
        <button
          className="dialog-secondary"
          type="button"
          disabled={Boolean(activity) || !supported || !changed}
          onClick={() => void save()}
        >
          {activity === "saving" ? <LoaderCircle className="spin" size={16} /> : <Network size={16} />}
          <span>保存调试设置</span>
        </button>
        <span className="diagnostics-status" role="status">{status}</span>
      </div>
      <p className="preference-policy-note">
        仅绑定 127.0.0.1。连接者可以读取并操作当前登录界面，完成调试后应立即关闭。
      </p>
    </div>
  );
}
