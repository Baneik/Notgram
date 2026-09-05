import { formatDownloadSize as bytes } from "../utils/downloadManager";
import { requestAttachmentRecovery } from "../store/attachmentRecovery";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { translate } from "../i18n";
import { attachmentOutbox } from "../store/attachmentOutbox";
import { useTelegramStore } from "../store/telegramStore";
import type { StorageSettings } from "../telegram/types";

interface Layer { kind: string; path: string; bytes: number; files: number; partial: boolean }
type Batch = Awaited<ReturnType<typeof attachmentOutbox.list>>[number];


export function StorageDataPanel({ settings, setSettings }: {
  settings: StorageSettings;
  setSettings: Dispatch<SetStateAction<StorageSettings>>;
}) {
  const accountId = useTelegramStore((state) => state.activeAccountId);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!isTauri() || !accountId) return;
    let disposed = false;
    setBusy(true);
    void Promise.all([
      invoke<Layer[]>("telegram_storage_inventory"), attachmentOutbox.list(accountId),
    ]).then(([usage, items]) => {
      if (!disposed) { setLayers(usage); setBatches(items); setError(undefined); }
    }).catch((cause) => { if (!disposed) setError(String(cause)); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [accountId, revision]);

  if (!isTauri()) return null;
  const labels: Record<string, string> = {
    database: translate("当前账号数据库"), media: translate("媒体缓存"),
    staging: translate("发送暂存文件"), snapshot: translate("界面快照与备份"),
    unsent: translate("本地草稿与附件"), shared: translate("共享配置与账号元数据"),
    webview: translate("浏览器缓存"), downloads: translate("下载副本"),
    logs: translate("运行日志"), diagnostics: translate("诊断数据"),
    otherAccounts: translate("其他账号缓存"), otherUnsent: translate("其他账号草稿"),
    otherDatabases: translate("其他账号数据库"),
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await operation(); setRevision((value) => value + 1); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const recover = async (batch: Batch) => {
    await requestAttachmentRecovery(accountId, batch.id);
    setNotice(translate("附件已恢复到原会话草稿，请核对后发送"));
  };

  return <section className="settings-section storage-data-panel" aria-label={translate("本地数据管理")}>
    <h4>{translate("本地数据管理")}</h4>
    <p>{translate("本次运行缓存路径：")} {settings.effectiveCachePath ?? settings.cachePath}</p>
    <p>{translate("草稿、附件和账号元数据使用 Windows 用户加密；媒体缓存、下载副本和日志不属于加密存储。")}</p>
    <button type="button" className="storage-reset" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{translate("刷新")}</button>
    <div className="cache-category-list">
      {layers.map((layer) => <div key={layer.kind} title={layer.path} className="cache-category-row">
        <span>{labels[layer.kind] ?? layer.kind}</span>
        <small>{bytes(layer.bytes)} · {layer.files}{layer.partial ? ` · ${translate("统计不完整")}` : ""}</small>
      </div>)}
    </div>
    <p>{translate("下载副本由你保管，清理缓存和退出账号都不会删除。")}</p>
    {(settings.migrationBackups ?? []).map((backup) => <div key={backup.id} className="auth-field">
      <span>{translate("迁移备份")} · {bytes(backup.bytes)}</span><small>{backup.path}</small>
      <button className="dialog-secondary" type="button" disabled={busy} onClick={() => void run(async () => {
        await invoke("telegram_remove_migration_backup", { id: backup.id });
        const next = await invoke<StorageSettings>("telegram_storage_settings");
        setSettings((current) => ({ ...current, migrationBackups: next.migrationBackups, effectiveCachePath: next.effectiveCachePath }));
      })}>{translate("回收已验证的迁移备份")}</button>
    </div>)}
    <h4>{translate("附件恢复")}</h4>
    <p>{translate("以下文件保留于本机。正在使用的批次需先在会话中发送或删除；未关联的批次可以恢复。")}</p>
    {batches.map((batch) => <div key={batch.id} className="auth-field">
      <span>{batch.metadata.map((item) => item.name).join(", ")} · {bytes(batch.bytes)}</span>
      <small>{new Date(batch.createdAt).toLocaleString()} · {batch.referenced ? translate("草稿或恢复备份正在使用") : translate("可恢复")}</small>
      <div className="settings-inline-actions">
        <button type="button" className="dialog-secondary" disabled={busy || batch.referenced} onClick={() => void run(() => recover(batch))}>{translate("恢复为草稿")}</button>
        <button type="button" className="dialog-secondary" disabled={busy || batch.referenced} onClick={() => void run(() => attachmentOutbox.remove(batch.id, accountId))}>{translate("删除")}</button>
      </div>
    </div>)}
    {busy && <p role="status">{translate("正在统计")}</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
