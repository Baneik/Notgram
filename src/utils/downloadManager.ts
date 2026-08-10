import type { Chat, Message } from "../telegram/types";

export type ManagedDownloadKind = "video" | "file" | "audio" | "voice";
export type ManagedDownloadStatus = "pending" | "downloading" | "completed";

export interface ManagedDownloadRequest {
  accountId: string;
  fileId: number;
  fileName: string;
  requestedAt: string;
}

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
  requestedAt: string;
}

const statusRank: Record<ManagedDownloadStatus, number> = {
  downloading: 3,
  pending: 2,
  completed: 1,
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
  requests: Iterable<ManagedDownloadRequest>,
) => {
  const requestedFiles = new Map<number, ManagedDownloadRequest>();
  for (const request of requests) requestedFiles.set(request.fileId, request);
  const downloads = new Map<number, ManagedDownloadItem>();
  for (const [chatId, chatMessages] of messages) {
    for (const message of chatMessages) {
      const content = message.content;
      const kind = downloadKind(message);
      if (
        !kind || (content.kind !== "file" && content.kind !== "media") ||
        content.fileId === undefined || content.isUploading || !requestedFiles.has(content.fileId)
      ) continue;
      const request = requestedFiles.get(content.fileId)!;
      const status: ManagedDownloadStatus = content.isDownloaded
        ? "completed"
        : content.isDownloading ? "downloading" : "pending";
      const sizeProgress = content.size && content.downloadedSize !== undefined
        ? content.downloadedSize / content.size
        : undefined;
      const progress = status === "completed"
        ? 1
        : Math.max(0, Math.min(1, sizeProgress ?? content.progress ?? 0));
      const transferredSize = Math.max(
        0,
        content.downloadedSize ?? (content.size ? Math.round(content.size * progress) : 0),
      );
      const item: ManagedDownloadItem = {
        fileId: content.fileId,
        fileName: request.fileName || content.fileName,
        chatId,
        chatTitle: chats.get(chatId)?.title ?? "未知会话",
        messageId: message.id,
        sentAt: message.sentAt,
        kind,
        status,
        size: content.size,
        transferredSize,
        progress,
        requestedAt: request.requestedAt,
      };
      const current = downloads.get(item.fileId);
      if (
        !current || statusRank[item.status] > statusRank[current.status] ||
        (statusRank[item.status] === statusRank[current.status] && item.sentAt > current.sentAt)
      ) downloads.set(item.fileId, item);
    }
  }
  return [...downloads.values()].sort((left, right) =>
    statusRank[right.status] - statusRank[left.status] ||
    right.requestedAt.localeCompare(left.requestedAt),
  );
};
