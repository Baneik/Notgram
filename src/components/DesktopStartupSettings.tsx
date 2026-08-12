import { MonitorCog } from "lucide-react";
import { useEffect, useState } from "react";
import {
  desktopSettings,
  type DesktopSettings,
} from "../release/desktopSettings";

export function DesktopStartupSettings() {
  const [settings, setSettings] = useState<DesktopSettings>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void desktopSettings.settings()
      .then((result) => {
        if (active) setSettings(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const updateLaunchOnStartup = async (enabled: boolean) => {
    setPending(true);
    setError(undefined);
    try {
      setSettings(await desktopSettings.setLaunchOnStartup(enabled));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="desktop-startup-heading">
      <div className="settings-section-heading">
        <MonitorCog size={18} strokeWidth={1.8} />
        <div>
          <h4 id="desktop-startup-heading">桌面启动</h4>
          <span>Windows 登录与后台驻留</span>
        </div>
      </div>
      <div className="preference-list">
        <label className="preference-row">
          <span>登录 Windows 时启动 Notgram</span>
          <input
            type="checkbox"
            role="switch"
            checked={settings?.launchOnStartup ?? false}
            disabled={pending || settings?.supported !== true}
            onChange={(event) => void updateLaunchOnStartup(event.target.checked)}
          />
        </label>
      </div>
      {error && <div className="settings-error" role="alert">{error}</div>}
    </section>
  );
}
