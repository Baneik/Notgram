import { translate } from "../i18n";
import type { Chat, Message, MessageContent, User } from "../telegram/types";
import { messageContentText, messageReplyText } from "../telegram/messageContent";
import { replyTargetMessage } from "../telegram/messageReplyTarget";

export type SenderChat = Pick<Chat, "title" | "avatar">;

export const projectSenderChats = (chats: readonly Chat[], previous?: ReadonlyMap<string, SenderChat>) => {
  // Sidebar counters and ordering do not change the identities rendered in
  // messages. Preserve the map so those updates do not redraw every bubble.
  if (previous?.size === chats.length && chats.every(chat => {
    const sender = previous.get(chat.id);
    return sender?.title === chat.title && sender.avatar === chat.avatar;
  })) return previous;
  return new Map(chats.map(chat => [chat.id, { title: chat.title, avatar: chat.avatar }]));
};

export interface ReplyPreview {
  author: string;
  text: string;
  chatId?: string;
  messageId?: string;
  isCurrentUser?: boolean;
  isAdministrator?: boolean;
  concealed?: boolean;
}

export type ForwardSourceNavigation =
  | { kind: "message"; chatId: string; messageId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "user"; userId: string };

export interface ForwardSource {
  label?: string;
  navigation?: ForwardSourceNavigation;
}

export const senderChatId = (senderId: string) =>
  senderId.startsWith("chat:") ? senderId.slice("chat:".length) : undefined;

export const isVisibleConversationMessage = (message: Message) =>
  message.content.kind !== "service" || message.content.event?.type !== "messagePinMessage";

export const senderNameForMessage = (
  message: Message,
  users: Map<string, User>,
  chat: Chat,
  chats?: Map<string, Chat>,
) => {
  const knownUserName = users.get(message.senderId)?.displayName;
  if (knownUserName) return knownUserName;
  if (message.outgoing) return translate("你");
  const senderChat = senderChatId(message.senderId);
  return users.get(message.senderId)?.displayName ??
    (senderChat ? chats?.get(senderChat)?.title : undefined) ??
    (chat.kind === "direct" ? chat.title : translate("Telegram 用户"));
};

export const forwardSourceFor = (
  message: Message,
  users: Map<string, User>,
  chats: Map<string, Chat>,
): ForwardSource | undefined => {
  const info = message.forwardInfo;
  if (!info) return undefined;
  const origin = info.origin;
  const sourceChatId = info.source?.chatId;
  const sourceMessageId = info.source?.messageId;
  if (isAutomaticChannelForward(message)) {
    if (sourceChatId && sourceMessageId) {
      return { navigation: { kind: "message", chatId: sourceChatId, messageId: sourceMessageId } };
    }
    if (origin?.kind === "channel" && origin.messageId) {
      return { navigation: { kind: "message", chatId: origin.chatId, messageId: origin.messageId } };
    }
    const channelChatId = sourceChatId ?? (origin?.kind === "channel" ? origin.chatId : undefined);
    return channelChatId
      ? { navigation: { kind: "chat", chatId: channelChatId } }
      : undefined;
  }
  const name = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? chats.get(origin.chatId)?.title ?? origin.authorSignature
        : undefined;
  const sourceName = info.source?.senderName ??
    (info.source?.chatId ? chats.get(info.source.chatId)?.title : undefined);
  const label = name ? translate("转发自 {{value0}}", { value0: name }) : sourceName ? translate("转发自 {{value0}}", { value0: sourceName }) : translate("已转发");
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
    return { author: translate("动态"), text: translate("回复了一条动态") };
  }
  const target = replyTargetMessage(message, messagesById);
  if (target) {
    return {
      author: senderNameForMessage(target, users, chat, chats),
      text: replySummary(target.content, message.replyTo.quote),
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
    author: hydratedAuthor || originAuthor || (message.replyTo.outgoing ? translate("你") : translate("回复消息")),
    text: replySummary(message.replyTo.content, message.replyTo.quote),
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

export const replySummary = (content?: MessageContent, quote?: string) => {
  const raw = quote?.trim() || (content ? messageReplyText(content) : translate("原消息不可用"));
  return raw.replace(/\s+/g, " ").trim();
};

export const serviceTargetSummary = (
  message: Message,
  messages: ReadonlyMap<string, Message>,
  blocked: ReadonlyMap<string, unknown>,
): string | undefined => {
  if (message.content.kind !== "service") return undefined;
  const target = message.content.event?.target;
  if (!target || (target.chatId && target.chatId !== message.chatId)) return undefined;
  const found = messages.get(target.messageId);
  // A service reference must not expose content hidden by local privacy preferences.
  return found && found.chatId === message.chatId && !blocked.has(found.senderId)
    ? messageSummary(found.content) : undefined;
};
