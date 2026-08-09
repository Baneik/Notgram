import type { Chat, Message, MessageContent, User } from "../telegram/types";
import { messageContentText } from "../telegram/messageContent";

export interface ReplyPreview {
  author: string;
  text: string;
  chatId?: string;
  messageId?: string;
  isCurrentUser?: boolean;
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

export const forwardLabelFor = (
  message: Message,
  users: Map<string, User>,
  chats: Map<string, Chat>,
) => {
  const info = message.forwardInfo;
  if (!info) return undefined;
  if (isAutomaticChannelForward(message)) return undefined;
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
  return name ? `转发自 ${name}` : sourceName ? `转发自 ${sourceName}` : "已转发";
};

export const isAutomaticChannelForward = (message: Message) => {
  const origin = message.forwardInfo?.origin;
  const source = message.forwardInfo?.source;
  if (
    origin?.kind !== "channel" || !source ||
    message.chatId === origin.chatId ||
    message.senderId !== `chat:${origin.chatId}` ||
    source.chatId !== origin.chatId
  ) return false;
  return !origin.messageId || !source.messageId || origin.messageId === source.messageId;
};

export const channelAuthorFor = (message: Message) => {
  if (message.authorSignature?.trim()) return message.authorSignature.trim();
  const origin = message.forwardInfo?.origin;
  return origin?.kind === "channel" && origin.authorSignature?.trim()
    ? origin.authorSignature.trim()
    : undefined;
};

export const displaysChannelMetadata = (message: Message) =>
  message.isChannelPost === true || isAutomaticChannelForward(message);

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
