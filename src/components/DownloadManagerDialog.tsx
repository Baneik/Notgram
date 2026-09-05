import { invoke, isTauri } from "@tauri-apps/api/core";
import { flushAccountMetadata } from "../store/accountMetadata";
import { translate } from "../i18n";
import {
  AudioLines,
  Download,
  FileText,
  FolderOpen,
  Mic2,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import {
  formatDownloadSize,
  type ManagedDownloadItem,
  type ManagedDownloadStatus,
} from "../utils/downloadManager";

interface DownloadManagerDialogProps {
  items: ManagedDownloadItem[];
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onCancel: (fileId: number) => Promise<void>;
  onRemove: (fileIds: number[]) => void;
  onOpenDirectory: () => Promise<void>;
  onClose: () => void;
}

type DownloadFilter = "all" | "active" | "completed";

const statusLabel: Record<ManagedDownloadStatus, string> = {
  get pending() { return translate("等待下载"); },
  get downloading() { return translate("下载中"); },
  get saving() { return translate("保存中"); },
  get completed() { return translate("已完成"); },
  get failed() { return translate("失败"); },
  get cancelled() { return translate("已取消"); },
};

const DownloadKindIcon = ({ item }: { item: ManagedDownloadItem }) => {
  if (item.kind === "video") return <Video size={20} strokeWidth={1.8} />;
  if (item.kind === "audio") return <AudioLines size={20} strokeWidth={1.8} />;
  if (item.kind === "voice") return <Mic2 size={20} strokeWidth={1.8} />;
  return <FileText size={20} strokeWidth={1.8} />;
};

export function DownloadManagerDialog({
  items,
  onDownload,
  onCancel,
  onRemove,
  onOpenDirectory,
  onClose,
}: DownloadManagerDialogProps) {
  const [locationError, setLocationError] = useState<string>();
  const locate = async (item: ManagedDownloadItem) => {
    try {
      setLocationError(undefined);
      if (isTauri() && item.savedPath) {
        await flushAccountMetadata();
        await invoke("telegram_locate_download", { fileId: item.fileId });
      } else await onOpenDirectory();
    } catch { setLocationError(translate("文件已移动、删除或保存位置不可用")); }
  };
  const [filter, setFilter] = useState<DownloadFilter>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<ReadonlySet<number>>(() => new Set());
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const filteredItems = useMemo(() => items.filter((item) =>
    filter === "all" ||
    (filter === "completed"
      ? item.status === "completed"
      : item.status === "pending" || item.status === "downloading" || item.status === "saving"),
  ), [filter, items]);
  const activeCount = items.filter((item) => item.status === "downloading" || item.status === "saving").length;
  const selectedItems = filteredItems.filter((item) => selectedFileIds.has(item.fileId));
  const startableItems = selectedItems.filter((item) => item.status === "pending" || item.status === "failed" || item.status === "cancelled");
  const cancellableItems = selectedItems.filter((item) => item.status === "downloading");
  const removableItems = selectedItems.filter((item) => item.status !== "downloading" && item.status !== "saving");
  const completedItems = items.filter((item) => item.status === "completed");
  const allFilteredSelected = filteredItems.length > 0 &&
    filteredItems.every((item) => selectedFileIds.has(item.fileId));

  useEffect(() => {
    const available = new Set(items.map((item) => item.fileId));
    setSelectedFileIds((current) => {
      const next = new Set([...current].filter((fileId) => available.has(fileId)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const removeRecords = (records: ManagedDownloadItem[]) => {
    if (records.length === 0) return;
    const fileIds = records.map((item) => item.fileId);
    onRemove(fileIds);
    setSelectedFileIds((current) => {
      const next = new Set(current);
      for (const fileId of fileIds) next.delete(fileId);
      return next;
    });
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onWheel={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="download-manager-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-manager-title"
        tabIndex={-1}
      >
        <header className="settings-dialog-header">
          <span className="download-manager-heading">
            <Download size={20} strokeWidth={1.9} />
            <span>
              <h2 id="download-manager-title">{translate("下载")}</h2>
              <small>{activeCount > 0 ? translate("{{value0}} 项进行中", { value0: activeCount }) : translate("{{value0}} 项", { value0: items.length })}</small>
            </span>
          </span>
          <button className="icon-button" type="button" aria-label={translate("关闭下载管理")} title={translate("关闭")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <nav className="download-manager-tabs" aria-label={translate("下载筛选")}>
          {(["all", "active", "completed"] as const).map((value) => (
            <button
              type="button"
              className={filter === value ? "is-active" : ""}
              aria-pressed={filter === value}
              key={value}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? translate("全部") : value === "active" ? translate("进行中") : translate("已完成")}
            </button>
          ))}
        </nav>

        <div className="download-manager-batch" aria-label={translate("批量管理")}>
          <label>
            <input
              type="checkbox"
              checked={allFilteredSelected}
              disabled={filteredItems.length === 0}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelectedFileIds((current) => {
                  const next = new Set(current);
                  for (const item of filteredItems) {
                    if (checked) next.add(item.fileId);
                    else next.delete(item.fileId);
                  }
                  return next;
                });
              }}
            />
            <span>{selectedItems.length > 0 ? translate("已选 {{value0}} 项", { value0: selectedItems.length }) : translate("全选")}</span>
          </label>
          <span className="download-batch-actions">
            <button type="button" aria-label={translate("开始")} title={translate("开始选中下载")} disabled={startableItems.length === 0} onClick={() => void Promise.allSettled(startableItems.map((item) => onDownload(item.fileId, item.fileName)))}>
              <Download size={14} /><span>{translate("开始")}</span>
            </button>
            <button type="button" aria-label={translate("取消")} title={translate("取消选中下载")} disabled={cancellableItems.length === 0} onClick={() => void Promise.allSettled(cancellableItems.map((item) => onCancel(item.fileId)))}>
              <X size={14} /><span>{translate("取消")}</span>
            </button>
            <button type="button" aria-label={translate("移除")} title={translate("移除选中记录")} disabled={removableItems.length === 0} onClick={() => removeRecords(removableItems)}>
              <Trash2 size={14} /><span>{translate("移除")}</span>
            </button>
            <button type="button" aria-label={translate("清除已完成")} title={translate("清除已完成记录")} disabled={completedItems.length === 0} onClick={() => removeRecords(completedItems)}>
              <Trash2 size={14} /><span>{translate("清除已完成")}</span>
            </button>
          </span>
        </div>

        <section className="download-manager-list" aria-live="polite">
          {filteredItems.length === 0 ? (
            <div className="download-manager-empty">
              <Download size={28} strokeWidth={1.5} />
              <span>{translate("暂无下载")}</span>
            </div>
          ) : filteredItems.map((item) => (
            <article className="download-manager-item" key={item.fileId}>
              <input
                className="download-item-select"
                type="checkbox"
                aria-label={translate("选择 {{value0}}", { value0: item.fileName })}
                checked={selectedFileIds.has(item.fileId)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelectedFileIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(item.fileId);
                    else next.delete(item.fileId);
                    return next;
                  });
                }}
              />
              <span className={`download-kind-icon kind-${item.kind}`}><DownloadKindIcon item={item} /></span>
              <span className="download-item-copy">
                <strong title={item.savedPath ?? item.fileName}>{item.fileName}</strong>
                <small>{item.chatTitle} · {formatDownloadSize(item.size)}</small>
                <span className="download-progress-track" role="progressbar" aria-label={translate("{{value0}} 下载进度", { value0: item.fileName })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                  <span style={{ width: `${item.progress * 100}%` }} />
                </span>
                <span className="download-item-status">
                  <small title={item.error}>{item.error || statusLabel[item.status]}</small>
                  <small>{Math.round(item.progress * 100)}%</small>
                </span>
              </span>
              <span className="download-item-action">
                {item.status === "downloading" ? (
                  <button type="button" aria-label={translate("取消下载 {{value0}}", { value0: item.fileName })} title={translate("取消下载")} onClick={() => void onCancel(item.fileId)}><X size={17} /></button>
                ) : item.status === "pending" || item.status === "failed" || item.status === "cancelled" ? (
                  <button type="button" aria-label={translate("下载 {{value0}}", { value0: item.fileName })} title={translate("开始下载")} onClick={() => void onDownload(item.fileId, item.fileName)}><Download size={17} /></button>
                ) : (
                  <button type="button" aria-label={translate("在下载目录中查看 {{value0}}", { value0: item.fileName })} title={translate("打开下载目录")} onClick={() => void locate(item)}><FolderOpen size={17} /></button>
                )}
              </span>
            </article>
          ))}
        </section>

        {locationError && <p role="alert">{locationError}</p>}
        <footer className="download-manager-footer">
          <span>{translate("{{value0}} 项", { value0: filteredItems.length })}</span>
          <button type="button" onClick={() => void onOpenDirectory()}>
            <FolderOpen size={16} />
            <span>{translate("打开下载目录")}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
