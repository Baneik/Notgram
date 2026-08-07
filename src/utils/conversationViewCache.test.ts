import { describe, expect, it } from "vitest";
import { conversationViewCacheIds } from "./conversationViewCache";

const chat = (id: string, pinned = false, pinnedFolderIds?: string[]) => ({
  id,
  pinned,
  pinnedFolderIds,
});

describe("conversation view cache", () => {
  it("retains every pinned chat and at most five recent chats", () => {
    const chats = [
      chat("pinned-main", true),
      chat("pinned-folder", false, ["folder:work"]),
      ...Array.from({ length: 7 }, (_, index) => chat(`recent-${index}`)),
      chat("active"),
    ];

    expect(conversationViewCacheIds(
      chats,
      ["recent-0", "recent-1", "recent-2", "recent-3", "recent-4", "recent-5"],
      "active",
    )).toEqual([
      "pinned-main",
      "pinned-folder",
      "recent-0",
      "recent-1",
      "recent-2",
      "recent-3",
      "recent-4",
      "active",
    ]);
  });

  it("deduplicates the active and pinned ids", () => {
    expect(conversationViewCacheIds(
      [chat("active", true), chat("other")],
      ["active", "other", "missing"],
      "active",
    )).toEqual(["active", "other"]);
  });
});
