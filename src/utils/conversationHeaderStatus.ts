import { currentLanguage, translate } from "../i18n";
import type { Chat, User } from "../telegram/types";

export const formatConversationCount = (count: number, label: string) =>
  translate("{{value0}} 位{{value1}}", {
    value0: Math.max(0, Math.round(count)).toLocaleString(currentLanguage()),
    value1: label,
  });

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
      ? translate("成员")
      : formatConversationCount(memberCount, translate("成员"));
  }
  if (chat.kind === "direct" && peer?.isBot) {
    return chat.activeUserCount === undefined
      ? translate("活跃用户")
      : formatConversationCount(chat.activeUserCount, translate("活跃用户"));
  }
  if (chat.kind === "saved") return translate("仅自己可见");
  return peer?.presence === "online" ? translate("在线") : peer?.lastSeenLabel ?? translate("最近不在线");
};
