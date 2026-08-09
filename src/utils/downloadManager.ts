import type { Chat, Message } from "../telegram/types";

export type ManagedDownloadKind = "video" | "file" | "audio" | "voice";
export type ManagedDownloadStatus = "pending" | "downloading" | "completed";

export interface ManagedDownloadItem {
  fileId: number;
  fileName: string;
  chatId: string;
  chatTitle: string;
  messageId: string;
  sentAt: string;
  kind: ManagedDownloadKind;
  status: ManagedDownloadStatus;
  size?: number;
  transferredSize: number;
  progress: number;
}

const statusRank: Record<ManagedDownloadStatus, number> = {
  completed: 3,
  downloading: 2,
  pending: 1,
};

const downloadKind = (message: Message): ManagedDownloadKind | undefined => {
  const content = message.content;
  if (content.kind === "file") return "file";
  if (content.kind !== "media") return undefined;
  if (content.mediaType === "video" || content.mediaType === "videoNote") return "video";
  if (content.mediaType === "audio") return "audio";
  if (content.mediaType === "voice") return "voice";
  return undefined;
};

export const formatDownloadSize = (bytes?: number) => {
  if (!Number.isFinite(bytes) || (bytes ?? 0) <= 0) return "大小未知";
  const value = bytes!;
  const unit = value < 1024 ? "B" : value < 1024 ** 2 ? "KB" : value < 1024 ** 3 ? "MB" : "GB";
  const divisor = unit === "B" ? 1 : unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3;
  const amount = value / divisor;
  return `${amount.toFixed(amount < 10 && unit !== "B" ? 1 : 0).replace(/\.0$/, "")} ${unit}`;
};

export const collectManagedDownloads = (
  messages: ReadonlyMap<string, Message[]>,
  chats: ReadonlyMap<string, Chat>,
) => {
  const downloads = new Map<number, ManagedDownloadItem>();
  for (const [chatId, chatMessages] of messages) {
    for (const message of chatMessages) {
      const content = message.content;
      const kind = downloadKind(message);
      if (
        !kind || (content.kind !== "file" && content.kind !== "media") ||
        content.fileId === undefined || content.isUploading
      ) continue;
      const status: ManagedDownloadStatus = content.isDownloaded
        ? "completed"
        : content.isDownloading ? "downloading" : "pending";
      if (status === "pending" && content.canDownload === false) continue;
      const transferredSize = Math.max(0, content.downloadedSize ?? 0);
      const progress = status === "completed"
        ? 1
        : Math.max(0, Math.min(1, content.progress ?? (content.size
          ? transferredSize / content.size
          : 0)));
      const item: ManagedDownloadItem = {
        fileId: content.fileId,
        fileName: content.fileName,
        chatId,
        chatTitle: chats.get(chatId)?.title ?? "未知会话",
        messageId: message.id,
        sentAt: message.sentAt,
        kind,
        status,
        size: content.size,
        transferredSize,
        progress,
      };
      const current = downloads.get(item.fileId);
      if (
        !current || statusRank[item.status] > statusRank[current.status] ||
        (statusRank[item.status] === statusRank[current.status] && item.sentAt > current.sentAt)
      ) downloads.set(item.fileId, item);
    }
  }
  return [...downloads.values()].sort((left, right) =>
    statusRank[right.status] - statusRank[left.status] || right.sentAt.localeCompare(left.sentAt),
  );
};
