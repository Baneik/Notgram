import type { Chat } from "../telegram/types";
import type { ChatFilter, TelegramState } from "./telegramStore.types";

export const compareChats = (left: Chat, right: Chat) =>
  Number(right.pinned) - Number(left.pinned) ||
  new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
  (left.id === right.id ? 0 : left.id < right.id ? -1 : 1);

export const filterAndSortChats = (
  chats: Iterable<Chat>,
  folderId: ChatFilter,
  searchQuery: string,
) => {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  return [...chats]
    .filter((chat) => normalizedQuery || chat.folderIds.includes(folderId))
    .filter((chat) => {
      if (!normalizedQuery) return true;
      return `${chat.title} ${chat.preview}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .sort(compareChats);
};

export const selectVisibleChats = (state: TelegramState) =>
  filterAndSortChats(state.chats.values(), state.chatFilter, state.searchQuery);
