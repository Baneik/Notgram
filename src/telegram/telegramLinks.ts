import { translate } from "../i18n";
import type { TelegramLinkTarget } from "./types";

const TELEGRAM_WEB_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);
const SCHEMELESS_TELEGRAM_URL = /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)(?=[/?#]|$)/i;
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

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
    const parsed = new URL(SCHEMELESS_TELEGRAM_URL.test(value) ? `https://${value}` : value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.protocol === "tg:" && !parsed.username && !parsed.password && !parsed.port) return parsed;
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      TELEGRAM_WEB_HOSTS.has(host) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    ) {
      parsed.protocol = "https:";
      parsed.hostname = host;
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const telegramUsernameFromUrl = (value: string) => {
  const parsed = parseTelegramUrl(value);
  if (!parsed) return undefined;
  if (parsed.protocol === "tg:") {
    if (parsed.hostname.toLowerCase() !== "resolve") return undefined;
    const parameters = [...parsed.searchParams.keys()];
    const username = parsed.searchParams.get("domain") ?? "";
    return parameters.length === 1 && parameters[0] === "domain" && TELEGRAM_USERNAME.test(username)
      ? username
      : undefined;
  }
  if (parsed.search || parsed.hash) return undefined;
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (pathParts.length !== 1) return undefined;
  let username: string;
  try {
    username = decodeURIComponent(pathParts[0]);
  } catch {
    return undefined;
  }
  if (WEB_ROUTE_TYPES.has(username.toLowerCase()) || !TELEGRAM_USERNAME.test(username)) {
    return undefined;
  }
  return username;
};

export const telegramUrlDisplayText = (value: string) => {
  const username = telegramUsernameFromUrl(value);
  return username ? parseTelegramUrl(value)?.protocol === "tg:" ? `t.me/${username}` : value : undefined;
};

/** Normalize invite aliases before they cross the native request boundary. */
export const telegramInviteLink = (value: string): string | undefined => {
  const parsed = parseTelegramUrl(value);
  if (!parsed) return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const hash = parsed.protocol === "tg:"
    ? parsed.hostname.toLowerCase() === "join" ? parsed.searchParams.get("invite") : undefined
    : parts.length === 1 && parts[0].startsWith("+") ? parts[0].slice(1)
      : parts.length === 2 && parts[0].toLowerCase() === "joinchat" ? parts[1] : undefined;
  return hash && /^[A-Za-z0-9_-]{1,256}$/.test(hash) ? `https://t.me/+${hash}` : undefined;
};

/** Keep reserved routes separate from usernames, including malformed pack links. */
export const telegramStickerSetName = (value: string): string | undefined => {
  const parsed = parseTelegramUrl(value);
  if (!parsed) return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const name = parsed.protocol === "tg:"
    ? parsed.hostname.toLowerCase() === "addstickers" ? parsed.searchParams.get("set") : undefined
    : parts.length === 2 && parts[0].toLowerCase() === "addstickers" ? parts[1] : undefined;
  return name && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : undefined;
};

const incompatibleLabelFor = (linkType?: string) => {
  const normalized = linkType?.toLowerCase() ?? "";
  if (normalized.includes("theme") || normalized.includes("textcompositionstyle")) return translate("Telegram 主题链接");
  if (normalized.includes("sticker")) return translate("Telegram 贴纸包链接");
  if (normalized.includes("invite")) return translate("Telegram 邀请链接");
  if (normalized.includes("proxy")) return translate("Telegram 代理链接");
  if (normalized.includes("invoice") || normalized.includes("purchase") || normalized.includes("gift")) return translate("Telegram 支付或礼物链接");
  if (normalized.includes("webapp") || normalized.includes("game")) return translate("Telegram 小程序链接");
  if (normalized.includes("authentication") || normalized.includes("oauth") || normalized.includes("passport") || normalized.includes("login") || normalized.includes("confirmation")) return translate("Telegram 身份验证链接");
  if (normalized.includes("language")) return translate("Telegram 语言包链接");
  if (normalized.includes("background")) return translate("Telegram 背景链接");
  if (normalized.includes("call") || normalized.includes("videochat")) return translate("Telegram 通话链接");
  if (normalized.includes("bot")) return translate("Telegram 机器人操作链接");
  return translate("此 Telegram 链接");
};

export const unsupportedTelegramLink = (
  linkType?: string,
  reason = translate("{{value0}}与 Notgram 不兼容", { value0: incompatibleLabelFor(linkType) }),
): TelegramLinkTarget => ({ kind: "unsupported", linkType, reason });

export const knownUnsupportedTelegramLink = (value: string): TelegramLinkTarget | undefined => {
  const parsed = parseTelegramUrl(value);
  if (!parsed) return undefined;
  if (telegramStickerSetName(value)) return undefined;
  if (telegramInviteLink(value)) return undefined;
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
