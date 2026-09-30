// Both mounting and media preparation must cover the same scroll-root region.
// A window-root margin cannot extend past a nested scroller's clipping edge.
export const MESSAGE_VIEWPORT_PREFETCH = { top: 1600, bottom: 1000 } as const;
export const MEDIA_PREFETCH_ROOT_MARGIN = "1600px 0px 1000px 0px";
export const MESSAGE_SCROLL_ROOT_SELECTOR = ".message-list, .channel-discussion-messages";
