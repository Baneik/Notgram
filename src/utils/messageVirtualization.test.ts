import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import {
  indexMessagesByVirtualBlock,
  virtualizeMessageTimeline,
  virtualizeMessageGroups,
} from "./messageVirtualization";

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  chatId: "chat",
  senderId: "alice",
  outgoing: false,
  sentAt: "2026-08-03T09:00:00+08:00",
  delivery: "sent",
  content: { kind: "text", text: id },
  ...overrides,
});

describe("message virtualization", () => {
  it("inserts sponsored entries without changing message block identities", () => {
    const sponsored = {
      id: "sponsored-1",
      chatId: "chat",
      isRecommended: false,
      canBeReported: false,
      sponsor: { url: "https://example.com", avatar: { label: "S", color: "#123456" } },
      title: "Sponsor",
      buttonText: "Open",
      accentColorId: 0,
      content: { kind: "text" as const, text: "Ad" },
    };
    const blocks = virtualizeMessageTimeline(
      [message("1"), message("2"), message("3")],
      [sponsored],
      { messagesBetween: 2 },
      1,
    );
    expect(blocks.map((block) => block.id)).toEqual(["1", "2", "sponsored:sponsored-1", "3"]);
    expect(blocks[2]?.messages).toEqual([]);
    expect(blocks[2]?.sponsoredMessage?.id).toBe("sponsored-1");
  });

  it("bounds long consecutive groups while retaining bubble positions", () => {
    const blocks = virtualizeMessageGroups(
      Array.from({ length: 11 }, (_, index) => message(String(index + 1))),
      4,
    );

    expect(blocks.map((block) => block.messages.map(({ id }) => id))).toEqual([
      ["1", "2", "3", "4"],
      ["5", "6", "7", "8"],
      ["9", "10", "11"],
    ]);
    expect(blocks.map(({ continuesBefore, continuesAfter }) => [
      continuesBefore,
      continuesAfter,
    ])).toEqual([[false, true], [true, true], [true, false]]);
    expect(blocks[0]?.positions.get("1")).toBe("first");
    expect(blocks[1]?.positions.get("6")).toBe("middle");
    expect(blocks[2]?.positions.get("11")).toBe("last");
  });

  it("keeps an album atomic even when it exceeds the block target", () => {
    const albumMessages = Array.from({ length: 5 }, (_, index) => message(
      String(index + 1),
      {
        mediaAlbumId: "album",
        content: {
          kind: "media",
          mediaType: "photo",
          fileName: `${index + 1}.jpg`,
          sizeLabel: "1 MB",
        },
      },
    ));
    const blocks = virtualizeMessageGroups([
      ...albumMessages,
      message("6"),
    ], 4);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.segments[0]?.kind).toBe("album");
    expect(blocks[0]?.messages).toHaveLength(5);
    expect(blocks[1]?.messages.map(({ id }) => id)).toEqual(["6"]);
  });

  it("uses positions local to an album inside a longer sender group", () => {
    const media = (id: string): Message => message(id, {
      mediaAlbumId: "album",
      content: {
        kind: "media",
        mediaType: "photo",
        fileName: `${id}.jpg`,
        sizeLabel: "1 MB",
      },
    });
    const blocks = virtualizeMessageGroups([
      message("before"),
      media("album-first"),
      media("album-last"),
      message("after"),
    ]);

    expect(blocks[0]?.positions.get("before")).toBe("first");
    expect(blocks[0]?.positions.get("album-first")).toBe("first");
    expect(blocks[0]?.positions.get("album-last")).toBe("last");
    expect(blocks[0]?.positions.get("after")).toBe("last");
  });

  it("groups channel albums while keeping ordinary channel posts separate", () => {
    const channelPhoto = (id: string, albumId?: string): Message => message(id, {
      isChannelPost: true,
      mediaAlbumId: albumId,
      content: albumId
        ? { kind: "media", mediaType: "photo", fileName: `${id}.png`, sizeLabel: "1 MB" }
        : { kind: "text", text: id },
    });
    const blocks = virtualizeMessageGroups([
      channelPhoto("post-1"),
      channelPhoto("album-1", "album"),
      channelPhoto("album-2", "album"),
      channelPhoto("post-2"),
    ], 4, false);

    expect(blocks.map((block) => block.messages.map(({ id }) => id))).toEqual([
      ["post-1"], ["album-1", "album-2"], ["post-2"],
    ]);
    expect(blocks[1]?.segments[0]?.kind).toBe("album");
  });

  it("indexes every message by its containing virtual block", () => {
    const blocks = virtualizeMessageGroups(
      Array.from({ length: 7 }, (_, index) => message(String(index + 1))),
      3,
    );
    const indexes = indexMessagesByVirtualBlock(blocks);

    expect(indexes.get("1")).toBe(0);
    expect(indexes.get("4")).toBe(1);
    expect(indexes.get("7")).toBe(2);
  });

  it("isolates sparse search results instead of visually grouping skipped messages", () => {
    const blocks = virtualizeMessageGroups([
      message("first"),
      message("second"),
    ], 4, false);

    expect(blocks.map((block) => block.messages.map(({ id }) => id))).toEqual([
      ["first"],
      ["second"],
    ]);
    expect(blocks.every((block) => block.positions.get(block.firstMessage.id) === "single")).toBe(true);
  });

  it("keeps a virtual block stable when TDLib replaces a temporary message id", () => {
    const temporary = virtualizeMessageGroups([
      message("-10", { renderKey: "send-1", outgoing: true }),
    ]);
    const confirmed = virtualizeMessageGroups([
      message("100", { renderKey: "send-1", outgoing: true, delivery: "sent" }),
    ]);

    expect(temporary[0]?.id).toBe("send-1");
    expect(confirmed[0]?.id).toBe("send-1");
    expect(confirmed[0]?.messages[0]?.id).toBe("100");
  });

  it("keeps existing virtual item identities stable across history and live inserts", () => {
    const current = virtualizeMessageGroups([
      message("2"),
      message("3"),
    ], 1);
    const withHistory = virtualizeMessageGroups([
      message("1"),
      message("2"),
      message("3"),
    ], 1);
    const withLiveMessage = virtualizeMessageGroups([
      message("2"),
      message("3"),
      message("4"),
    ], 1);

    expect(current.map(({ id }) => id)).toEqual(["2", "3"]);
    expect(withHistory.slice(1).map(({ id }) => id)).toEqual(["2", "3"]);
    expect(withLiveMessage.slice(0, 2).map(({ id }) => id)).toEqual(["2", "3"]);
  });
});
