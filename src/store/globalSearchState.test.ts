import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { emptyGlobalSearch, mergeGlobalSearchPage } from "./globalSearchState";

describe("global search page reducer", () => {
  it("deduplicates chats and messages while preserving first-page order", () => {
    const chat = mockSnapshot.chats[0];
    const firstMessage = mockSnapshot.messages[0];
    const secondMessage = mockSnapshot.messages[1];
    const initial = mergeGlobalSearchPage(emptyGlobalSearch("test"), {
      chats: [chat],
      messages: [firstMessage],
      nextOffset: "next",
    });
    const merged = mergeGlobalSearchPage(initial, {
      chats: [chat],
      messages: [firstMessage, secondMessage],
    });

    expect(merged.chats).toHaveLength(1);
    expect(merged.messages.map((message) => message.id)).toEqual([
      firstMessage.id,
      secondMessage.id,
    ]);
    expect(merged.nextOffset).toBeUndefined();
    expect(merged.totalCount).toBe(2);
  });
});
