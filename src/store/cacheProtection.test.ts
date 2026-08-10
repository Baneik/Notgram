import { describe, expect, it } from "vitest";
import { protectedCachePaths } from "./cacheProtection";

describe("protectedCachePaths", () => {
  it("deduplicates every local asset still referenced by current state", () => {
    const avatar = { label: "N", color: "#000", imagePath: "C:\\cache\\avatar.jpg" };
    const paths = protectedCachePaths({
      accounts: [{ id: "a", userId: "u", displayName: "User", avatar }],
      users: [{ id: "u", displayName: "User", presence: "online", avatar }],
      chats: [{
        id: "c",
        kind: "direct",
        folderIds: ["main"],
        title: "Chat",
        avatar,
        preview: "",
        updatedAt: "2026-08-03T00:00:00Z",
        unreadCount: 0,
        unreadMentionCount: 0,
        muted: false,
        pinned: false,
      }],
      messages: [[{
        id: "m",
        chatId: "c",
        senderId: "u",
        outgoing: false,
        sentAt: "2026-08-03T00:00:00Z",
        delivery: "read",
        content: {
          kind: "media",
          mediaType: "photo",
          fileName: "photo.jpg",
          sizeLabel: "1 KB",
          localPath: "C:\\cache\\photo.jpg",
          thumbnailPath: "C:\\cache\\thumb.jpg",
        },
      }]],
    });

    expect(paths).toEqual([
      "C:\\cache\\avatar.jpg",
      "C:\\cache\\photo.jpg",
      "C:\\cache\\thumb.jpg",
    ]);
  });
});
