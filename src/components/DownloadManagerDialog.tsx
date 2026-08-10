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
  pending: "等待下载",
  downloading: "下载中",
  completed: "已完成",
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
  const [filter, setFilter] = useState<DownloadFilter>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<ReadonlySet<number>>(() => new Set());
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const filteredItems = useMemo(() => items.filter((item) =>
    filter === "all" ||
    (filter === "completed" ? item.status === "completed" : item.status !== "completed"),
  ), [filter, items]);
  const activeCount = items.filter((item) => item.status === "downloading").length;
  const selectedItems = filteredItems.filter((item) => selectedFileIds.has(item.fileId));
  const startableItems = selectedItems.filter((item) => item.status === "pending");
  const cancellableItems = selectedItems.filter((item) => item.status === "downloading");
  const removableItems = selectedItems.filter((item) => item.status !== "downloading");
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
              <h2 id="download-manager-title">下载</h2>
              <small>{activeCount > 0 ? `${activeCount} 项进行中` : `${items.length} 项`}</small>
            </span>
          </span>
          <button className="icon-button" type="button" aria-label="关闭下载管理" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <nav className="download-manager-tabs" aria-label="下载筛选">
          {(["all", "active", "completed"] as const).map((value) => (
            <button
              type="button"
              className={filter === value ? "is-active" : ""}
              aria-pressed={filter === value}
              key={value}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? "全部" : value === "active" ? "进行中" : "已完成"}
            </button>
          ))}
        </nav>

        <div className="download-manager-batch" aria-label="批量管理">
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
            <span>{selectedItems.length > 0 ? `已选 ${selectedItems.length} 项` : "全选"}</span>
          </label>
          <span className="download-batch-actions">
            <button type="button" aria-label="开始" title="开始选中下载" disabled={startableItems.length === 0} onClick={() => void Promise.allSettled(startableItems.map((item) => onDownload(item.fileId, item.fileName)))}>
              <Download size={14} /><span>开始</span>
            </button>
            <button type="button" aria-label="取消" title="取消选中下载" disabled={cancellableItems.length === 0} onClick={() => void Promise.allSettled(cancellableItems.map((item) => onCancel(item.fileId)))}>
              <X size={14} /><span>取消</span>
            </button>
            <button type="button" aria-label="移除" title="移除选中记录" disabled={removableItems.length === 0} onClick={() => removeRecords(removableItems)}>
              <Trash2 size={14} /><span>移除</span>
            </button>
            <button type="button" aria-label="清除已完成" title="清除已完成记录" disabled={completedItems.length === 0} onClick={() => removeRecords(completedItems)}>
              <Trash2 size={14} /><span>清除已完成</span>
            </button>
          </span>
        </div>

        <section className="download-manager-list" aria-live="polite">
          {filteredItems.length === 0 ? (
            <div className="download-manager-empty">
              <Download size={28} strokeWidth={1.5} />
              <span>暂无下载</span>
            </div>
          ) : filteredItems.map((item) => (
            <article className="download-manager-item" key={item.fileId}>
              <input
                className="download-item-select"
                type="checkbox"
                aria-label={`选择 ${item.fileName}`}
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
                <strong title={item.fileName}>{item.fileName}</strong>
                <small>{item.chatTitle} · {formatDownloadSize(item.size)}</small>
                <span className="download-progress-track" role="progressbar" aria-label={`${item.fileName} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                  <span style={{ width: `${item.progress * 100}%` }} />
                </span>
                <span className="download-item-status">
                  <small>{statusLabel[item.status]}</small>
                  <small>{Math.round(item.progress * 100)}%</small>
                </span>
              </span>
              <span className="download-item-action">
                {item.status === "downloading" ? (
                  <button type="button" aria-label={`取消下载 ${item.fileName}`} title="取消下载" onClick={() => void onCancel(item.fileId)}><X size={17} /></button>
                ) : item.status === "pending" ? (
                  <button type="button" aria-label={`下载 ${item.fileName}`} title="开始下载" onClick={() => void onDownload(item.fileId, item.fileName)}><Download size={17} /></button>
                ) : (
                  <button type="button" aria-label={`在下载目录中查看 ${item.fileName}`} title="打开下载目录" onClick={() => void onOpenDirectory()}><FolderOpen size={17} /></button>
                )}
              </span>
            </article>
          ))}
        </section>

        <footer className="download-manager-footer">
          <span>{filteredItems.length} 项</span>
          <button type="button" onClick={() => void onOpenDirectory()}>
            <FolderOpen size={16} />
            <span>打开下载目录</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
