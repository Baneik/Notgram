import { invoke, isTauri } from "@tauri-apps/api/core";

export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_BATCH_BYTES = 512 * 1024 * 1024;
export interface NativeBlob {
  token: string;
  size: number;
  chunks: string[];
  fingerprint: string;
}
const cached = new WeakMap<Blob, { accountId: string; value: Promise<NativeBlob> }>();

export const encodeBytes = (bytes: Uint8Array) => {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  }
  return btoa(chunks.join(""));
};

export const nativeAttachmentsAvailable = isTauri;

export const activeNativeAccount = async () =>
  (await invoke<{ activeAccountId: string }>("telegram_account_state")).activeAccountId;

export const persistNativeBlob = async (file: Blob, accountId: string): Promise<NativeBlob> => {
  if (file.size > MAX_ATTACHMENT_BATCH_BYTES) throw new Error("Attachment exceeds the 512 MiB limit");
  const existing = cached.get(file);
  if (existing?.accountId === accountId) return existing.value;
  const value = (async () => {
    const token = await invoke<string>("telegram_begin_blob", { accountId, size: file.size });
    for (let offset = 0; offset < file.size; offset += ATTACHMENT_CHUNK_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer());
      await invoke("telegram_append_blob", { accountId, token, offset, dataBase64: encodeBytes(bytes) });
    }
    return invoke<NativeBlob>("telegram_commit_blob", { accountId, token });
  })();
  cached.set(file, { accountId, value });
  try { return await value; } catch (error) { cached.delete(file); throw error; }
};

export const restoreNativeBlob = async (
  accountId: string,
  value: NativeBlob,
  name: string,
  mimeType: string,
  lastModified: number,
): Promise<File> => {
  const chunks: BlobPart[] = [];
  for (let index = 0; index < value.chunks.length; index += 1) {
    const data = await invoke<string>("telegram_read_blob_chunk", { accountId, token: value.token, index });
    chunks.push(Uint8Array.from(atob(data), (character) => character.charCodeAt(0)));
  }
  const file = new File(chunks, name, { type: mimeType, lastModified });
  if (file.size !== value.size) throw new Error("Attachment size verification failed");
  cached.set(file, { accountId, value: Promise.resolve(value) });
  return file;
};
