import { describe, expect, it } from "vitest";
import type { Chat, User } from "../telegram/types";
import { filterFolderChats, type FolderChatFilter } from "./folderChatSelection";

const chat = (id: string, title: string, overrides: Partial<Chat> = {}): Chat => ({
  id, title, kind: "direct", folderIds: ["main"],
  avatar: { label: title[0], color: "#000" }, preview: "", updatedAt: new Date(0).toISOString(),
  unreadCount: 0, unreadMentionCount: 0, pinned: false, muted: false, ...overrides,
});
const users = new Map<string, User>([["bot", {
  id: "bot", displayName: "Assistant", isBot: true,
  avatar: { label: "A", color: "#000" }, presence: "offline",
}]]);
const filterIds = (chats: Chat[], filter: FolderChatFilter = "all", query = "", selected = new Set<string>()) =>
  filterFolderChats(chats, users, selected, query, filter, "en").map(({ id }) => id);

describe("folder chat selection", () => {
  const chats = [
    chat("direct", "Bot enthusiast"),
    chat("bot", "Assistant", { peerId: "bot" }),
    chat("group", "Community", { kind: "group", folderIds: ["main", "folder:work"] }),
    chat("forum", "Forum", { kind: "group", isForum: true }),
    chat("channel", "News", { kind: "channel" }),
    chat("saved", "Saved", { kind: "saved" }),
    chat("archived", "Archive", { kind: "group", folderIds: ["archive"] }),
  ];

  it.each<[FolderChatFilter, string[]]>([
    ["direct", ["direct"]], ["bot", ["bot"]], ["group", ["archived", "group", "forum"]],
    ["channel", ["channel"]], ["saved", ["saved"]],
    ["uncategorized", ["bot", "direct", "forum", "channel"]],
  ])("filters %s from confirmed chat and peer metadata", (filter, expected) => {
    expect(filterIds(chats, filter)).toEqual(expected);
  });

  it("intersects trimmed, case-insensitive search with type and keeps hidden selections", () => {
    const selected = new Set(["group", "bot"]);
    expect(filterIds(chats, "group", "  FOR  ", selected)).toEqual(["forum"]);
    expect(filterIds(chats, "bot", "community", selected)).toEqual([]);
    expect([...selected]).toEqual(["group", "bot"]);
    expect(filterIds(chats, "all", "", selected).slice(0, 2)).toEqual(["bot", "group"]);
  });

  it("keeps draft additions uncategorized until confirmed and respects every other folder", () => {
    const selected = new Set(["direct"]);
    expect(filterIds(chats, "uncategorized", "", selected)[0]).toBe("direct");
    expect(filterIds(chats.map((item) => item.id === "direct"
      ? { ...item, folderIds: ["main", "folder:another"] } : item), "uncategorized", "", selected))
      .not.toContain("direct");
    expect(filterIds([chat("none", "None", { folderIds: [] })], "uncategorized")).toEqual([]);
  });

  it("sorts selected chats first, names naturally, and equal names by stable ID despite live order changes", () => {
    const source = [chat("z", "Same"), chat("a", "same"), chat("10", "Room 10"), chat("2", "Room 2"), chat("selected", "Zed")];
    const selected = new Set(["selected"]);
    const expected = ["selected", "2", "10", "a", "z"];
    expect(filterIds(source, "all", "", selected)).toEqual(expected);
    const updated = [...source].reverse().map((item, index) => ({
      ...item, updatedAt: new Date(10_000 * index).toISOString(),
      pinned: index % 2 === 0, listOrderByFolder: { main: String(100 - index) }, unreadCount: index,
    }));
    expect(filterIds(updated, "all", "", selected)).toEqual(expected);
    expect(source.map(({ id }) => id)).toEqual(["z", "a", "10", "2", "selected"]);
  });
});
