import type { MessageContent } from "../telegram/types";

type VisualMediaType = Extract<MessageContent, { kind: "media" }>["mediaType"];

interface MediaBounds {
  maxWidth: number;
  maxHeight: number;
}

export interface MediaLayout extends MediaBounds {
  /** Width of the complete media card, including any readable text below it. */
  width: number;
  /** Height reserved for the visual media frame before responsive scaling. */
  height?: number;
  /** Responsive ratio of the complete media frame, not the source asset. */
  aspectRatio?: string;
  /** Fitted source dimensions inside the media frame. */
  contentWidth: number;
  contentHeight?: number;
}

export interface MediaLayoutOptions {
  /** Captions and reply/forward context need a predictable reading width. */
  hasReadableText?: boolean;
}

export const MEDIA_READABLE_CARD_WIDTH = 320;
export const MEDIA_MIN_CARD_WIDTH = 160;
export const VIDEO_MIN_CARD_WIDTH = 300;

const boundsFor = (mediaType: VisualMediaType): MediaBounds => {
  if (mediaType === "sticker") return { maxWidth: 240, maxHeight: 240 };
  if (mediaType === "videoNote") return { maxWidth: 280, maxHeight: 280 };
  return { maxWidth: 390, maxHeight: 420 };
};

const validDimension = (value?: number): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

export const fitMediaLayout = (
  mediaType: VisualMediaType,
  sourceWidth?: number,
  sourceHeight?: number,
  options: MediaLayoutOptions = {},
): MediaLayout => {
  const bounds = boundsFor(mediaType);
  if (!validDimension(sourceWidth) || !validDimension(sourceHeight)) {
    return {
      ...bounds,
      width: bounds.maxWidth,
      contentWidth: bounds.maxWidth,
    };
  }

  const width = sourceWidth;
  const height = sourceHeight;
  const scale = Math.min(bounds.maxWidth / width, bounds.maxHeight / height);
  const contentWidth = rounded(width * scale);
  const contentHeight = rounded(height * scale);
  const usesIndependentGeometry = mediaType === "sticker" || mediaType === "videoNote";
  const readableWidth = options.hasReadableText && !usesIndependentGeometry
    ? MEDIA_READABLE_CARD_WIDTH
    : 0;
  const minimumWidth = usesIndependentGeometry
    ? 0
    : mediaType === "video" ? VIDEO_MIN_CARD_WIDTH : MEDIA_MIN_CARD_WIDTH;
  const cardWidth = rounded(Math.min(
    bounds.maxWidth,
    Math.max(contentWidth, readableWidth, minimumWidth),
  ));
  return {
    ...bounds,
    width: cardWidth,
    height: contentHeight,
    aspectRatio: `${cardWidth} / ${contentHeight}`,
    contentWidth,
    contentHeight,
  };
};
