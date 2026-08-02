import type { Chat, GlobalSearchFilter, GlobalSearchPage, Message } from "../telegram/types";

export interface GlobalSearchState {
  query: string;
  filter: GlobalSearchFilter;
  chats: Chat[];
  messages: Message[];
  totalCount: number;
  nextOffset?: string;
  loading: boolean;
  error?: string;
}

export const emptyGlobalSearch = (
  query = "",
  filter: GlobalSearchFilter = "all",
): GlobalSearchState => ({
  query,
  filter,
  chats: [],
  messages: [],
  totalCount: 0,
  loading: false,
});

export const mergeGlobalSearchPage = (
  current: GlobalSearchState,
  page: GlobalSearchPage,
): GlobalSearchState => {
  const chats = [...new Map(
    [...current.chats, ...page.chats].map((chat) => [chat.id, chat]),
  ).values()];
  const messages = [...new Map(
    [...current.messages, ...page.messages].map((message) => [
      `${message.chatId}:${message.id}`,
      message,
    ]),
  ).values()];
  return {
    ...current,
    chats,
    messages,
    totalCount: page.totalCount !== undefined && page.totalCount >= 0
      ? page.totalCount
      : Math.max(current.totalCount, messages.length),
    nextOffset: page.nextOffset,
    loading: false,
    error: undefined,
  };
};
