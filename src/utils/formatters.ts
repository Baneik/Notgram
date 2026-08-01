export const formatChatTime = (isoDate: string) => {
  const date = new Date(isoDate);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
};

export const formatMessageTime = (isoDate: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(isoDate));

export const localDateKey = (isoDate: string) => {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export const formatMessageDay = (isoDate: string, now = new Date()) => {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "日期未知";

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round(
    (today.getTime() - messageDay.getTime()) / 86_400_000,
  );
  if (dayDifference === 0) return "今天";
  if (dayDifference === 1) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
};
