import type { Message } from "../telegram/types";
import { messageCanBeSaved } from "../telegram/messageLifecycle";
import { telegramStore } from "../store/telegramStore";
import { localMediaSource } from "../media/localMediaSource";
import { isComposerImageSource, readComposerDroppedImage } from "./composerDrop";

const ATTACHMENT_DRAG_TYPE = "application/x-notgram-attachment";
interface AttachmentDrag {
  token: string;
  accountId: string;
  draftKey: string;
  read: (signal: AbortSignal) => Promise<File>;
}
let currentDrag: AttachmentDrag | undefined;
let disposeDrag: (() => void) | undefined;

export const isInternalAttachmentDrag = (data: DataTransfer) => data.types.includes(ATTACHMENT_DRAG_TYPE);
export const internalAttachmentDrag = (data: DataTransfer) => isInternalAttachmentDrag(data) ? currentDrag : undefined;
export const isCurrentAttachmentDrag = (drag: AttachmentDrag) => currentDrag === drag;

export function startAttachmentDrag(data: DataTransfer, draftKey: string, read: AttachmentDrag["read"]) {
  disposeDrag?.();
  const reset = () => {
    currentDrag = undefined;
    window.removeEventListener("dragend", reset);
    window.removeEventListener("blur", reset);
    window.removeEventListener("keydown", cancel, true);
    disposeDrag = undefined;
  };
  const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") reset(); };
  // The source can unmount during a hover switch; retain its reader until drag end.
  const token = crypto.randomUUID();
  currentDrag = { token, accountId: telegramStore.getState().activeAccountId, draftKey, read };
  disposeDrag = reset;
  data.setData(ATTACHMENT_DRAG_TYPE, token);
  data.effectAllowed = "copy";
  window.addEventListener("dragend", reset, { once: true });
  window.addEventListener("blur", reset, { once: true });
  window.addEventListener("keydown", cancel, true);
}

export const ownsAttachmentDrag = (data: DataTransfer, drag: AttachmentDrag) =>
  data.getData(ATTACHMENT_DRAG_TYPE) === drag.token;

export async function readMessageAttachment(message: Message, signal: AbortSignal): Promise<File> {
  let content = message.content;
  if ((content.kind !== "file" && content.kind !== "media") || !messageCanBeSaved(message)) {
    throw new Error("Message attachment is unavailable");
  }
  const accountId = telegramStore.getState().activeAccountId;
  if (!content.localPath && content.fileId !== undefined) {
    await telegramStore.getState().cacheFile(content.fileId, 32);
    const updated = telegramStore.getState().messages.get(message.chatId)?.find(item => item.id === message.id);
    if (updated && !messageCanBeSaved(updated)) throw new Error("Message attachment is protected");
    if (updated?.content.kind === "file" || updated?.content.kind === "media") content = updated.content;
  }
  signal.throwIfAborted();
  if (telegramStore.getState().activeAccountId !== accountId) throw new Error("Attachment account changed");
  const path = localMediaSource(content.localPath);
  if (!path) throw new Error("Message attachment has no local source");
  const source = new URL(path, location.href).href;
  if (!isComposerImageSource(source, location.origin)) throw new Error("Unsupported attachment source");
  if (/^(blob:|data:)/.test(source) && content.kind === "media" && content.mediaType === "photo") {
    const file = await readComposerDroppedImage(source, signal);
    return new File([file], content.fileName, { type: file.type });
  }
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error("Unable to read attachment");
  const blob = await response.blob();
  return new File([blob], content.fileName, { type: content.mimeType || blob.type });
}
