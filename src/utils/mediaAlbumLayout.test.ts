import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { layoutMediaAlbum, mediaAlbumTileRatio } from "./mediaAlbumLayout";

const mediaMessage = (
  id: string,
  width?: number,
  height?: number,
): Message => ({
  id,
  chatId: "chat",
  mediaAlbumId: "album",
  senderId: "sender",
  outgoing: false,
  sentAt: "2026-08-13T10:00:00+08:00",
  delivery: "read",
  content: {
    kind: "media",
    mediaType: "photo",
    fileName: `${id}.jpg`,
    sizeLabel: "1 MB",
    width,
    height,
  },
});

describe("media album layout", () => {
  it("uses bounded source ratios and a stable fallback", () => {
    expect(mediaAlbumTileRatio(mediaMessage("portrait", 600, 1_800))).toBe(0.72);
    expect(mediaAlbumTileRatio(mediaMessage("landscape", 3_200, 900))).toBe(1.8);
    expect(mediaAlbumTileRatio(mediaMessage("unknown"))).toBe(1);
  });

  it("stacks two wide images and keeps other pairs side by side", () => {
    expect(layoutMediaAlbum([
      mediaMessage("wide-1", 1_600, 900),
      mediaMessage("wide-2", 1_600, 900),
    ]).map((row) => row.items.length)).toEqual([1, 1]);
    expect(layoutMediaAlbum([
      mediaMessage("portrait", 900, 1_600),
      mediaMessage("square", 1_000, 1_000),
    ]).map((row) => row.items.length)).toEqual([2]);
  });

  it("fills albums from two through ten items without orphaned grid cells", () => {
    const expectedRows = new Map([
      [2, [2]],
      [3, [3]],
      [4, [2, 2]],
      [5, [2, 3]],
      [6, [3, 3]],
      [7, [2, 2, 3]],
      [8, [2, 3, 3]],
      [9, [3, 3, 3]],
      [10, [3, 3, 4]],
    ]);

    for (const [count, rowSizes] of expectedRows) {
      const messages = Array.from({ length: count }, (_, index) =>
        mediaMessage(String(index + 1), 1_000, 1_000));
      const rows = layoutMediaAlbum(messages);
      expect(rows.map((row) => row.items.length), `${count} item rows`).toEqual(rowSizes);
      expect(rows.flatMap((row) => row.items.map((item) => item.message.id)))
        .toEqual(messages.map((message) => message.id));
      expect(rows.every((row) => row.aspectRatio > 0)).toBe(true);
    }
  });

  it("allocates more row width to landscape media while preserving order", () => {
    const [row] = layoutMediaAlbum([
      mediaMessage("portrait", 900, 1_600),
      mediaMessage("landscape", 1_600, 900),
    ]);
    expect(row?.items.map((item) => item.message.id)).toEqual(["portrait", "landscape"]);
    expect(row?.items[1]?.weight).toBeGreaterThan(row?.items[0]?.weight ?? 0);
    expect(row?.aspectRatio).toBeCloseTo(
      (row?.items[0]?.weight ?? 0) + (row?.items[1]?.weight ?? 0),
      3,
    );
  });
});
