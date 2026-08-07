import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import {
  indexMessagesByVirtualBlock,
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
});
