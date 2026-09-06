import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { mediaAlbumCaptionMessage, mediaAlbumMessagesFor, segmentMediaAlbums } from "./mediaAlbums";

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
  it("finds the sole caption owner at any position without copying its text to other items", () => {
    for (const outgoing of [false, true]) {
      for (const ownerIndex of [0, 1, 2]) {
        const messages = [0, 1, 2].map((index) => message(String(index), "album", "photo", { outgoing }));
        const owner = messages[ownerIndex]!;
        if (owner.content.kind !== "media") throw new Error("Expected media");
        owner.content.caption = "description\nsecond line";
        owner.content.captionEntities = [{ kind: "bold", offset: 0, length: 11 }];
        owner.content.showCaptionAboveMedia = true;
        expect(mediaAlbumCaptionMessage(messages)).toEqual(owner);
        expect(messages.filter((item) => item.content.kind === "media" && item.content.caption)).toHaveLength(1);
      }
    }
  });

  it("has no shared caption when absent or when multiple items have captions, even identical ones", () => {
    const messages = [message("1", "album"), message("2", "album")];
    expect(mediaAlbumCaptionMessage(messages)).toBeUndefined();
    for (const item of messages) {
      if (item.content.kind === "media") item.content.caption = "same caption";
    }
    expect(mediaAlbumCaptionMessage(messages)).toBeUndefined();
    if (messages[1]!.content.kind === "media") messages[1]!.content.caption = "different caption";
    expect(mediaAlbumCaptionMessage(messages)).toBeUndefined();
    expect(mediaAlbumCaptionMessage([message("3", "album", "audio", {
      content: { kind: "media", mediaType: "audio", fileName: "song", sizeLabel: "1 MB", caption: "audio caption" },
    })])).toBeUndefined();
  });

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

  it("separates different album ids and chats", () => {
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
      "album",
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
