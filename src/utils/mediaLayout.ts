import type { MessageContent } from "../telegram/types";

type VisualMediaType = Extract<MessageContent, { kind: "media" }>["mediaType"];

interface MediaBounds {
  maxWidth: number;
  maxHeight: number;
}

export interface MediaLayout extends MediaBounds {
  width: number;
  height?: number;
  aspectRatio?: string;
}

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
): MediaLayout => {
  const bounds = boundsFor(mediaType);
  if (!validDimension(sourceWidth) || !validDimension(sourceHeight)) {
    return { ...bounds, width: bounds.maxWidth };
  }

  const width = sourceWidth;
  const height = sourceHeight;
  const scale = Math.min(bounds.maxWidth / width, bounds.maxHeight / height);
  return {
    ...bounds,
    width: rounded(width * scale),
    height: rounded(height * scale),
    aspectRatio: `${width} / ${height}`,
  };
};
