import type { Chat, User } from "../telegram/types";

export const formatConversationCount = (count: number, label: string) =>
  `${Math.max(0, Math.round(count)).toLocaleString("zh-CN")} 位${label}`;

export const conversationHeaderStatus = ({
  chat,
  peer,
  typingStatus,
  memberCount,
}: {
  chat: Chat;
  peer?: User;
  typingStatus?: string;
  memberCount?: number;
}) => {
  if (typingStatus) return typingStatus;
  if (chat.kind === "group" || chat.kind === "channel") {
    return memberCount === undefined
      ? "成员"
      : formatConversationCount(memberCount, "成员");
  }
  if (chat.kind === "direct" && peer?.isBot) {
    return chat.activeUserCount === undefined
      ? "活跃用户"
      : formatConversationCount(chat.activeUserCount, "活跃用户");
  }
  if (chat.kind === "saved") return "仅自己可见";
  return peer?.presence === "online" ? "在线" : peer?.lastSeenLabel ?? "最近不在线";
};
