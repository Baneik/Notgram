import type { Avatar, Chat, Message, User } from "../telegram/types";

export interface MessageSearchIdentity {
  name: string;
  avatar: Avatar;
}

const fallbackAvatar = (name: string): Avatar => ({
  label: Array.from(name.trim())[0] ?? "?",
  color: "#73828c",
});

export const messageSearchSender = (
  message: Message,
  users: ReadonlyMap<string, User>,
  chats: ReadonlyMap<string, Chat>,
): MessageSearchIdentity => {
  if (message.senderId.startsWith("chat:")) {
    const senderChat = chats.get(message.senderId.slice("chat:".length));
    const name = senderChat?.title ?? "群组账号";
    return { name, avatar: senderChat?.avatar ?? fallbackAvatar(name) };
  }

  const sender = users.get(message.senderId);
  if (sender) return { name: sender.displayName, avatar: sender.avatar };

  const name = message.outgoing || message.senderId === "self" ? "我" : "Telegram 用户";
  return { name, avatar: fallbackAvatar(name) };
};

export const messageSearchSource = (
  chat: Chat | undefined,
  sender: MessageSearchIdentity,
): MessageSearchIdentity => chat
  ? { name: chat.title, avatar: chat.avatar }
  : sender;
