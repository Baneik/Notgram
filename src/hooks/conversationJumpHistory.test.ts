import { describe, expect, it } from "vitest";
import {
  popAvailableConversationJumpAnchor,
  pushConversationJumpAnchor,
} from "./conversationJumpHistory";

describe("conversation jump history", () => {
  it("keeps distinct anchors in navigation order and caps retained history", () => {
    const first = pushConversationJumpAnchor([], { messageId: "10", offset: 12 });
    const duplicate = pushConversationJumpAnchor(first, { messageId: "10", offset: 12.5 });
    const following = pushConversationJumpAnchor(duplicate, {
      messageId: "10",
      offset: 12.5,
      followLatest: true,
    });
    const capped = pushConversationJumpAnchor(following, { messageId: "20", offset: 24 }, 1);

    expect(duplicate).toEqual(first);
    expect(following).toHaveLength(2);
    expect(capped).toEqual([{ messageId: "20", offset: 24 }]);
  });

  it("pops newest-first and skips anchors no longer present in history", () => {
    const result = popAvailableConversationJumpAnchor([
      { messageId: "10", offset: 12 },
      { messageId: "missing", offset: 18 },
    ], new Set(["10"]));

    expect(result.anchor).toEqual({ messageId: "10", offset: 12 });
    expect(result.history).toEqual([]);
  });
});
