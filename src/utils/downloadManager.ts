import type { Chat, Message } from "../telegram/types";

export type ManagedDownloadKind = "video" | "file" | "audio" | "voice";
export type ManagedDownloadStatus =
  | "pending"
  | "downloading"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled";

export interface ManagedDownloadRequest {
  accountId: string;
  fileId: number;
  fileName: string;
  requestedAt: string;
  updatedAt?: string;
  status?: ManagedDownloadStatus;
  error?: string;
  chatId?: string;
  chatTitle?: string;
  messageId?: string;
  sentAt?: string;
  kind?: ManagedDownloadKind;
  size?: number;
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
  error?: string;
}

const statusRank: Record<ManagedDownloadStatus, number> = {
  downloading: 6,
  saving: 5,
  pending: 4,
  failed: 3,
  cancelled: 2,
  completed: 1,
};

const STORAGE_KEY = "notgram:managed-downloads:v1";
const MAX_PERSISTED_DOWNLOADS = 500;

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

const requestStatus = (
  request: ManagedDownloadRequest,
  content?: Extract<Message["content"], { kind: "file" | "media" }>,
): ManagedDownloadStatus => {
  if (request.status === "completed" || request.status === "failed" || request.status === "cancelled") {
    return request.status;
  }
  if (content?.isDownloaded) return "saving";
  if (content?.isDownloading) return "downloading";
  return "pending";
};

const hasFileExtension = (value: string) => /(?:^|[\\/])?[^\\/]+\.[^\\/.]+$/.test(value.trim());

const currentDownloadFileName = (requestFileName: string, contentFileName: string) => {
  if (!requestFileName.trim()) return contentFileName;
  return !hasFileExtension(requestFileName) && hasFileExtension(contentFileName)
    ? contentFileName
    : requestFileName;
};

const messageKey = (message: Pick<Message, "chatId" | "id">) => `${message.chatId}\u0000${message.id}`;

const downloadFileId = (message: Message) => {
  const content = message.content;
  return content.kind === "file" || content.kind === "media"
    ? content.fileId
    : undefined;
};

const fallbackDownloadItem = (request: ManagedDownloadRequest): ManagedDownloadItem => {
  const status = requestStatus(request);
  return {
    fileId: request.fileId,
    fileName: request.fileName,
    chatId: request.chatId ?? "",
    chatTitle: request.chatTitle ?? "未知会话",
    messageId: request.messageId ?? "",
    sentAt: request.sentAt ?? request.requestedAt,
    kind: request.kind ?? "file",
    status,
    size: request.size,
    transferredSize: status === "completed" || status === "saving" ? request.size ?? 0 : 0,
    progress: status === "completed" || status === "saving" ? 1 : 0,
    requestedAt: request.requestedAt,
    error: request.error,
  };
};

const downloadItemFromMessage = (
  message: Message,
  chatTitle: string | undefined,
  request: ManagedDownloadRequest,
): ManagedDownloadItem | undefined => {
  const content = message.content;
  const kind = downloadKind(message);
  if (
    !kind || (content.kind !== "file" && content.kind !== "media") ||
    content.fileId !== request.fileId || content.isUploading
  ) return undefined;
  const status = requestStatus(request, content);
  const sizeProgress = content.size && content.downloadedSize !== undefined
    ? content.downloadedSize / content.size
    : undefined;
  const progress = status === "completed" || status === "saving"
    ? 1
    : Math.max(0, Math.min(status === "downloading" ? 0.99 : 1, sizeProgress ?? content.progress ?? 0));
  return {
    fileId: content.fileId,
    fileName: currentDownloadFileName(request.fileName, content.fileName),
    chatId: message.chatId,
    chatTitle: chatTitle ?? request.chatTitle ?? "未知会话",
    messageId: message.id,
    sentAt: message.sentAt,
    kind,
    status,
    size: content.size,
    transferredSize: Math.max(
      0,
      content.downloadedSize ?? (content.size ? Math.round(content.size * progress) : 0),
    ),
    progress,
    requestedAt: request.requestedAt,
    error: request.error,
  };
};

export class ManagedDownloadIndex {
  private readonly messagesByFileId = new Map<number, Map<string, Message>>();
  private readonly fileIdByMessage = new Map<string, number>();

  constructor(messages?: ReadonlyMap<string, Message[]>) {
    if (messages) this.rebuild(messages);
  }

  rebuild(messages: ReadonlyMap<string, Message[]>) {
    const previousFileIds = new Set(this.messagesByFileId.keys());
    this.messagesByFileId.clear();
    this.fileIdByMessage.clear();
    for (const chatMessages of messages.values()) this.upsert(chatMessages, previousFileIds);
    return previousFileIds;
  }

  upsert(messages: readonly Message[], changedFileIds = new Set<number>()) {
    for (const message of messages) {
      const key = messageKey(message);
      const previousFileId = this.fileIdByMessage.get(key);
      const fileId = downloadFileId(message);
      if (previousFileId !== undefined && previousFileId !== fileId) {
        this.removeCandidate(previousFileId, key);
        changedFileIds.add(previousFileId);
      }
      if (fileId === undefined) {
        this.fileIdByMessage.delete(key);
        continue;
      }
      const candidates = this.messagesByFileId.get(fileId) ?? new Map<string, Message>();
      if (candidates.get(key) !== message) changedFileIds.add(fileId);
      candidates.set(key, message);
      this.messagesByFileId.set(fileId, candidates);
      this.fileIdByMessage.set(key, fileId);
    }
    return changedFileIds;
  }

