import type { CachedTelegramSnapshot, Message } from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

export const TELEGRAM_CACHE_VERSION = 1 as const;
const MAX_CACHED_MESSAGES_PER_CHAT = 60;
const MAX_CACHED_MESSAGES = 5_000;

const cacheableMessage = (message: Message): Message => {
  const result = { ...message };
  delete result.permissions;
  if (
    result.content.kind !== "media" ||
    !result.content.previewDataUrl ||
    result.content.previewDataUrl.length <= 32_768
  ) return result;
  return {
    ...result,
    content: { ...result.content, previewDataUrl: undefined },
  };
};

export const recentMessagesForCache = (state: TelegramState) => {
  const orderedChatIds = [...state.chats.values()]
    .sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )
    .map((chat) => chat.id);
  if (state.activeChatId) {
    const index = orderedChatIds.indexOf(state.activeChatId);
    if (index >= 0) orderedChatIds.splice(index, 1);
    orderedChatIds.unshift(state.activeChatId);
  }

  const messages: Message[] = [];
  for (const chatId of orderedChatIds) {
    const remaining = MAX_CACHED_MESSAGES - messages.length;
    if (remaining <= 0) break;
    const recent = (state.messages.get(chatId) ?? []).slice(
      -Math.min(MAX_CACHED_MESSAGES_PER_CHAT, remaining),
    );
    messages.push(...recent.map(cacheableMessage));
  }
  return messages;
};

export const cachedSnapshotFrom = (state: TelegramState): CachedTelegramSnapshot => ({
  version: TELEGRAM_CACHE_VERSION,
  savedAt: new Date().toISOString(),
  currentUserId: state.currentUserId ?? "",
  users: [...state.users.values()],
  folders: state.folders.filter((folder) => folder.id !== "archive"),
  chats: [...state.chats.values()],
  messages: recentMessagesForCache(state),
  drafts: [...state.drafts.values()],
  activeChatId: state.activeChatId,
  chatFilter: state.chatFilter,
});
