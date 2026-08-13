import type { Message } from "../telegram/types";

const DEFAULT_MEDIA_RATIO = 1;
const MIN_TILE_RATIO = 0.72;
const MAX_TILE_RATIO = 1.8;
const COMPACT_ALBUM_THRESHOLD = 5;
const FOUR_COLUMN_ALBUM_THRESHOLD = 9;

export interface MediaAlbumLayoutItem {
  message: Message;
  /** Relative width inside the justified row. */
  weight: number;
}

export interface MediaAlbumLayoutRow {
  items: MediaAlbumLayoutItem[];
  /** Width-to-height ratio of the complete row. */
  aspectRatio: number;
}

const validDimension = (value?: number): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

export const mediaAlbumTileRatio = (message: Message): number => {
  const content = message.content;
  if (
    content.kind !== "media" ||
    !validDimension(content.width) ||
    !validDimension(content.height)
  ) {
    return DEFAULT_MEDIA_RATIO;
  }
  return rounded(clamp(content.width / content.height, MIN_TILE_RATIO, MAX_TILE_RATIO));
};

const rowCost = (ratios: number[], idealRowRatio: number): number => {
  const aspectRatio = ratios.reduce((total, ratio) => total + ratio, 0);
  const relativeDifference = (aspectRatio - idealRowRatio) / idealRowRatio;
  const singleItemPenalty = ratios.length === 1
    ? ratios[0]! >= 1.35 ? 0.08 : 1.2
    : 0;
  return relativeDifference ** 2 + singleItemPenalty + 0.04;
};

const preferredRowSizes = (
  ratios: number[],
  idealRowRatio: number,
  maxItemsPerRow: number,
): number[] => {
  if (ratios.length === 2) {
    return ratios.every((ratio) => ratio >= 1.35) ? [1, 1] : [2];
  }

  const costs = new Array<number>(ratios.length + 1).fill(Number.POSITIVE_INFINITY);
  const sizes = new Array<number>(ratios.length).fill(1);
  costs[ratios.length] = 0;

  for (let index = ratios.length - 1; index >= 0; index -= 1) {
    const remaining = ratios.length - index;
    for (let size = 1; size <= Math.min(maxItemsPerRow, remaining); size += 1) {
      const nextIndex = index + size;
      const cost = rowCost(ratios.slice(index, nextIndex), idealRowRatio) + costs[nextIndex]!;
      if (cost < costs[index]! - Number.EPSILON) {
        costs[index] = cost;
        sizes[index] = size;
      }
    }
  }

  const result: number[] = [];
  for (let index = 0; index < ratios.length;) {
    const size = sizes[index]!;
    result.push(size);
    index += size;
  }
  return result;
};

/**
 * Creates a justified IM-style mosaic. Every row owns the full album width;
 * source ratios only decide tile proportions and sensible row breaks.
 */
export const layoutMediaAlbum = (messages: Message[]): MediaAlbumLayoutRow[] => {
  if (messages.length === 0) return [];

  const ratios = messages.map(mediaAlbumTileRatio);
  const idealRowRatio = messages.length >= COMPACT_ALBUM_THRESHOLD ? 3.2 : 2.5;
  const maxItemsPerRow = messages.length >= FOUR_COLUMN_ALBUM_THRESHOLD ? 4 : 3;
  const rowSizes = preferredRowSizes(ratios, idealRowRatio, maxItemsPerRow);
  const rows: MediaAlbumLayoutRow[] = [];
  let offset = 0;

  for (const size of rowSizes) {
    const rowMessages = messages.slice(offset, offset + size);
    const rowRatios = ratios.slice(offset, offset + size);
    const sourceAspectRatio = rowRatios.reduce((total, ratio) => total + ratio, 0);
    rows.push({
      items: rowMessages.map((message, index) => ({
        message,
        weight: rowRatios[index]!,
      })),
      aspectRatio: rounded(clamp(
        sourceAspectRatio,
        idealRowRatio * 0.9,
        idealRowRatio * 1.25,
      )),
    });
    offset += size;
  }

  return rows;
};
