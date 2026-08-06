import type { OutgoingAttachment, QueuedOutgoingAttachment } from "../telegram/types";

const DATABASE_NAME = "notgram-attachment-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "batches";
const MAX_BATCH_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BATCHES = 50;
const EXPIRED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredFile {
  storageId: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  fingerprint: string;
  blob: Blob;
}

interface StoredBatch {
  version: 1;
  id: string;
  createdAt: string;
  metadata: QueuedOutgoingAttachment[];
  files: StoredFile[];
}

interface AttachmentBatchInput {
  id: string;
  createdAt: string;
  attachments: OutgoingAttachment[];
  metadata: QueuedOutgoingAttachment[];
}

interface AttachmentBatch {
  attachments: OutgoingAttachment[];
  metadata: QueuedOutgoingAttachment[];
}

const memoryBatches = new Map<string, StoredBatch>();

const hasIndexedDb = () => typeof globalThis.indexedDB !== "undefined";

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("无法打开附件发件箱"));
});

const totalBytes = (batch: StoredBatch) => batch.files.reduce((sum, file) => sum + file.size, 0);

const deleteExpiredMemoryBatches = () => {
  const cutoff = Date.now() - EXPIRED_AFTER_MS;
  for (const [id, batch] of memoryBatches) {
    if (Date.parse(batch.createdAt) < cutoff) memoryBatches.delete(id);
  }
};

const fingerprint = async (file: File) => {
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
  }
};

export const fingerprintOutgoingFile = fingerprint;

export const describeOutgoingAttachments = async (
  batchId: string,
  attachments: OutgoingAttachment[],
): Promise<QueuedOutgoingAttachment[]> => Promise.all(attachments.map(async (attachment, index) => ({
  storageId: `${batchId}:${index}`,
  name: attachment.file.name,
  mimeType: attachment.file.type || "application/octet-stream",
  size: attachment.file.size,
  lastModified: attachment.file.lastModified,
  fingerprint: await fingerprint(attachment.file),
  kind: attachment.kind,
  width: attachment.width,
  height: attachment.height,
  duration: attachment.duration,
  title: attachment.title,
  performer: attachment.performer,
  thumbnailStorageId: attachment.thumbnail ? `${batchId}:${index}:thumbnail` : undefined,
  hasSpoiler: attachment.hasSpoiler,
  showCaptionAboveMedia: attachment.showCaptionAboveMedia,
})));

const cloneStoredBatch = (batch: StoredBatch): StoredBatch => ({
  ...batch,
  metadata: batch.metadata.map((value) => ({ ...value })),
  files: batch.files.map((file) => ({ ...file })),
});

const readAllIndexedDb = async (database: IDBDatabase) => new Promise<StoredBatch[]>((resolve, reject) => {
  const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
  request.onsuccess = () => resolve((request.result as StoredBatch[]).map(cloneStoredBatch));
  request.onerror = () => reject(request.error ?? new Error("无法读取附件发件箱"));
});

const putIndexedDb = async (database: IDBDatabase, batch: StoredBatch) => new Promise<void>((resolve, reject) => {
  const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(batch);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error ?? new Error("无法保存附件发件箱"));
});

const getIndexedDb = async (database: IDBDatabase, id: string) => new Promise<StoredBatch | undefined>((resolve, reject) => {
  const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
  request.onsuccess = () => resolve(request.result ? cloneStoredBatch(request.result as StoredBatch) : undefined);
  request.onerror = () => reject(request.error ?? new Error("无法读取附件发件箱"));
});

const deleteIndexedDb = async (database: IDBDatabase, id: string) => new Promise<void>((resolve, reject) => {
  const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error ?? new Error("无法清理附件发件箱"));
});

const purgeIndexedDb = async (database: IDBDatabase) => {
  const batches = await readAllIndexedDb(database);
  const cutoff = Date.now() - EXPIRED_AFTER_MS;
  const expired = batches.filter((batch) => Date.parse(batch.createdAt) < cutoff);
  await Promise.all(expired.map((batch) => deleteIndexedDb(database, batch.id)));
  return batches.filter((batch) => Date.parse(batch.createdAt) >= cutoff);
};

