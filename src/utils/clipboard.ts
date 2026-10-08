import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { messageCanBeSaved } from "../telegram/messageLifecycle";
import { messageContentText } from "../telegram/messageContent";
import type { Message } from "../telegram/types";

export const waitForClipboardFocus = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cleanup = () => {
    clearTimeout(timeout);
    window.removeEventListener("focus", ready);
    document.removeEventListener("visibilitychange", ready);
    signal.removeEventListener("abort", cancel);
  };
  const cancel = () => { cleanup(); reject(new DOMException("Clipboard action cancelled", "AbortError")); };
  const ready = () => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    cleanup(); resolve();
  };
  // A native menu action reaches its opener before WebView2 restores document focus.
  const timeout = setTimeout(() => { cleanup(); reject(new Error("Clipboard window did not regain focus")); }, 5_000);
  window.addEventListener("focus", ready);
  document.addEventListener("visibilitychange", ready);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  else ready();
});

export const readClipboardContent = async (): Promise<{ text: string; files: File[] }> => {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.read) {
    let items: ClipboardItem[] | undefined;
    try {
      items = await clipboard.read();
    } catch {
      // Some WebViews expose read() while only permitting the text-only API.
    }
    if (items) {
      const files: File[] = [];
      let text = "";
      for (const item of items) {
        const imageType = item.types.includes("image/png") ? "image/png" : item.types.find(type => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const extension = imageType.split("/")[1].replace("jpeg", "jpg");
          files.push(new File([blob], `clipboard-${files.length + 1}.${extension}`, { type: imageType }));
        } else if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      }
      return { text, files };
    }
  }
  if (!clipboard?.readText) throw new Error("Clipboard read is unavailable");
  return { text: await clipboard.readText(), files: [] };
};

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
  return isTauri() ? convertFileSrc(path, "notgram-asset") : path;
};

const imageBlobAsPng = async (blob: Blob) => {
  if (blob.type === "image/png") return blob;
  if (typeof document === "undefined") throw new Error("Image conversion is unavailable");

  const source = URL.createObjectURL(blob);
  try {
    return await rasterImageAsPng(source, new AbortController().signal);
  } finally {
    URL.revokeObjectURL(source);
  }
};

export const rasterImageAsPng = async (source: string, signal: AbortSignal) => {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    const cleanup = () => {
      element.onload = element.onerror = null;
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => { cleanup(); element.src = ""; reject(new DOMException("Image read cancelled", "AbortError")); };
    element.onload = () => { cleanup(); resolve(element); };
    element.onerror = () => { cleanup(); reject(new Error("Unable to decode the image")); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else element.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image conversion is unavailable");
  context.drawImage(image, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(png => png ? resolve(png) : reject(new Error("Unable to encode the image")), "image/png");
  });
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
  if (!messageCanBeSaved(message)) throw new Error("This message cannot be saved");
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
