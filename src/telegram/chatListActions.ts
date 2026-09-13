import { translate } from "../i18n";
import type { Chat, User } from "./types";

export const chatListActions = (chat: Chat, peer?: User) => ({
  canMute: chat.kind === "direct" || chat.kind === "group" || chat.kind === "channel",
  isBot: chat.kind === "direct" && peer?.isBot === true,
  canDelete: chat.kind === "direct",
  deleteDisabled: chat.canDeleteForSelf !== true,
  canLeave: chat.kind === "group" || chat.kind === "channel",
  leaveDisabled: chat.isMember === false,
  leaveLabel: chat.kind === "channel" ? translate("退出频道") : translate("退出群组"),
});
