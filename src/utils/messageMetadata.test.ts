import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../telegram/types";
import { mediaAlbumMetadataMessage, messageDeliveryState } from "./messageMetadata";
import { MessageDeliveryStatus } from "../components/MessageDeliveryStatus";

const message = (id: string, patch: Partial<Message> = {}): Message => ({
  id, chatId: "channel", senderId: "self", outgoing: true, delivery: "sent", isChannelPost: true,
  sentAt: "2026-09-09T01:00:00Z", content: { kind: "text", text: "post" }, ...patch,
});

describe("message metadata semantics", () => {
  it("shows a pending clock, never a success check, before the delayed spinner appears", () => {
    const html = renderToStaticMarkup(createElement(MessageDeliveryStatus, {
      messages: [message("pending", { delivery: "sending" })], onRetry: async () => {},
    }));
    expect(html).toContain('data-delivery="sending"');
    expect(html).toContain("lucide-clock");
    expect(html).not.toContain("lucide-check");
  });
  it("does not call a partially sent or failed album complete", () => {
    const sent = message("first");
    const pending = message("second", { delivery: "sending" });
    const failed = message("third", { delivery: "failed" });
    expect(messageDeliveryState([sent, pending], true)).toBe("sending");
    expect(messageDeliveryState([sent, pending, failed], true)).toBe("failed");
    expect(messageDeliveryState([sent, message("second", { delivery: "read" })])).toBe("sent");
  });

  it("keeps recipient read receipts separate from channel publication", () => {
    const read = message("read", { delivery: "read" });
    expect(messageDeliveryState([read])).toBe("read");
    expect(messageDeliveryState([read], true)).toBe("sent");
    expect(messageDeliveryState([message("incoming", { outgoing: false })])).toBeUndefined();
    expect(messageDeliveryState([])).toBeUndefined();
  });

  it("includes edits and pins on later items without summing repeated channel counters", () => {
    const first = message("first", { interaction: { viewCount: 200, forwardCount: 12, replyCount: 2, hasDiscussion: true, reactions: [] } });
    const second = message("second", { isPinned: true, editedAt: "2026-09-09T02:00:00Z",
      interaction: { viewCount: 200, forwardCount: 12, replyCount: 2, reactions: [] } });
    const metadata = mediaAlbumMetadataMessage([first, second]);
    expect(metadata).toMatchObject({ id: first.id, isPinned: true, editedAt: second.editedAt,
      interaction: { viewCount: 200, forwardCount: 12, replyCount: 2 } });
    expect(first.isPinned).toBeUndefined();
    expect(first.editedAt).toBeUndefined();
    expect(mediaAlbumMetadataMessage([])).toBeUndefined();
  });
});
