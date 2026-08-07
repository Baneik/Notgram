import type { Chat } from "../telegram/types";

export const MAX_RECENT_CONVERSATION_VIEWS = 5;

const isPinnedChat = (chat: Pick<Chat, "pinned" | "pinnedFolderIds">) =>
  chat.pinned || (chat.pinnedFolderIds?.length ?? 0) > 0;

/**
 * Returns the chat ids whose conversation view should stay mounted.
 * Pinned chats are always retained; recent ids are capped independently.
 */
export const conversationViewCacheIds = (
  chats: Iterable<Pick<Chat, "id" | "pinned" | "pinnedFolderIds">>,
  recentChatIds: readonly string[],
  activeChatId?: string,
) => {
  const availableChatIds = new Set<string>();
  const pinnedChatIds: string[] = [];
  for (const chat of chats) {
    availableChatIds.add(chat.id);
    if (isPinnedChat(chat)) pinnedChatIds.push(chat.id);
  }

  const knownChatIds = new Set<string>();
  const result: string[] = [];
  const retain = (chatId: string | undefined) => {
    if (!chatId || !availableChatIds.has(chatId) || knownChatIds.has(chatId)) return;
    knownChatIds.add(chatId);
    result.push(chatId);
  };

  pinnedChatIds.forEach(retain);
  for (const chatId of recentChatIds.slice(0, MAX_RECENT_CONVERSATION_VIEWS)) {
    retain(chatId);
  }
  retain(activeChatId);
  return result;
};
