import { describe, expect, it } from "vitest";
import type { Chat, Message, User } from "../telegram/types";
import {
  channelAuthorFor,
  displaysChannelMetadata,
  forwardLabelFor,
  isAutomaticChannelForward,
  replyPreviewFor,
} from "./conversationMessages";

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

describe("reply preview authors", () => {
  it("uses the hydrated sender identity when the replied message is outside the local cache", () => {
    const remoteAuthor: User = {
      id: "u-remote",
      displayName: "Remote Author",
      avatar: { label: "RA", color: "#667788" },
      presence: "offline",
    };
    const chat = {
      id: "chat-product",
      kind: "group",
      title: "Product",
    } as Chat;
    const reply = linkedChannelPost({
      id: "reply",
      chatId: chat.id,
      senderId: "u-jules",
      replyTo: {
        kind: "message",
        messageId: "outside-cache",
        senderId: remoteAuthor.id,
        content: { kind: "text", text: "Hydrated preview" },
      },
      forwardInfo: undefined,
    });

    expect(replyPreviewFor(
      reply,
      new Map(),
      new Map([[remoteAuthor.id, remoteAuthor]]),
      chat,
    )).toMatchObject({
      author: "Remote Author",
      text: "Hydrated preview",
      messageId: "outside-cache",
    });
  });

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

describe("channel message presentation", () => {
  it("recognizes linked-channel synchronization without hiding manual forwards", () => {
    const automatic = linkedChannelPost({
      forwardInfo: {
        origin: {
          kind: "channel",
          chatId: "source-channel",
          messageId: "source-message",
          authorSignature: "Editor",
        },
        source: {
          chatId: "source-channel",
          messageId: "source-message",
          senderId: "chat:source-channel",
          outgoing: false,
        },
      },
    });
    const chats = new Map<string, Chat>([["source-channel", {
      id: "source-channel",
      kind: "channel",
      title: "Release Notes",
    } as Chat]]);

    expect(isAutomaticChannelForward(automatic)).toBe(true);
    expect(displaysChannelMetadata(automatic)).toBe(true);
    expect(channelAuthorFor(automatic)).toBe("Editor");
    expect(forwardLabelFor(automatic, new Map(), chats)).toBeUndefined();

    const manual = { ...automatic, senderId: "member" };
    expect(isAutomaticChannelForward(manual)).toBe(false);
    expect(forwardLabelFor(manual, new Map(), chats)).toBe("转发自 Release Notes");
  });
});
