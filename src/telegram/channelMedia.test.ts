import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";
import type { Message, OutgoingAttachmentKind } from "./types";

describe("channel album sends", () => {
  it.each<[OutgoingAttachmentKind, number]>([["photo", 0], ["video", 0], ["document", 2], ["audio", 2]])(
    "keeps the shared %s caption and entities on the compatible item", async (kind, captionIndex) => {
      const transport = new MockTelegramTransport();
      const sent: Message[] = [];
      await transport.connect(event => { if (event.type === "message.upsert") sent.push(event.message); });
      const accepted: number[] = [];
      await transport.sendFiles({
        chatId: "chat-release",
        attachments: [0, 1, 2].map(index => ({ kind, file: new File(["media"], `media-${index}`, { type: "application/octet-stream" }) })),
        caption: "description", captionEntities: [{ kind: "bold", offset: 0, length: 11 }],
        onGroupAccepted: async group => { accepted.push(group.length); },
      });
      expect(sent).toHaveLength(3);
      expect(new Set(sent.map(message => message.mediaAlbumId)).size).toBe(1);
      expect(sent[0].mediaAlbumId).toBeTruthy();
      expect(sent.map(message => "caption" in message.content ? message.content.caption : undefined))
        .toEqual([0, 1, 2].map(index => index === captionIndex ? "description" : undefined));
      expect(sent[captionIndex].content).toMatchObject({ captionEntities: [{ kind: "bold", offset: 0, length: 11 }] });
      expect(accepted).toEqual([3]);
      transport.disconnect();
    },
  );

  it("splits oversized document batches and sends the description only once", async () => {
    const transport = new MockTelegramTransport();
    const sent: Message[] = [];
    await transport.connect(event => { if (event.type === "message.upsert") sent.push(event.message); });
    await transport.sendFiles({ chatId: "chat-release", caption: "one description",
      attachments: Array.from({ length: 12 }, (_, index) => ({ kind: "document" as const, file: new File(["file"], `${index}.png`) })),
    });
    expect(sent[9].content).toMatchObject({ caption: "one description" });
    expect(sent.filter(message => "caption" in message.content && message.content.caption)).toHaveLength(1);
    expect(sent[0].mediaAlbumId).not.toBe(sent[10].mediaAlbumId);
    transport.disconnect();
  });
});
