import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { messageContentText } from "../telegram/messageContent";
import type { Message } from "../telegram/types";

export const writeClipboardText = async (text: string) => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for WebViews where the Clipboard API is exposed but denied.
    }
  }

  if (typeof document === "undefined") throw new Error("Clipboard is unavailable");
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard write failed");
};

const clipboardImageSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};

const imageBlobAsPng = async (blob: Blob) => {
  if (blob.type === "image/png") return blob;
  if (typeof document === "undefined") throw new Error("Image conversion is unavailable");

  const source = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Unable to decode the image"));
      element.src = source;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Unable to encode the image")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(source);
  }
};

export const writeClipboardImage = async (source: string, text?: string) => {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const ClipboardItemConstructor = (
    globalThis as typeof globalThis & { ClipboardItem?: typeof ClipboardItem }
  ).ClipboardItem;
  if (!clipboard?.write || !ClipboardItemConstructor) {
    throw new Error("Image clipboard access is unavailable");
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Unable to read image (${response.status})`);
  const png = await imageBlobAsPng(await response.blob());
  const payload: Record<string, Blob> = { "image/png": png };
  if (text?.trim()) payload["text/plain"] = new Blob([text], { type: "text/plain" });
  await clipboard.write([new ClipboardItemConstructor(payload)]);
};

export const copyMessageContent = async (message: Message) => {
  const content = message.content;
  if (
    content.kind === "media" &&
    (content.mediaType === "photo" || (
      content.mediaType === "sticker" &&
      content.mimeType !== "video/webm" &&
      content.mimeType !== "application/x-tgsticker"
    ))
  ) {
    const source = clipboardImageSource(content.localPath) ??
      clipboardImageSource(content.thumbnailPath) ??
      content.previewDataUrl;
    if (source) {
      await writeClipboardImage(source, content.caption);
      return;
    }
  }

  const text = messageContentText(content).trim();
  if (!text) throw new Error("Message has no copyable content");
  await writeClipboardText(text);
};
