import { describe, expect, it } from "vitest";
import type { Chat, Message, User } from "../telegram/types";
import { formatSelectedMessages } from "./messageClipboard";

const chat = { kind: "group", title: "产品讨论" } as Chat;
const users = new Map<string, User>([["olivia", { displayName: "Olivia" } as User]]);

const textMessage = (id: string, text: string, sentAt = "2026-08-23T16:29:00+08:00"): Message => ({
  id,
  chatId: "chat-product",
  senderId: "olivia",
  outgoing: false,
  sentAt,
  delivery: "read",
  content: { kind: "text", text },
});

describe("selected message clipboard formatting", () => {
  it("keeps a normal message body on the sender line", () => {
    expect(formatSelectedMessages([textMessage("m-1", "真好啊，外面根本没有雨")], users, chat))
      .toContain("Olivia:  真好啊，外面根本没有雨");
    expect(formatSelectedMessages([textMessage("m-1", "真好啊，外面根本没有雨")], users, chat))
      .not.toMatch(/Olivia:\n/);
  });

  it("keeps reply quotes on their own lines before the body", () => {
    const quoted = textMessage("m-1", "原消息");
    const reply = {
      ...textMessage("m-2", "回复内容"),
      replyTo: { kind: "message" as const, messageId: quoted.id, quote: "原消息" },
    };
    expect(formatSelectedMessages([quoted, reply], users, chat)).toMatch(
      /Olivia 回复 Olivia:\n> 原消息\n回复内容/,
    );
  });
});
