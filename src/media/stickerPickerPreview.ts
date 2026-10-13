import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { EmojiPickerAsset } from "../telegram/types";
import { loadTgsAnimationData } from "./tgsAnimationCache";

const EDGE = 96;

/** Persist small display pixels, independent of the original file/player caches. */
export const prepareStickerPickerPreview = async (asset: EmojiPickerAsset, path: string, signal: AbortSignal) => {
  if (typeof document === "undefined" || signal.aborted) return undefined;
  const source = isTauri() ? convertFileSrc(path, "notgram-asset") : path;
  const canvas = document.createElement("canvas");
  canvas.width = EDGE;
  canvas.height = EDGE;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const hasPixels = () => context.getImageData(0, 0, EDGE, EDGE).data.some((value, index) => index % 4 === 3 && value > 0);
  const draw = (media: CanvasImageSource, width: number, height: number) => {
    const scale = Math.min(EDGE / width, EDGE / height);
    const w = width * scale;
    const h = height * scale;
    context.drawImage(media, (EDGE - w) / 2, (EDGE - h) / 2, w, h);
  };
  const waitFor = (element: HTMLImageElement | HTMLVideoElement, ready: string) => new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error("Sticker preview timed out")), 15_000);
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      element.removeEventListener(ready, loaded);
      element.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const finish = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
    const loaded = () => finish();
    const failed = () => finish(new Error("Sticker preview unavailable"));
    const cancelled = () => finish(new Error("Sticker preview cancelled"));
    element.addEventListener(ready, loaded, { once: true });
    element.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
  });
  if (asset.mimeType === "application/x-tgsticker") {
    const [data, { default: lottie }] = await Promise.all([loadTgsAnimationData(source), import("lottie-web/build/player/lottie_light_canvas")]);
    if (signal.aborted) return undefined;
    const container = document.createElement("span");
    const animation = lottie.loadAnimation({ container, renderer: "canvas", loop: false, autoplay: false,
      animationData: data, rendererSettings: { clearCanvas: true, dpr: 1 } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => finish(new Error("Sticker frame timed out")), 15_000);
        const cancel = () => finish(new Error("Sticker frame cancelled"));
        const ready = () => finish();
        const failed = () => finish(new Error("Sticker frame unavailable"));
        const finish = (error?: Error) => {
          globalThis.clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          animation.removeEventListener("DOMLoaded", ready);
          animation.removeEventListener("data_failed", failed);
          if (error) reject(error); else resolve();
        };
        signal.addEventListener("abort", cancel, { once: true });
        animation.addEventListener("DOMLoaded", ready);
        animation.addEventListener("data_failed", failed);
        if (animation.isLoaded) ready();
      });
      animation.resize(EDGE, EDGE);
      // Some animated stickers enter from an empty frame. Save a recognizable
      // frame instead of permanently caching a transparent first frame.
      for (const fraction of [0, 0.15, 0.35, 0.65]) {
        animation.goToAndStop(Math.floor(animation.totalFrames * fraction), true);
        const rendered = container.querySelector("canvas");
        if (rendered) { context.clearRect(0, 0, EDGE, EDGE); context.drawImage(rendered, 0, 0, EDGE, EDGE); }
        if (hasPixels()) break;
      }
      if (!hasPixels()) return undefined;
      return signal.aborted ? undefined : canvas.toDataURL("image/webp", 0.85);
    } finally { animation.destroy(); }
  }
  if (asset.mimeType === "video/webm" || asset.kind === "animation") {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    const loaded = waitFor(video, "loadeddata");
    video.src = source;
    try {
      await loaded;
      draw(video, video.videoWidth, video.videoHeight);
      if (!hasPixels() && Number.isFinite(video.duration) && video.duration > 0) {
        const seeked = waitFor(video, "seeked");
        video.currentTime = Math.min(0.25, video.duration / 2);
        await seeked;
        draw(video, video.videoWidth, video.videoHeight);
      }
      if (!hasPixels()) return undefined;
    }
    finally { video.removeAttribute("src"); video.load(); }
  } else {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const loaded = waitFor(image, "load");
    image.src = source;
    try { await loaded; draw(image, image.naturalWidth, image.naturalHeight); }
    finally { image.removeAttribute("src"); }
  }
  return signal.aborted ? undefined : canvas.toDataURL("image/webp", 0.85);
};
