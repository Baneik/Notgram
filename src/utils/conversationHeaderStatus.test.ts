import { describe, expect, it } from "vitest";
import { conversationHeaderStatus } from "./conversationHeaderStatus";
import type { Chat } from "../telegram/types";

const chat = (kind: Chat["kind"], overrides: Partial<Chat> = {}): Chat => ({
  id: "chat",
  kind,
  folderIds: ["main"],
  title: "Chat",
  avatar: { label: "C", color: "#000" },
  preview: "",
  updatedAt: new Date(0).toISOString(),
  unreadCount: 0,
  pinned: false,
  muted: false,
  ...overrides,
});

describe("conversation header status", () => {
  it("temporarily replaces the member count while someone is typing", () => {
    expect(conversationHeaderStatus({ chat: chat("group"), memberCount: 12, typingStatus: "Mia 正在输入..." }))
      .toBe("Mia 正在输入...");
  });

  it("formats group members and bot active users", () => {
    expect(conversationHeaderStatus({ chat: chat("group"), memberCount: 1234 })).toBe("1,234 位成员");
    expect(conversationHeaderStatus({ chat: chat("direct", { activeUserCount: 42 }), peer: { id: "bot", displayName: "Bot", isBot: true, avatar: { label: "B", color: "#000" }, presence: "online" } }))
      .toBe("42 位活跃用户");
  });
});
