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

export const channelPostTargetFor = (message: Message) => {
  const origin = message.forwardInfo?.origin;
  if (origin?.kind !== "channel" || message.chatId === origin.chatId) return undefined;
  if (senderChatId(message.senderId) !== origin.chatId) return undefined;
  const source = message.forwardInfo?.source;
  const messageId = origin.messageId ?? (
    source?.chatId === origin.chatId ? source.messageId : undefined
  );
  return messageId ? { chatId: origin.chatId, messageId } : undefined;
};

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
  const author = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? chats?.get(origin.chatId)?.title ?? origin.authorSignature
        : undefined;
  return {
    author: author || "回复消息",
    text: message.replyTo.quote ||
      (message.replyTo.content ? messageSummary(message.replyTo.content) : "原消息不可用"),
    chatId: message.replyTo.chatId ?? message.chatId,
    messageId: message.replyTo.messageId,
    isCurrentUser: origin?.kind === "user" && origin.userId === currentUserId,
  };
};

export const messageSummary = (content: MessageContent) => {
  const raw = messageContentText(content);
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
};
