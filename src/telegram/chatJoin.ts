import { translate } from "../i18n";
import { asTdObject, mapTdChat, tdId, tdNumber, type TdObject } from "./tdlibMapper";
import { telegramInviteLink } from "./telegramLinks";
import type { ChatInvitePreview, JoinChatInput, JoinChatResult } from "./types";

export const chatJoinKey = (input: JoinChatInput) => "chatId" in input
  ? `chat:${input.chatId}` : `invite:${telegramInviteLink(input.inviteLink) ?? input.inviteLink}`;

export function mapChatInvitePreview(raw: TdObject, inviteLink: string): ChatInvitePreview {
  if (raw["@type"] !== "chatInviteLinkInfo") throw new Error(translate("邀请链接无效或已过期"));
  const kind = asTdObject(raw.type)?.["@type"] === "inviteLinkChatTypeChannel" ? "channel" : "group";
  const chatId = tdId(raw.chat_id);
  const presentation = mapTdChat({ id: chatId || inviteLink, title: raw.title, photo: raw.photo });
  return {
    inviteLink,
    chatId: chatId && chatId !== "0" ? chatId : undefined,
    kind,
    title: presentation!.title,
    avatar: presentation!.avatar,
    description: typeof raw.description === "string" ? raw.description : "",
    memberCount: Math.max(0, tdNumber(raw.member_count) ?? 0),
    createsJoinRequest: raw.creates_join_request === true,
    requiresSubscription: Boolean(asTdObject(raw.subscription_info)),
  };
}

/** The pinned TDLib returns ChatJoinResult, not a chat or an unconditional ok. */
export function mapChatJoinResult(raw: TdObject): JoinChatResult {
  switch (raw["@type"]) {
    case "chatJoinResultSuccess": {
      const chatId = tdId(raw.chat_id);
      if (chatId && chatId !== "0") return { kind: "joined", chatId };
      break;
    }
    case "chatJoinResultRequestSent": return { kind: "requested" };
    case "chatJoinResultGuardBotApprovalRequired":
      throw new Error(translate("此会话需要机器人网页验证，Notgram 暂不支持该验证流程"));
    case "chatJoinResultDeclined": throw new Error(translate("加入请求已被拒绝"));
  }
  throw new Error(translate("Telegram 未确认加入结果"));
}

export function chatJoinError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/INVITE_HASH_(EXPIRED|INVALID|EMPTY)/.test(message)) return translate("邀请链接无效或已过期");
  if (/USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE/.test(message)) return translate("当前账号无法加入此会话");
  if (/CHANNELS_TOO_MUCH|USER_CHANNELS_TOO_MUCH/.test(message)) return translate("加入的群组和频道数量已达上限");
  if (/FLOOD_WAIT|Too Many Requests/i.test(message)) return translate("操作过于频繁，请稍后重试");
  return message && message !== "[object Object]" && message !== "undefined" ? message : translate("Telegram 链接无法打开");
}
