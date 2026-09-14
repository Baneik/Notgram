import { Link } from "lucide-react";
import { useEffect, useState } from "react";
import { translate } from "../i18n";
import { telegramProtocol, type TelegramProtocolSettings as Settings } from "../release/telegramProtocol";

export function TelegramProtocolSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const read = () => void telegramProtocol.settings().then(value => { if (active) setSettings(value); })
      .catch(reason => { if (active) setError(String(reason)); });
    read();
    globalThis.addEventListener("focus", read);
    return () => { active = false; globalThis.removeEventListener("focus", read); };
  }, []);
  const register = async () => {
    setPending(true); setError(undefined);
    try { setSettings(await telegramProtocol.register()); }
    catch (reason) { setError(String(reason)); }
    finally { setPending(false); }
  };
  return <section className="settings-section" aria-labelledby="telegram-protocol-heading">
    <div className="settings-section-heading">
      <Link size={18} strokeWidth={1.8} />
      <div><h4 id="telegram-protocol-heading">{translate("Telegram 链接")}</h4>
        <span>{translate("从浏览器打开 Notgram")}</span></div>
    </div>
    <p className="settings-description">{settings?.isDefault ? translate("Telegram 链接已由 Notgram 打开")
      : translate("注册后，可将 Notgram 设为 Telegram 链接的默认应用")}</p>
    <div className="preference-list">
      <div className="preference-row"><span>{translate("使用此位置的 Notgram 打开链接")}</span>
        <button className="dialog-secondary" type="button" disabled={!settings?.supported || pending || settings.isDefault}
          onClick={() => void register()}>{settings?.isDefault ? translate("已启用") : translate("注册 Telegram 链接")}</button></div>
      {settings?.registered && !settings.isDefault && <>
        <p className="settings-description">{translate("在 Windows 默认应用中，将 TG 链接类型设为 Notgram")}</p>
        <button className="dialog-secondary" type="button" onClick={() => void telegramProtocol.openDefaultApps().catch(reason => setError(String(reason)))}>{translate("打开 Windows 默认应用")}</button>
      </>}
    </div>
    {error && <div className="settings-error" role="alert">{error}</div>}
  </section>;
}