  replace(oldMessageId: string, message: Message) {
    const changedFileIds = this.remove(message.chatId, [oldMessageId]);
    return this.upsert([message], changedFileIds);
  }

  remove(chatId: string, messageIds: readonly string[]) {
    const changedFileIds = new Set<number>();
    for (const messageId of messageIds) {
      const key = `${chatId}\u0000${messageId}`;
      const fileId = this.fileIdByMessage.get(key);
      if (fileId === undefined) continue;
      this.removeCandidate(fileId, key);
      changedFileIds.add(fileId);
    }
    return changedFileIds;
  }

  createRequest(
    accountId: string,
    fileId: number,
    fileName: string,
    chats: ReadonlyMap<string, Chat>,
    existing?: ManagedDownloadRequest,
  ): ManagedDownloadRequest {
    let source: Message | undefined;
    for (const candidate of this.messagesByFileId.get(fileId)?.values() ?? []) {
      if (!source || candidate.sentAt > source.sentAt) source = candidate;
    }
    if (source) {
      const content = source.content as Extract<Message["content"], { kind: "file" | "media" }>;
      return {
        ...existing,
        accountId,
        fileId,
        fileName: fileName || content.fileName,
        requestedAt: existing?.requestedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "pending",
        error: undefined,
        chatId: source.chatId,
        chatTitle: chats.get(source.chatId)?.title ?? existing?.chatTitle ?? "未知会话",
        messageId: source.id,
        sentAt: source.sentAt,
        kind: downloadKind(source) ?? existing?.kind ?? "file",
        size: content.size ?? existing?.size,
      };
    }
    return {
      ...existing,
      accountId,
      fileId,
      fileName,
      requestedAt: existing?.requestedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "pending",
      error: undefined,
    };
  }

  collect(
    chats: ReadonlyMap<string, Chat>,
    requests: Iterable<ManagedDownloadRequest>,
  ) {
    const requestedFiles = new Map<number, ManagedDownloadRequest>();
    for (const request of requests) requestedFiles.set(request.fileId, request);
    const downloads: ManagedDownloadItem[] = [];
    for (const request of requestedFiles.values()) {
      let item: ManagedDownloadItem | undefined;
      for (const message of this.messagesByFileId.get(request.fileId)?.values() ?? []) {
        const candidate = downloadItemFromMessage(message, chats.get(message.chatId)?.title, request);
        if (
          candidate && (!item || statusRank[candidate.status] > statusRank[item.status] ||
            (statusRank[candidate.status] === statusRank[item.status] && candidate.sentAt > item.sentAt))
        ) item = candidate;
      }
      downloads.push(item ?? fallbackDownloadItem(request));
    }
    return downloads.sort((left, right) =>
      statusRank[right.status] - statusRank[left.status] ||
      right.requestedAt.localeCompare(left.requestedAt),
    );
  }

  private removeCandidate(fileId: number, key: string) {
    const candidates = this.messagesByFileId.get(fileId);
    candidates?.delete(key);
    if (candidates?.size === 0) this.messagesByFileId.delete(fileId);
    this.fileIdByMessage.delete(key);
  }
}

export const createManagedDownloadRequest = (
  accountId: string,
  fileId: number,
  fileName: string,
  messages: ReadonlyMap<string, Message[]>,
  chats: ReadonlyMap<string, Chat>,
  existing?: ManagedDownloadRequest,
): ManagedDownloadRequest => {
  return new ManagedDownloadIndex(messages).createRequest(accountId, fileId, fileName, chats, existing);
};

export const readManagedDownloadRequests = (): ReadonlyMap<string, ManagedDownloadRequest> => {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = value ? JSON.parse(value) : undefined;
    if (!Array.isArray(parsed)) return new Map();
    const records = new Map<string, ManagedDownloadRequest>();
    for (const candidate of parsed.slice(-MAX_PERSISTED_DOWNLOADS)) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as Partial<ManagedDownloadRequest>;
      if (
        typeof record.accountId !== "string" || !record.accountId ||
        !Number.isInteger(record.fileId) || (record.fileId ?? 0) <= 0 ||
        typeof record.fileName !== "string" ||
        typeof record.requestedAt !== "string"
      ) continue;
      const status = record.status === "downloading" || record.status === "saving"
        ? "pending"
        : record.status;
      const normalized = { ...record, status } as ManagedDownloadRequest;
      records.set(`${normalized.accountId}:${normalized.fileId}`, normalized);
    }
    return records;
  } catch {
    return new Map();
  }
};

export const writeManagedDownloadRequests = (records: Iterable<ManagedDownloadRequest>) => {
  try {
    const limited = [...records]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .slice(-MAX_PERSISTED_DOWNLOADS);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(limited));
  } catch {
    // Download history remains usable in memory when storage is unavailable.
  }
};

export const collectManagedDownloads = (
  messages: ReadonlyMap<string, Message[]>,
  chats: ReadonlyMap<string, Chat>,
  requests: Iterable<ManagedDownloadRequest>,
) => {
  return new ManagedDownloadIndex(messages).collect(chats, requests);
};
