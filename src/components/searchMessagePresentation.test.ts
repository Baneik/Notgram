import { describe, expect, it } from "vitest";
import type { Chat, Message, User } from "../telegram/types";
import { messageSearchSender, messageSearchSource } from "./searchMessagePresentation";

const avatar = (label: string) => ({ label, color: "#667788" });
const message = (senderId: string, outgoing = false): Message => ({
  id: "message-1",
  chatId: "group-1",
  senderId,
  outgoing,
  sentAt: "2026-08-16T08:00:00.000Z",
  delivery: "read",
  content: { kind: "text", text: "hello" },
});
const group: Chat = {
  id: "group-1",
  kind: "group",
  folderIds: ["main"],
  title: "Product group",
  avatar: avatar("P"),
  preview: "",
  updatedAt: "2026-08-16T08:00:00.000Z",
  unreadCount: 0,
  unreadMentionCount: 0,
  pinned: false,
  muted: false,
};
const user: User = {
  id: "user-1",
  displayName: "Mia",
  avatar: avatar("M"),
  presence: "offline",
};

describe("message search presentation", () => {
  it("uses the sender identity inside a chat and the chat identity globally", () => {
    const sender = messageSearchSender(
      message(user.id),
      new Map([[user.id, user]]),
      new Map([[group.id, group]]),
    );

    expect(sender).toEqual({ name: "Mia", avatar: user.avatar });
    expect(messageSearchSource(group, sender)).toEqual({
      name: "Product group",
      avatar: group.avatar,
    });
  });

  it("resolves chat senders and keeps a useful fallback for outgoing messages", () => {
    expect(messageSearchSender(
      message(`chat:${group.id}`),
      new Map(),
      new Map([[group.id, group]]),
    )).toEqual({ name: "Product group", avatar: group.avatar });
    expect(messageSearchSender(message("missing", true), new Map(), new Map()).name).toBe("我");
  });
});
