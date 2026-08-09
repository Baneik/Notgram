import type { Chat, Message, MessageContent, User } from "../telegram/types";
import { messageContentText } from "../telegram/messageContent";

export interface ReplyPreview {
  author: string;
  text: string;
  chatId?: string;
  messageId?: string;
  isCurrentUser?: boolean;
}

export type ForwardSourceNavigation =
  | { kind: "message"; chatId: string; messageId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "user"; userId: string };

export interface ForwardSource {
  label: string;
  navigation?: ForwardSourceNavigation;
}

export const senderChatId = (senderId: string) =>
  senderId.startsWith("chat:") ? senderId.slice("chat:".length) : undefined;

export const senderNameForMessage = (
  message: Message,
  users: Map<string, User>,
  chat: Chat,
  chats?: Map<string, Chat>,
) => {
  const knownUserName = users.get(message.senderId)?.displayName;
  if (knownUserName) return knownUserName;
  if (message.outgoing) return "你";
  const senderChat = senderChatId(message.senderId);
  return users.get(message.senderId)?.displayName ??
    (senderChat ? chats?.get(senderChat)?.title : undefined) ??
    (chat.kind === "direct" ? chat.title : "Telegram 用户");
};

export const forwardSourceFor = (
  message: Message,
  users: Map<string, User>,
  chats: Map<string, Chat>,
): ForwardSource | undefined => {
  const info = message.forwardInfo;
  if (!info) return undefined;
  const origin = info.origin;
  const name = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? chats.get(origin.chatId)?.title ?? origin.authorSignature
        : undefined;
  const sourceName = info.source?.senderName ??
    (info.source?.chatId ? chats.get(info.source.chatId)?.title : undefined);
  const label = name ? `转发自 ${name}` : sourceName ? `转发自 ${sourceName}` : "已转发";
  const sourceChatId = info.source?.chatId;
  const sourceMessageId = info.source?.messageId;
  if (sourceChatId && sourceMessageId) {
    return { label, navigation: { kind: "message", chatId: sourceChatId, messageId: sourceMessageId } };
  }
  if (origin?.kind === "channel" && origin.messageId) {
    return { label, navigation: { kind: "message", chatId: origin.chatId, messageId: origin.messageId } };
  }
  if (sourceChatId) return { label, navigation: { kind: "chat", chatId: sourceChatId } };
  if (origin?.kind === "user") {
    return { label, navigation: { kind: "user", userId: origin.userId } };
  }
  if (origin?.kind === "chat" || origin?.kind === "channel") {
    return { label, navigation: { kind: "chat", chatId: origin.chatId } };
  }
  return { label };
};

export const forwardLabelFor = (
  message: Message,
  users: Map<string, User>,
  chats: Map<string, Chat>,
) => forwardSourceFor(message, users, chats)?.label;

export const replyPreviewFor = (
  message: Message,
  messagesById: Map<string, Message>,
  users: Map<string, User>,
  chat: Chat,
  chats?: Map<string, Chat>,
  currentUserId?: string,
): ReplyPreview | undefined => {
  if (!message.replyTo) return undefined;
  if (message.replyTo.kind === "story") {
    return { author: "动态", text: "回复了一条动态" };
  }
  const target = message.replyTo.messageId
    ? messagesById.get(message.replyTo.messageId)
    : undefined;
  if (target) {
    return {
      author: senderNameForMessage(target, users, chat, chats),
      text: messageSummary(target.content),
      chatId: target.chatId,
      messageId: target.id,
      isCurrentUser: target.outgoing,
    };
  }
  const origin = message.replyTo.origin;
  const repliedSenderChatId = message.replyTo.senderId
    ? senderChatId(message.replyTo.senderId)
    : undefined;
  const hydratedAuthor = message.replyTo.senderId
    ? users.get(message.replyTo.senderId)?.displayName ??
      (repliedSenderChatId ? chats?.get(repliedSenderChatId)?.title : undefined)
    : undefined;
  const originAuthor = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? chats?.get(origin.chatId)?.title ?? origin.authorSignature
        : undefined;
  return {
    author: hydratedAuthor || originAuthor || (message.replyTo.outgoing ? "你" : "回复消息"),
    text: message.replyTo.quote ||
      (message.replyTo.content ? messageSummary(message.replyTo.content) : "原消息不可用"),
    chatId: message.replyTo.chatId ?? message.chatId,
    messageId: message.replyTo.messageId,
    isCurrentUser: message.replyTo.senderId === currentUserId ||
      (origin?.kind === "user" && origin.userId === currentUserId) ||
      message.replyTo.outgoing === true,
  };
};

export const messageSummary = (content: MessageContent) => {
  const raw = messageContentText(content);
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
};
