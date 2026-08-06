import { describe, expect, it } from "vitest";
import type { Chat, Message, User } from "../telegram/types";
import { channelPostTargetFor, replyPreviewFor } from "./conversationMessages";

const linkedChannelPost = (overrides: Partial<Message> = {}): Message => ({
  id: "group-copy",
  chatId: "discussion-group",
  senderId: "chat:source-channel",
  outgoing: false,
  sentAt: "2026-08-06T10:00:00.000Z",
  delivery: "sent",
  forwardInfo: {
    origin: { kind: "channel", chatId: "source-channel", messageId: "source-message" },
    source: {
      chatId: "source-channel",
      messageId: "source-message",
      senderId: "chat:source-channel",
      outgoing: false,
    },
  },
  content: { kind: "text", text: "Linked channel post" },
  ...overrides,
});

describe("channel post targets", () => {
  it("links discussion-group copies back to their channel message", () => {
    expect(channelPostTargetFor(linkedChannelPost())).toEqual({
      chatId: "source-channel",
      messageId: "source-message",
    });
  });

  it("does not add a jump to ordinary forwards or the source post itself", () => {
    expect(channelPostTargetFor(linkedChannelPost({ senderId: "self" }))).toBeUndefined();
    expect(channelPostTargetFor(linkedChannelPost({ chatId: "source-channel" }))).toBeUndefined();
  });

  it("falls back to the forward source message id", () => {
    const message = linkedChannelPost();
    message.forwardInfo = {
      ...message.forwardInfo,
      origin: { kind: "channel", chatId: "source-channel" },
    };
    expect(channelPostTargetFor(message)).toEqual({
      chatId: "source-channel",
      messageId: "source-message",
    });
  });
});

describe("reply preview authors", () => {
  it("uses the current user's real name when another person quotes their message", () => {
    const currentUser: User = {
      id: "self",
      displayName: "林然",
      avatar: { label: "林", color: "#d16f45" },
      presence: "online",
    };
    const chat = {
      id: "chat-product",
      kind: "group",
      title: "产品讨论",
    } as Chat;
    const quoted = linkedChannelPost({
      id: "quoted-self",
      chatId: chat.id,
      senderId: currentUser.id,
      outgoing: true,
      forwardInfo: undefined,
    });
    const reply = linkedChannelPost({
      id: "reply",
      chatId: chat.id,
      senderId: "u-jules",
      replyTo: { kind: "message", messageId: quoted.id },
      forwardInfo: undefined,
    });

    expect(replyPreviewFor(
      reply,
      new Map([[quoted.id, quoted]]),
      new Map([[currentUser.id, currentUser]]),
      chat,
    )?.author).toBe("林然");
  });
});
