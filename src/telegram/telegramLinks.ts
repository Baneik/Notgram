import type { TelegramLinkTarget } from "./types";

const TELEGRAM_WEB_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

const WEB_ROUTE_TYPES = new Map<string, string>([
  ["addemoji", "internalLinkTypeStickerSet"],
  ["addlist", "internalLinkTypeChatFolderInvite"],
  ["addstickers", "internalLinkTypeStickerSet"],
  ["addtheme", "internalLinkTypeTheme"],
  ["auth", "internalLinkTypeAuthenticationCode"],
  ["bg", "internalLinkTypeBackground"],
  ["boost", "internalLinkTypeChatBoost"],
  ["confirmphone", "internalLinkTypePhoneNumberConfirmation"],
  ["giftcode", "internalLinkTypePremiumGiftCode"],
  ["invoice", "internalLinkTypeInvoice"],
  ["joinchat", "internalLinkTypeChatInvite"],
  ["login", "internalLinkTypeQrCodeAuthentication"],
  ["proxy", "internalLinkTypeProxy"],
  ["setlanguage", "internalLinkTypeLanguagePack"],
  ["share", "internalLinkTypeMessageDraft"],
  ["socks", "internalLinkTypeProxy"],
]);

const TG_ACTION_TYPES = new Map<string, string>([
  ["addlist", "internalLinkTypeChatFolderInvite"],
  ["addstickers", "internalLinkTypeStickerSet"],
  ["addtheme", "internalLinkTypeTheme"],
  ["bg", "internalLinkTypeBackground"],
  ["boost", "internalLinkTypeChatBoost"],
  ["confirmphone", "internalLinkTypePhoneNumberConfirmation"],
  ["invoice", "internalLinkTypeInvoice"],
  ["join", "internalLinkTypeChatInvite"],
  ["login", "internalLinkTypeQrCodeAuthentication"],
  ["msg", "internalLinkTypeMessageDraft"],
  ["passport", "internalLinkTypePassportDataRequest"],
  ["proxy", "internalLinkTypeProxy"],
  ["setlanguage", "internalLinkTypeLanguagePack"],
  ["socks", "internalLinkTypeProxy"],
]);

export const parseTelegramUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return parsed.protocol === "tg:" || TELEGRAM_WEB_HOSTS.has(host) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const incompatibleLabelFor = (linkType?: string) => {
  const normalized = linkType?.toLowerCase() ?? "";
  if (normalized.includes("theme") || normalized.includes("textcompositionstyle")) return "Telegram 主题链接";
  if (normalized.includes("sticker")) return "Telegram 贴纸包链接";
  if (normalized.includes("invite")) return "Telegram 邀请链接";
  if (normalized.includes("proxy")) return "Telegram 代理链接";
  if (normalized.includes("invoice") || normalized.includes("purchase") || normalized.includes("gift")) return "Telegram 支付或礼物链接";
  if (normalized.includes("webapp") || normalized.includes("game")) return "Telegram 小程序链接";
  if (normalized.includes("authentication") || normalized.includes("oauth") || normalized.includes("passport") || normalized.includes("login") || normalized.includes("confirmation")) return "Telegram 身份验证链接";
  if (normalized.includes("language")) return "Telegram 语言包链接";
  if (normalized.includes("background")) return "Telegram 背景链接";
  if (normalized.includes("call") || normalized.includes("videochat")) return "Telegram 通话链接";
  if (normalized.includes("bot")) return "Telegram 机器人操作链接";
  return "此 Telegram 链接";
};

export const unsupportedTelegramLink = (
  linkType?: string,
  reason = `${incompatibleLabelFor(linkType)}与 Notgram 不兼容`,
): TelegramLinkTarget => ({ kind: "unsupported", linkType, reason });

export const knownUnsupportedTelegramLink = (value: string): TelegramLinkTarget | undefined => {
  const parsed = parseTelegramUrl(value);
  if (!parsed) return undefined;
  if (parsed.protocol === "tg:") {
    const action = parsed.hostname.toLowerCase() || parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    if (!action || action === "resolve" || action === "privatepost" || action === "user") return undefined;
    return unsupportedTelegramLink(TG_ACTION_TYPES.get(action) ?? "internalLinkTypeUnknownDeepLink");
  }
  const firstPathPart = parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!firstPathPart) return unsupportedTelegramLink("internalLinkTypeUnknownDeepLink");
  if (firstPathPart.startsWith("+")) return unsupportedTelegramLink("internalLinkTypeChatInvite");
  if (firstPathPart.startsWith("$")) return unsupportedTelegramLink("internalLinkTypeInvoice");
  const linkType = WEB_ROUTE_TYPES.get(firstPathPart);
  return linkType ? unsupportedTelegramLink(linkType) : undefined;
};

export const isUnsupportedTelegramLink = (
  target: TelegramLinkTarget,
): target is Extract<TelegramLinkTarget, { kind: "unsupported" }> =>
  "kind" in target && target.kind === "unsupported";

export const isTelegramUserLink = (
  target: TelegramLinkTarget,
): target is Extract<TelegramLinkTarget, { kind: "user" }> =>
  "kind" in target && target.kind === "user";

export const isTelegramBotStartLink = (
  target: TelegramLinkTarget,
): target is Extract<TelegramLinkTarget, { kind: "botStart" }> =>
  "kind" in target && target.kind === "botStart";
