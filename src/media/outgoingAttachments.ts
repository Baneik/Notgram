import type {
  OutgoingAttachment,
  OutgoingAttachmentKind,
} from "../telegram/types";

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);
const ANIMATION_EXTENSIONS = new Set(["gif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav"]);
const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const ANIMATION_MIME_TYPES = new Set(["image/gif"]);
const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
]);
const AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/wav",
  "audio/x-wav",
]);
const PROBE_TIMEOUT_MS = 8_000;
const THUMBNAIL_MAX_EDGE = 320;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

const fileExtension = (name: string) => {
  const match = name.toLowerCase().match(/\.([^.]+)$/);
  return match?.[1];
};

export const classifyOutgoingAttachment = (file: Pick<File, "name" | "type" | "size">): OutgoingAttachmentKind => {
  const extension = fileExtension(file.name);
  const mimeType = file.type.toLowerCase();
  const matches = (extensions: ReadonlySet<string>, mimeTypes: ReadonlySet<string>) =>
    extension ? extensions.has(extension) : mimeTypes.has(mimeType);

  if (matches(PHOTO_EXTENSIONS, PHOTO_MIME_TYPES) && file.size <= 10 * 1024 * 1024) return "photo";
  if (matches(ANIMATION_EXTENSIONS, ANIMATION_MIME_TYPES)) return "animation";
  if (matches(VIDEO_EXTENSIONS, VIDEO_MIME_TYPES)) return "video";
  if (matches(AUDIO_EXTENSIONS, AUDIO_MIME_TYPES)) return "audio";
  return "document";
};

export const canSendAttachmentAsMedia = (kind: OutgoingAttachmentKind) => kind !== "document";

export const canPreviewOutgoingAttachment = (kind: OutgoingAttachmentKind) =>
  kind === "photo" || kind === "video" || kind === "animation";

const waitForMediaState = (
  element: HTMLMediaElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
  ready: () => boolean,
  start?: () => void,
) => new Promise<void>((resolve, reject) => {
  if (!start && ready()) {
    resolve();
    return;
  }
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
  try {
    start?.();
    if (ready()) onReady();
  } catch (error) {
    cleanup();
    reject(error);
  }
});

const waitForVideoMetadata = (video: HTMLVideoElement) => waitForMediaState(
  video,
  "loadedmetadata",
  () => video.readyState >= HAVE_METADATA,
);

const waitForVideoFrame = (video: HTMLVideoElement, currentTime?: number) => waitForMediaState(
  video,
  currentTime === undefined ? "loadeddata" : "seeked",
  () => video.readyState >= HAVE_CURRENT_DATA && !video.seeking &&
    (currentTime === undefined || Math.abs(video.currentTime - currentTime) < 0.01),
  currentTime === undefined ? undefined : () => {
    video.currentTime = currentTime;
  },
);

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
    await waitForVideoMetadata(video);
    const duration = finiteInteger(video.duration);
    if (duration && duration > 1) {
      await waitForVideoFrame(video, Math.min(1, duration / 3)).catch(async () => {
        await waitForVideoFrame(video).catch(() => undefined);
      });
    } else if (video.readyState < HAVE_CURRENT_DATA) {
      await waitForVideoFrame(video).catch(() => undefined);
    }
    const thumbnail = await thumbnailFromVideo(video, file.name).catch(() => undefined);
    return {
      width: finiteInteger(video.videoWidth),
      height: finiteInteger(video.videoHeight),
      duration,
      thumbnail,
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
    await waitForMediaState(audio, "loadedmetadata", () => audio.readyState >= HAVE_METADATA);
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
