import type { ChatMessageSearchFilter, ChatMessageSearchInput } from "./types";

const FILTERS_WITHOUT_QUERY_OR_SENDER = new Set<ChatMessageSearchFilter>([
  "unreadMention",
  "unreadReaction",
  "unreadPollVote",
]);

export const normalizeMessageSearchQuery = (query: string) => query.trim();

export const messageSearchMatches = (value: string, query: string) => {
  const normalized = normalizeMessageSearchQuery(query);
  return Boolean(normalized) && value.toLocaleLowerCase().includes(normalized.toLocaleLowerCase());
};

export const chatMessageSearchFilterDisallowsQueryOrSender = (
  filter: ChatMessageSearchFilter,
) => FILTERS_WITHOUT_QUERY_OR_SENDER.has(filter);

export const chatMessageSearchCriteriaActive = (
  input: Pick<ChatMessageSearchInput, "query" | "senderId" | "filter" | "minDate" | "maxDate">,
) => Boolean(
  normalizeMessageSearchQuery(input.query ?? "") ||
  input.senderId ||
  (input.filter ?? "all") !== "all" ||
  input.minDate ||
  input.maxDate
);

export const localDateSearchRange = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  ) return undefined;
  return {
    minDate: Math.floor(start.getTime() / 1000),
    maxDate: Math.floor(end.getTime() / 1000) - 1,
  };
};
