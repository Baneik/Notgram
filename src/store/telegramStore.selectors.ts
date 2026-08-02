import type { Chat } from "../telegram/types";
import type { ChatFilter, TelegramState } from "./telegramStore.types";

export const compareChats = (left: Chat, right: Chat) =>
  Number(right.pinned) - Number(left.pinned) ||
  new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
  (left.id === right.id ? 0 : left.id < right.id ? -1 : 1);

export const isChatPinnedInFolder = (chat: Chat, folderId: string) =>
  chat.pinnedFolderIds === undefined
    ? chat.pinned
    : chat.pinnedFolderIds.includes(folderId);

export const compareChatsInFolder = (folderId: string) => (left: Chat, right: Chat) =>
  Number(isChatPinnedInFolder(right, folderId)) - Number(isChatPinnedInFolder(left, folderId)) ||
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
    .sort(compareChatsInFolder(folderId));
};

export const selectVisibleChats = (state: TelegramState) =>
  filterAndSortChats(state.chats.values(), state.chatFilter, state.searchQuery);
