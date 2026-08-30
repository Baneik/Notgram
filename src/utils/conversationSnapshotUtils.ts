const freezeSnapshotImages = (source: HTMLElement, clone: HTMLElement) => {
  const sourceImages = source.querySelectorAll<HTMLImageElement>(".photo-preview img");
  const cloneImages = clone.querySelectorAll<HTMLImageElement>(".photo-preview img");
  sourceImages.forEach((sourceImage, index) => {
    const cloneImage = cloneImages[index];
    if (!cloneImage || !sourceImage.complete || sourceImage.naturalWidth < 1) return;
    const canvas = document.createElement("canvas");
    canvas.width = sourceImage.naturalWidth;
    canvas.height = sourceImage.naturalHeight;
    try {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
      const frame = canvas.toDataURL("image/png");
      if (frame) cloneImage.src = frame;
    } catch {
      // A protected image can stay as a regular clone; the surrounding layout remains usable.
    }
  });
};

const freezeSnapshotVideos = (source: HTMLElement, clone: HTMLElement) => {
  const sourceVideos = source.querySelectorAll<HTMLVideoElement>("video");
  const cloneVideos = clone.querySelectorAll<HTMLVideoElement>("video");
  sourceVideos.forEach((sourceVideo, index) => {
    const cloneVideo = cloneVideos[index];
    if (!cloneVideo) return;
    if (
      sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      sourceVideo.videoWidth > 0 &&
      sourceVideo.videoHeight > 0
    ) {
      const canvas = document.createElement("canvas");
      canvas.width = sourceVideo.videoWidth;
      canvas.height = sourceVideo.videoHeight;
      try {
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
          const frame = canvas.toDataURL("image/png");
          if (frame) cloneVideo.setAttribute("poster", frame);
        }
      } catch {
        // A protected video can fall back to its existing poster.
      }
    }
    // The snapshot is presentation-only. Prevent cloned media from starting a
    // second decoder or from advancing while the source list is relocating.
    cloneVideo.autoplay = false;
    cloneVideo.removeAttribute("autoplay");
    cloneVideo.removeAttribute("src");
    cloneVideo.querySelectorAll("source").forEach((sourceElement) => sourceElement.remove());
    cloneVideo.load();
  });
};

/**
 * Keeps a cloned virtual list aligned even when its images have not decoded yet.
 * Virtuoso's content height is otherwise smaller at capture time and clamps the
 * copied scrollTop, exposing the wrong part of the old conversation.
 */
export const prepareConversationSnapshotClone = (
  source: HTMLElement,
  clone: HTMLElement,
  options?: { scrollTop?: number },
) => {
  const content = clone.querySelector<HTMLElement>(".message-list-content");
  if (content) {
    const sourceContent = source.querySelector<HTMLElement>(".message-list-content");
    // The live list uses an auto top margin at the bottom of short histories.
    // Once the clone is given a reserved height, that auto margin can expand
    // and move a long snapshot before scrollTop is applied. Long lists should
    // start at zero; short histories retain their live computed margin.
    if (sourceContent) {
      const sourceMarginTop = getComputedStyle(sourceContent).marginTop;
      const sourceIsScrollable = source.scrollHeight > source.clientHeight + 1;
      content.style.marginTop = sourceIsScrollable
        ? "0px"
        : sourceMarginTop;
    }
    content.style.minHeight = `${Math.max(source.scrollHeight, content.getBoundingClientRect().height)}px`;
    if (sourceContent && source.scrollHeight > source.clientHeight + 1) {
      // Re-apply after reserving the height: auto margins can be resolved
      // again during that layout pass in Chromium.
      content.style.marginTop = "0px";
    }
  }
  document.body.getBoundingClientRect();
  clone.scrollTop = options?.scrollTop ?? source.scrollTop;
  clone.scrollLeft = source.scrollLeft;

  // Keep a visual fallback for unusual layouts that still clamp the position
  // after the first measurement. Normally the reserved height makes this zero.
  const desiredScrollTop = options?.scrollTop ?? source.scrollTop;
  if (content && Math.abs(clone.scrollTop - desiredScrollTop) > 0.5) {
    const delta = desiredScrollTop - clone.scrollTop;
    const transform = content.style.transform;
    content.style.transform = `${transform && transform !== "none" ? `${transform} ` : ""}translateY(${delta}px)`;
  }

  freezeSnapshotImages(source, clone);
  freezeSnapshotVideos(source, clone);
};
