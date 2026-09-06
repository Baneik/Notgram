import { ArrowLeft, RotateCcw } from "lucide-react";
import { formatDownloadSize } from "../utils/downloadManager";
import { requestAttachmentRecovery } from "../store/attachmentRecovery";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { translate } from "../i18n";
import { attachmentOutbox } from "../store/attachmentOutbox";
import { useTelegramStore } from "../store/telegramStore";
import type { StorageSettings } from "../telegram/types";

interface Layer { kind: string; path: string; bytes: number; files: number; partial: boolean }
type Batch = Awaited<ReturnType<typeof attachmentOutbox.list>>[number];

const bytes = (value: number) => value === 0 ? "0 B" : formatDownloadSize(value);

export function StorageDataPanel({ settings, setSettings, onClose }: {
  onClose: () => void;
  settings: StorageSettings;
  setSettings: Dispatch<SetStateAction<StorageSettings>>;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);
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

  const cachePath = settings.effectiveCachePath ?? settings.cachePath;
  const backups = settings.migrationBackups ?? [];
  const measuredBytes = layers.reduce((sum, layer) => sum + layer.bytes, 0);
  const measuredFiles = layers.reduce((sum, layer) => sum + layer.files, 0);
  const partialLayers = layers.filter((layer) => layer.partial).length;
  return (
    <section className="storage-details-overlay" aria-labelledby="storage-details-title">
      <header className="settings-detail-header">
        <button ref={backRef} type="button" className="icon-button" aria-label={translate("返回")} onClick={onClose}>
          <ArrowLeft size={19} />
        </button>
        <h3 id="storage-details-title">{translate("存储详情")}</h3>
        <button type="button" className="storage-reset" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
          <RotateCcw size={15} />
          {translate("刷新")}
        </button>
      </header>
      <div className="settings-detail-scroll">
        <section className="settings-section storage-data-panel" aria-label={translate("存储占用")}>
          <dl className="storage-current-path">
            <dt>{translate("当前缓存路径")}</dt>
            <dd title={cachePath}>{cachePath}</dd>
          </dl>
          <div className="storage-usage-summary" aria-live="polite">
            <div><strong>{bytes(measuredBytes)}</strong><span>{translate("已测总占用")}</span></div>
            <div><strong>{measuredFiles.toLocaleString()}</strong><span>{translate("已测文件数")}</span></div>
            {partialLayers > 0 && <div><strong>{partialLayers}</strong><span>{translate("统计不完整")}</span></div>}
          </div>
          <div className="storage-table-frame" aria-busy={busy}>
            <table className="storage-usage-table" aria-label={translate("存储占用")}>
              <thead><tr>
                <th scope="col">{translate("数据类型")}</th>
                <th scope="col">{translate("占用空间")}</th>
                <th scope="col">{translate("文件数量")}</th>
              </tr></thead>
              <tbody>
                {layers.map((layer) => (
                  <tr key={layer.kind}>
                    <th scope="row" title={layer.path}>
                      {labels[layer.kind] ?? layer.kind}
                      {layer.partial && <small className="storage-partial">{translate("统计不完整")}</small>}
                    </th>
                    <td>{bytes(layer.bytes)}</td>
                    <td>{layer.files.toLocaleString()}</td>
                  </tr>
                ))}
                {layers.length === 0 && <tr><td colSpan={3} className="storage-table-empty">
                  {busy ? translate("正在统计") : error ? translate("统计失败") : translate("暂无数据")}
                </td></tr>}
              </tbody>
            </table>
          </div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          {notice && <div className="cache-cleanup-result" role="status">{notice}</div>}
        </section>
        {backups.length > 0 && (
          <section className="settings-section storage-data-panel" aria-labelledby="storage-backups-title">
            <div className="settings-section-heading"><h4 id="storage-backups-title">{translate("迁移备份")}</h4></div>
            <div className="storage-item-list">
              {backups.map((backup) => (
                <div key={backup.id} className="storage-item-row">
                  <div className="storage-item-description">
                    <span title={backup.path}>{backup.path}</span>
                    <small>{bytes(backup.bytes)}</small>
                  </div>
                  <button className="storage-reset" type="button" disabled={busy} onClick={() => void run(async () => {
                    await invoke("telegram_remove_migration_backup", { id: backup.id });
                    const next = await invoke<StorageSettings>("telegram_storage_settings");
                    setSettings((current) => ({ ...current, migrationBackups: next.migrationBackups, effectiveCachePath: next.effectiveCachePath }));
                  })}>{translate("回收备份")}</button>
                </div>
              ))}
            </div>
          </section>
        )}
        {batches.length > 0 && (
          <section className="settings-section storage-data-panel" aria-labelledby="storage-recovery-title">
            <div className="settings-section-heading"><h4 id="storage-recovery-title">{translate("附件恢复")}</h4></div>
            <div className="storage-item-list">
              {batches.map((batch) => (
                <div key={batch.id} className="storage-item-row">
                  <div className="storage-item-description">
                    <span title={batch.metadata.map((item) => item.name).join(", ")}>{batch.metadata.map((item) => item.name).join(", ")}</span>
                    <small>{bytes(batch.bytes)} · {new Date(batch.createdAt).toLocaleDateString()} · {batch.referenced ? translate("草稿使用中") : translate("可恢复")}</small>
                    {typeof batch.recovery?.chatId === "string" && <small>{translate("原会话")}: {batch.recovery.chatId}{typeof batch.recovery?.topicId === "string" ? ` · ${translate("话题")} ${batch.recovery.topicId}` : ""}</small>}
                    {typeof batch.recovery?.caption === "string" && batch.recovery.caption.trim() && <small title={batch.recovery.caption}>{translate("说明")}: {batch.recovery.caption}</small>}
                  </div>
                  <div className="settings-inline-actions">
                    <button type="button" className="storage-reset" disabled={busy || batch.referenced} onClick={() => void run(() => recover(batch))}>{translate("恢复为草稿")}</button>
                    <button type="button" className="storage-reset storage-item-delete" disabled={busy || batch.referenced} onClick={() => {
                      if (globalThis.confirm(translate("确定删除此附件恢复批次吗？"))) void run(() => attachmentOutbox.remove(batch.id, accountId));
                    }}>{translate("删除")}</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
