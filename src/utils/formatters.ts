import { currentLanguage, translate } from "../i18n";

type DateFormat = "chatTime" | "chatDay" | "messageTime" | "messageDay" | "messageYear";
const dateFormats: Record<DateFormat, Intl.DateTimeFormatOptions> = {
  chatTime: { hour: "2-digit", minute: "2-digit", hour12: false },
  chatDay: { month: "numeric", day: "numeric" },
  messageTime: { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  messageDay: { month: "long", day: "numeric" },
  messageYear: { year: "numeric", month: "long", day: "numeric" },
};
let formattingContext = "";
let timeZone = "";
let timeZoneCheckedAt = -Infinity;
const formatters = new Map<DateFormat, Intl.DateTimeFormat>();
const messageTimes = new Map<string, string>();

const dateFormatter = (format: DateFormat) => {
  const now = Date.now();
  // A running desktop app must also notice an OS timezone change. Resolve it
  // once per minute rather than creating an Intl instance for every message.
  if (now < timeZoneCheckedAt || now - timeZoneCheckedAt >= 60_000) {
    timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    timeZoneCheckedAt = now;
  }
  const language = currentLanguage();
  const context = `${language}:${timeZone}`;
  if (context !== formattingContext) {
    formattingContext = context;
    formatters.clear();
    messageTimes.clear();
  }
  let formatter = formatters.get(format);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { ...dateFormats[format], timeZone });
    formatters.set(format, formatter);
  }
  return formatter;
};

export const formatChatTime = (isoDate: string) => {
  const date = new Date(isoDate);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return dateFormatter("chatTime").format(date);
  }
  return dateFormatter("chatDay").format(date);
};

export const formatMessageTime = (isoDate: string) => {
  const formatter = dateFormatter("messageTime");
  const cached = messageTimes.get(isoDate);
  if (cached !== undefined) {
    messageTimes.delete(isoDate);
    messageTimes.set(isoDate, cached);
    return cached;
  }
  const result = formatter.format(new Date(isoDate));
  messageTimes.set(isoDate, result);
  if (messageTimes.size > 2_048) messageTimes.delete(messageTimes.keys().next().value!);
  return result;
};

export const localDateKey = (isoDate: string) => {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export const formatMessageDay = (isoDate: string, now = new Date()) => {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return translate("日期未知");

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round(
    (today.getTime() - messageDay.getTime()) / 86_400_000,
  );
  if (dayDifference === 0) return translate("今天");
  if (dayDifference === 1) return translate("昨天");
  return dateFormatter(date.getFullYear() === now.getFullYear() ? "messageDay" : "messageYear").format(date);
};

export const formatCompactCount = (value: number) => {
  const count = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  if (count < 1_000) return String(count);
  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ];
  const unit = units.find(({ threshold }) => count >= threshold)!;
  const scaled = count / unit.threshold;
  const digits = scaled < 100 ? 1 : 0;
  return `${scaled.toFixed(digits).replace(/\.0$/, "")}${unit.suffix}`;
};

export const formatUnreadCount = (value: number) => {
  const count = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  return count > 999 ? "999+" : String(count);
};
