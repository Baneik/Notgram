import { currentLanguage, translate } from "../i18n";
import { messageContentText } from "../telegram/messageContent";
import type { Chat, Message, User } from "../telegram/types";

const copyTimestamp = (date: Date) => new Intl.DateTimeFormat(currentLanguage(), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

const senderNameForCopy = (
  message: Message,
  users: ReadonlyMap<string, User>,
  chat: Chat,
  chats: ReadonlyMap<string, Chat>,
) => {
  const userName = users.get(message.senderId)?.displayName;
  if (userName) return userName;
  if (message.outgoing) return translate("你");
  if (message.senderId.startsWith("chat:")) {
    return chats.get(message.senderId.slice("chat:".length))?.title ?? translate("Telegram 用户");
  }
  return chat.kind === "direct" ? chat.title : translate("Telegram 用户");
};

const replyAuthorForCopy = (
  message: Message,
  messagesById: ReadonlyMap<string, Message>,
  users: ReadonlyMap<string, User>,
  chat: Chat,
  chats: ReadonlyMap<string, Chat>,
) => {
  if (!message.replyTo || message.replyTo.kind !== "message") return undefined;
  const target = message.replyTo.messageId ? messagesById.get(message.replyTo.messageId) : undefined;
  if (target) return senderNameForCopy(target, users, chat, chats);
  if (message.replyTo.outgoing) return translate("你");
  return undefined;
};

const quoteForCopy = (
  message: Message,
  messagesById: ReadonlyMap<string, Message>,
) => {
  if (!message.replyTo || message.replyTo.kind !== "message") return undefined;
  const quoted = message.replyTo.quote?.trim() || (
    message.replyTo.messageId ? messagesById.get(message.replyTo.messageId) : undefined
  )?.content;
  if (typeof quoted === "string") return quoted.trim() || undefined;
  return quoted ? messageContentText(quoted).trim() || undefined : undefined;
};

const quoteLines = (text: string) => text.split(/\r?\n/).map((line) => `> ${line}`);

/** Formats selected messages in a compact, readable transcript style. */
export const formatSelectedMessages = (
  messages: Message[],
  users: ReadonlyMap<string, User>,
  chat: Chat,
  chats: ReadonlyMap<string, Chat> = new Map(),
  messagesById: ReadonlyMap<string, Message> = new Map(messages.map((message) => [message.id, message])),
) => {
  return messages.map((message) => {
    const replyAuthor = replyAuthorForCopy(message, messagesById, users, chat, chats);
    const prefix = translate("[{{value0}}] {{value1}}{{value2}}:", {
      value0: copyTimestamp(new Date(message.sentAt)),
      value1: senderNameForCopy(message, users, chat, chats),
      value2: replyAuthor ? translate(" 回复 {{value0}}", { value0: replyAuthor }) : "",
    });
    const lines = [prefix];
    const quote = quoteForCopy(message, messagesById);
    if (quote) lines.push(...quoteLines(quote));
    const body = messageContentText(message.content).trim();
    if (body) {
      if (quote) lines.push(body);
      else return `${prefix}  ${body}`;
    }
    return lines.join("\n");
  }).join("\n");
};
