import { invoke } from "@tauri-apps/api/core";
import { ArchiveRestore, Check, Cloud, Download, LoaderCircle, Pencil, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { translate } from "../i18n";
import { currentSettingsBackup, restoreSettingsBackup } from "../backup/backupRuntime";
import { encodeSettingsBackup, MAX_BACKUP_BYTES } from "../backup/settingsBackup";
import {
  webdavBridge, WEBDAV_CONFIG_EVENT, WEBDAV_SYNC_STATUS,
  type WebDavConfig, type WebDavSummary,
} from "../backup/webdavBridge";

function syncMessage(state?: string, error?: string) {
  if (state === "syncing") return translate("同步中");
  if (state === "synced") return translate("已同步");
  if (state === "disabled") return translate("未启用");
  if (error === "http-401") return translate("认证失败（401）");
  if (error === "http-403") return translate("访问被拒绝（403）");
  if (error === "missing-etag") return translate("服务器不支持安全同步");
  if (error === "invalid-backup") return translate("云端备份无效");
  if (error === "conflict") return translate("同步冲突");
  return translate("同步失败");
}

export function BackupSettings() {
  const [summary, setSummary] = useState<WebDavSummary>();
  const [draft, setDraft] = useState<WebDavConfig>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sync, setSync] = useState<{ state: string; error?: string }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const supported = webdavBridge.available();

  useEffect(() => {
    let active = true;
    const load = () => {
      if (supported) void webdavBridge.summary().then(value => { if (active) setSummary(value); })
        .catch(() => { if (active) setError(translate("无法读取 WebDAV 配置。")); });
    };
    const updateStatus = () => {
      try {
        const value = JSON.parse(localStorage.getItem(WEBDAV_SYNC_STATUS) ?? "null") as { state: string; error?: string } | null;
        if (active) setSync(value ?? undefined);
      } catch { /* Status is optional and never contains credentials. */ }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === WEBDAV_CONFIG_EVENT) { setDraft(undefined); load(); }
      if (event.key === WEBDAV_SYNC_STATUS) updateStatus();
    };
    load(); updateStatus();
    window.addEventListener("storage", onStorage);
    window.addEventListener(WEBDAV_SYNC_STATUS, updateStatus);
    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(WEBDAV_SYNC_STATUS, updateStatus);
    };
  }, [supported]);

  const exportBackup = async () => {
    setError(""); setMessage(""); setPending(true);
    try {
      const body = encodeSettingsBackup(currentSettingsBackup());
      if (supported) {
        if (await invoke<boolean>("notgram_export_settings_backup", { body })) setMessage(translate("设置备份已导出。"));
      } else {
        const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "notgram-settings.txt";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(translate("设置备份已导出。"));
      }
    } catch { setError(translate("无法导出设置备份。")); }
    finally { setPending(false); }
  };

  const importBackup = async (file: File) => {
    setError(""); setMessage(""); setPending(true);
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error();
      restoreSettingsBackup(await file.text());
      setMessage(translate("设置备份已导入。"));
    } catch { setError(translate("无效的备份文件")); }
    finally { setPending(false); if (fileInput.current) fileInput.current.value = ""; }
  };

  const editWebDav = async (enable = false) => {
    setError(""); setPending(true);
    try {
      const config = await webdavBridge.edit();
      setDraft({ ...config, enabled: enable || config.enabled });
    }
    catch { setError(translate("无法读取 WebDAV 配置。")); }
    finally { setPending(false); }
  };

  const updateConfig = (value: WebDavSummary) => {
    setSummary(value);
    setSync(undefined);
    localStorage.setItem(WEBDAV_CONFIG_EVENT, `${Date.now()}:${Math.random()}`);
    window.dispatchEvent(new Event(WEBDAV_CONFIG_EVENT));
  };

  const toggleWebDav = async (enabled: boolean) => {
    if (draft) { setDraft({ ...draft, enabled }); return; }
    if (enabled && !summary?.url) { await editWebDav(true); return; }
    setError(""); setMessage(""); setPending(true);
    try { updateConfig(await webdavBridge.setEnabled(enabled)); }
    catch { setError(translate("无法更改 WebDAV 同步状态。")); }
    finally { setPending(false); }
  };

  const saveWebDav = async () => {
    if (!draft) return;
    setError(""); setMessage(""); setPending(true);
    try {
      updateConfig(await webdavBridge.save(draft));
      setDraft(undefined);
      setMessage(translate("WebDAV 配置已保存。"));
    } catch { setError(translate("WebDAV 配置无效")); }
    finally { setPending(false); }
  };

  return (
    <section className="settings-section backup-settings" aria-labelledby="backup-settings-heading">
      <div className="settings-section-heading">
        <ArchiveRestore size={18} strokeWidth={1.8} />
        <div>
          <h4 id="backup-settings-heading">{translate("备份与恢复")}</h4>
          <span>{translate("备份、恢复和同步基础设置")}</span>
        </div>
      </div>
      <div className="backup-local">
        <strong>{translate("本地备份")}</strong>
        <div className="backup-actions">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={() => fileInput.current?.click()}><Upload size={14} />{translate("导入设置")}</button>
          <button className="dialog-save" type="button" disabled={pending} onClick={() => void exportBackup()}><Download size={14} />{translate("导出设置")}</button>
        </div>
        <input ref={fileInput} type="file" hidden accept=".txt,text/plain" aria-label={translate("选择设置备份文件")}
          onChange={event => { const file = event.target.files?.[0]; if (file) void importBackup(file); }} />
      </div>
      <div className="backup-webdav">
      <div className="backup-webdav-heading">
        <div className="backup-webdav-title"><Cloud size={16} /><strong>WebDAV</strong>
          {!draft && <span className={`backup-sync-state ${summary?.enabled && sync?.state === "error" ? "is-error" : summary?.enabled && sync?.state === "synced" ? "is-synced" : ""}`} role="status">
            {summary?.enabled && sync?.state === "syncing" && <LoaderCircle size={11} className="spin" />}
            {summary?.enabled ? sync ? syncMessage(sync.state, sync.error) : translate("已启用") : translate("未启用")}
          </span>}
        </div>
        <div className="backup-webdav-controls">
          <label className="preference-row">
            <span>{translate("自动同步")}</span>
            <input type="checkbox" role="switch" aria-label={translate("WebDAV 自动同步")} checked={draft?.enabled ?? summary?.enabled ?? false} disabled={pending || !supported || !summary} onChange={event => void toggleWebDav(event.target.checked)} />
          </label>
          {!draft && <button className="backup-edit-button" type="button" aria-label={translate("编辑 WebDAV")} disabled={pending || !supported || !summary} onClick={() => void editWebDav()}><Pencil size={13} />{translate("编辑")}</button>}
        </div>
      </div>
      {draft ? (
        <div className="backup-webdav-form" onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
            event.preventDefault(); event.stopPropagation();
            if (!pending) void saveWebDav();
          }
        }}>
          <label className="auth-field backup-url-field"><span>{translate("目录地址")}</span><input aria-label={translate("WebDAV 目录地址")} type="url" value={draft.url} maxLength={4096} placeholder="https://example.com/dav/" disabled={pending} required={draft.enabled} autoComplete="off" onChange={event => setDraft({ ...draft, url: event.target.value })} /></label>
          <label className="auth-field"><span>{translate("用户名")}</span><input aria-label={translate("WebDAV 用户名")} type="text" value={draft.username} maxLength={1024} autoComplete="off" spellCheck={false} disabled={pending} onChange={event => setDraft({ ...draft, username: event.target.value })} /></label>
          <label className="auth-field"><span>{translate("密码")}</span><input aria-label={translate("WebDAV 密码")} type="password" value={draft.password} maxLength={4096} autoComplete="new-password" disabled={pending} onChange={event => setDraft({ ...draft, password: event.target.value })} /></label>
          <div className="backup-actions"><button className="dialog-secondary" type="button" disabled={pending} onClick={() => setDraft(undefined)}>{translate("取消")}</button><button className="dialog-save" type="button" disabled={pending} aria-label={translate("保存 WebDAV")} onClick={() => void saveWebDav()}>{translate("保存")}</button></div>
        </div>
      ) : summary && (
        <dl className="backup-webdav-summary">
          <div className="backup-url-field"><dt>{translate("目录地址")}</dt><dd>{summary.url || translate("未设置")}</dd></div>
          <div><dt>{translate("用户名")}</dt><dd>{summary.hasUsername ? "••••••••" : translate("未设置")}</dd></div>
          <div><dt>{translate("密码")}</dt><dd>{summary.hasPassword ? "••••••••" : translate("未设置")}</dd></div>
        </dl>
      )}
      </div>
      {message && <p className="backup-feedback" role="status"><Check size={13} />{message}</p>}
      {error && <div className="settings-error" role="alert">{error}</div>}
    </section>
  );
}
