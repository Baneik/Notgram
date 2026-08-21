import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { mediaAlbumMessagesFor, segmentMediaAlbums } from "./mediaAlbums";

const message = (
  id: string,
  mediaAlbumId?: string,
  mediaType: "photo" | "video" | "audio" = "photo",
  overrides: Partial<Message> = {},
): Message => ({
  id,
  chatId: "chat",
  mediaAlbumId,
  senderId: "alice",
  outgoing: false,
  sentAt: `2026-08-03T09:00:0${id}Z`,
  delivery: "sent",
  content: { kind: "media", mediaType, fileName: `${id}.jpg`, sizeLabel: "1 MB" },
  ...overrides,
});

const ids = (messages: Message[]) => messages.map(({ id }) => id);

describe("media album segmentation", () => {
  it("groups consecutive visual media with the same album id in message order", () => {
    const segments = segmentMediaAlbums([
      message("1", "album-a", "photo"),
      message("2", "album-a", "video"),
      message("3", "album-a", "photo"),
      message("4"),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.kind).toBe("album");
    if (segments[0]?.kind === "album") {
      expect(segments[0].albumId).toBe("album-a");
      expect(ids(segments[0].messages)).toEqual(["1", "2", "3"]);
    }
    expect(segments[1]).toMatchObject({ kind: "message", message: { id: "4" } });
  });

  it("keeps one visual album item as an ordinary message", () => {
    expect(segmentMediaAlbums([message("1", "album-a")]))
      .toMatchObject([{ kind: "message", message: { id: "1" } }]);
  });

  it("does not join album items across intervening messages", () => {
    const segments = segmentMediaAlbums([
      message("1", "album-a"),
      { ...message("2"), content: { kind: "text", text: "separator" } },
      message("3", "album-a"),
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual(["message", "message", "message"]);
  });

  it("separates different album ids, chats, senders, and directions", () => {
    const segments = segmentMediaAlbums([
      message("1", "album-a"),
      message("2", "album-b"),
      message("3", "album-b", "photo", { chatId: "other-chat" }),
      message("4", "album-b", "photo", { senderId: "bob" }),
      message("5", "album-b", "photo", { outgoing: true }),
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("leaves non-visual media outside visual albums", () => {
    expect(segmentMediaAlbums([
      message("1", "album-a", "audio"),
      message("2", "album-a", "audio"),
    ]).map((segment) => segment.kind)).toEqual(["message", "message"]);
  });

  it("resolves the complete visual album for a context-menu message", () => {
    const source = message("2", "album-a", "video");
    expect(ids(mediaAlbumMessagesFor([
      message("1", "album-a"),
      source,
      message("3", "album-b"),
      message("4", "album-a", "photo", { chatId: "other-chat" }),
    ], source))).toEqual(["1", "2"]);
    expect(mediaAlbumMessagesFor([source], { ...source, mediaAlbumId: undefined })).toEqual([]);
  });
});