export class AttachmentOutboxStore {
  async put(input: AttachmentBatchInput) {
    const files: StoredFile[] = [];
    for (const [index, attachment] of input.attachments.entries()) {
      const metadata = input.metadata[index];
      files.push({
        storageId: metadata.storageId,
        name: attachment.file.name,
        mimeType: attachment.file.type || "application/octet-stream",
        size: attachment.file.size,
        lastModified: attachment.file.lastModified,
        fingerprint: metadata.fingerprint,
        blob: attachment.file,
      });
      if (attachment.thumbnail && metadata.thumbnailStorageId) {
        files.push({
          storageId: metadata.thumbnailStorageId,
          name: attachment.thumbnail.name,
          mimeType: attachment.thumbnail.type || "application/octet-stream",
          size: attachment.thumbnail.size,
          lastModified: attachment.thumbnail.lastModified,
          fingerprint: await fingerprint(attachment.thumbnail),
          blob: attachment.thumbnail,
        });
      }
    }
    const batch: StoredBatch = {
      version: 1,
      id: input.id,
      createdAt: input.createdAt,
      metadata: input.metadata.map((value) => ({ ...value })),
      files,
    };
    const bytes = totalBytes(batch);
    if (bytes > MAX_BATCH_BYTES) throw new Error("附件总大小超过离线发件箱单批次上限 512 MB");

    if (!hasIndexedDb()) {
      deleteExpiredMemoryBatches();
      const existing = [...memoryBatches.values()].filter((value) => value.id !== input.id);
      if (existing.length >= MAX_BATCHES) throw new Error("离线发件箱最多保留 50 批附件");
      if (existing.reduce((sum, value) => sum + totalBytes(value), 0) + bytes > MAX_TOTAL_BYTES) {
        throw new Error("离线发件箱已达到磁盘配额，请先发送或删除旧附件");
      }
      memoryBatches.set(input.id, batch);
      return;
    }

    const database = await openDatabase();
    const active = await purgeIndexedDb(database);
    const existing = active.filter((value) => value.id !== input.id);
    if (existing.length >= MAX_BATCHES) throw new Error("离线发件箱最多保留 50 批附件");
    if (existing.reduce((sum, value) => sum + totalBytes(value), 0) + bytes > MAX_TOTAL_BYTES) {
      throw new Error("离线发件箱已达到磁盘配额，请先发送或删除旧附件");
    }
    await putIndexedDb(database, batch);
    database.close();
  }

  async get(id: string): Promise<AttachmentBatch | undefined> {
    const batch = hasIndexedDb()
      ? await openDatabase().then(async (database) => {
          const result = await getIndexedDb(database, id);
          database.close();
          return result;
        })
      : (deleteExpiredMemoryBatches(), memoryBatches.get(id));
    if (!batch || batch.version !== 1) return undefined;
    const byStorageId = new Map(batch.files.map((file) => [file.storageId, file]));
    const attachments: OutgoingAttachment[] = [];
    for (const item of batch.metadata) {
      const source = byStorageId.get(item.storageId);
      if (
        !source ||
        source.size !== item.size ||
        source.lastModified !== item.lastModified ||
        source.fingerprint !== item.fingerprint
      ) return undefined;
      const match = source.storageId;
      const fileObject = new File([source.blob], source.name, {
        type: source.mimeType,
        lastModified: source.lastModified,
      });
      const thumbnail = item.thumbnailStorageId
        ? byStorageId.get(item.thumbnailStorageId)
        : undefined;
      attachments.push({
        file: fileObject,
        kind: item.kind,
        width: item.width,
        height: item.height,
        duration: item.duration,
        title: item.title,
        performer: item.performer,
        thumbnail: thumbnail
          ? new File([thumbnail.blob], thumbnail.name, {
              type: thumbnail.mimeType,
              lastModified: thumbnail.lastModified,
            })
          : undefined,
        hasSpoiler: item.hasSpoiler,
        showCaptionAboveMedia: item.showCaptionAboveMedia,
      });
    }
    return { attachments, metadata: batch.metadata.map((value) => ({ ...value })) };
  }

  async remove(id: string) {
    if (!hasIndexedDb()) {
      memoryBatches.delete(id);
      return;
    }
    const database = await openDatabase();
    await deleteIndexedDb(database, id);
    database.close();
  }
}

export const attachmentOutbox = new AttachmentOutboxStore();
