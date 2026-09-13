import { isConversationSwitchActive, markConversationSwitch } from "./performanceMonitor";

/** Observe presentation after positioning; this never holds up navigation or downloads. */
export const observeConversationPresentation = (list: HTMLElement, traceId: number | undefined) => {
  if (!isConversationSwitchActive(traceId)) return () => undefined;
  const viewport = list.getBoundingClientRect();
  const media = [...list.querySelectorAll<HTMLElement>(".photo-preview, .rich-media-visual")].filter((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom &&
      bounds.right > viewport.left && bounds.left < viewport.right;
  });
  let frame = 0;
  let revealed = false;
  let stopped = false;
  let uncoveredFrames = 0;
  const posters = new Map<HTMLVideoElement, { source: string; image: HTMLImageElement; ready: boolean }>();
  const posterReady = (video: HTMLVideoElement) => {
    if (!video.poster) return false;
    let poster = posters.get(video);
    if (poster?.source !== video.poster) {
      const image = new Image();
      poster = { source: video.poster, image, ready: false };
      const pending = poster;
      posters.set(video, pending);
      image.src = video.poster;
      // Native poster painting has no load event on the video. Decode the same
      // resource to verify a usable preview without waiting for video playback.
      void image.decode().then(() => { pending.ready = image.naturalWidth > 0; }).catch(() => undefined);
    }
    return poster.ready;
  };
  const sample = () => {
    if (stopped) return;
    if (!list.isConnected || !isConversationSwitchActive(traceId)) { cleanup(); return; }
    const covered = list.closest("[inert]") || list.classList.contains("is-entry-positioning") ||
      document.querySelector("[data-conversation-switch-snapshot], [data-conversation-motion-snapshot]");
    uncoveredFrames = covered ? 0 : uncoveredFrames + 1;
    // A rAF callback runs before paint. Observe a full uncovered frame before
    // reporting visible messages, rather than marking the selection's next rAF.
    if (uncoveredFrames >= 2) {
      if (!revealed) {
        revealed = true;
        markConversationSwitch(traceId, "transitionFinished");
      }
      let failed = false;
      const settled = media.every((surface) => {
        if (!surface.isConnected) { failed = true; return true; }
        const images = [...surface.querySelectorAll<HTMLImageElement>("img")];
        if (images.some((image) => image.complete && image.naturalWidth > 0 &&
          image.dataset.imageState === "ready" && Number(getComputedStyle(image).opacity) >= 0.99)) return true;
        const video = surface.querySelector("video");
        if (video && (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || posterReady(video))) return true;
        if (surface.querySelector(".tgs-sticker canvas, .tgs-sticker svg")) return true;
        if (images.some((image) => image.dataset.imageState === "error") || video?.error) {
          failed = true;
          return true;
        }
        return false;
      });
      if (settled) {
        markConversationSwitch(traceId, "mediaReady", { failed });
        cleanup();
        return;
      }
    }
    frame = requestAnimationFrame(sample);
  };
  const handleVisibility = () => {
    cancelAnimationFrame(frame);
    if (!stopped && !document.hidden) frame = requestAnimationFrame(sample);
  };
  const cleanup = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", handleVisibility);
    posters.clear();
  };
  document.addEventListener("visibilitychange", handleVisibility);
  if (!document.hidden) frame = requestAnimationFrame(sample);
  return cleanup;
};
