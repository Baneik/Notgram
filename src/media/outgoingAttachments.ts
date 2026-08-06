import type {
  OutgoingAttachment,
  OutgoingAttachmentKind,
} from "../telegram/types";

const PHOTO_EXTENSIONS = /\.(?:jpe?g|png)$/i;
const ANIMATION_EXTENSIONS = /\.(?:gif)$/i;
const VIDEO_EXTENSIONS = /\.(?:mp4|m4v|mov|webm|mkv)$/i;
const AUDIO_EXTENSIONS = /\.(?:mp3|m4a|aac|ogg|oga|opus|flac|wav)$/i;
const PROBE_TIMEOUT_MS = 8_000;
const THUMBNAIL_MAX_EDGE = 320;

export const classifyOutgoingAttachment = (file: Pick<File, "name" | "type" | "size">): OutgoingAttachmentKind => {
  if ((file.type === "image/jpeg" || file.type === "image/png" || PHOTO_EXTENSIONS.test(file.name)) &&
    file.size <= 10 * 1024 * 1024) return "photo";
  if (file.type === "image/gif" || ANIMATION_EXTENSIONS.test(file.name)) return "animation";
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name)) return "audio";
  return "document";
};

const waitForMedia = (
  element: HTMLMediaElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
) => new Promise<void>((resolve, reject) => {
  const timer = globalThis.setTimeout(() => {
    cleanup();
    reject(new Error("媒体元数据读取超时"));
  }, PROBE_TIMEOUT_MS);
  const cleanup = () => {
    globalThis.clearTimeout(timer);
    element.removeEventListener(eventName, onReady);
    element.removeEventListener("error", onError);
  };
  const onReady = () => {
    cleanup();
    resolve();
  };
  const onError = () => {
    cleanup();
    reject(new Error("无法读取媒体元数据"));
  };
  element.addEventListener(eventName, onReady, { once: true });
  element.addEventListener("error", onError, { once: true });
});

const finiteInteger = (value: number) => Number.isFinite(value) && value > 0
  ? Math.round(value)
  : undefined;

const thumbnailFromVideo = async (video: HTMLVideoElement, name: string) => {
  if (!video.videoWidth || !video.videoHeight) return undefined;
  const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) return undefined;
  const stem = name.replace(/\.[^.]+$/, "") || "video";
  return new File([blob], `${stem}-cover.jpg`, { type: "image/jpeg" });
};

const probeVideo = async (file: File): Promise<Partial<OutgoingAttachment>> => {
  const source = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = source;
  try {
    await waitForMedia(video, "loadedmetadata");
    const duration = finiteInteger(video.duration);
    if (duration && duration > 1) {
      video.currentTime = Math.min(1, duration / 3);
      await waitForMedia(video, "seeked").catch(() => undefined);
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMedia(video, "loadeddata").catch(() => undefined);
    }
    return {
      width: finiteInteger(video.videoWidth),
      height: finiteInteger(video.videoHeight),
      duration,
      thumbnail: await thumbnailFromVideo(video, file.name),
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(source);
  }
};

const probeAudio = async (file: File): Promise<Partial<OutgoingAttachment>> => {
  const source = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = source;
  try {
    await waitForMedia(audio, "loadedmetadata");
    return {
      duration: finiteInteger(audio.duration),
      title: file.name.replace(/\.[^.]+$/, ""),
    };
  } finally {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(source);
  }
};

const probePhoto = async (file: File): Promise<Partial<OutgoingAttachment>> => {
  const source = URL.createObjectURL(file);
  const image = new Image();
  image.src = source;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error("图片元数据读取超时")), PROBE_TIMEOUT_MS);
      image.onload = () => {
        globalThis.clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        globalThis.clearTimeout(timer);
        reject(new Error("无法读取图片元数据"));
      };
    });
    return {
      width: finiteInteger(image.naturalWidth),
      height: finiteInteger(image.naturalHeight),
    };
  } finally {
    URL.revokeObjectURL(source);
  }
};

export const inspectOutgoingAttachment = async (file: File): Promise<OutgoingAttachment> => {
  const kind = classifyOutgoingAttachment(file);
  try {
    const metadata = kind === "photo"
      ? await probePhoto(file)
      : kind === "video" || kind === "animation"
        ? await probeVideo(file)
        : kind === "audio"
          ? await probeAudio(file)
          : {};
    return { file, kind, ...metadata };
  } catch {
    return { file, kind };
  }
};

export const attachmentAlbumFamily = (kind: OutgoingAttachmentKind) => {
  if (kind === "photo" || kind === "video") return "visual";
  if (kind === "audio") return "audio";
  if (kind === "document") return "document";
  return "animation";
};
