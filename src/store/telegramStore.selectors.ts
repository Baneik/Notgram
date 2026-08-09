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

const listOrder = (chat: Chat, folderId: string) => {
  const value = chat.listOrderByFolder?.[folderId];
  if (!value || !/^-?\d+$/.test(value)) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

const compareListOrder = (left: Chat, right: Chat, folderId: string) => {
  const leftOrder = listOrder(left, folderId);
  const rightOrder = listOrder(right, folderId);
  return leftOrder === rightOrder ? 0 : leftOrder > rightOrder ? -1 : 1;
};

export const compareChatsInFolder = (folderId: string) => (left: Chat, right: Chat) =>
  Number(isChatPinnedInFolder(right, folderId)) - Number(isChatPinnedInFolder(left, folderId)) ||
  compareListOrder(left, right, folderId) ||
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
