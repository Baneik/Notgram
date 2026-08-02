import type { CachedTelegramSnapshot, Message } from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

export const TELEGRAM_CACHE_VERSION = 2 as const;
const MAX_CACHED_MESSAGES_PER_CHAT = 60;
const MAX_CACHED_MESSAGES = 5_000;

export type CacheHealth = "empty" | "healthy" | "migrated" | "invalid" | "rebuilt";

export interface CachedSnapshotMigration {
  health: Exclude<CacheHealth, "rebuilt">;
  snapshot?: CachedTelegramSnapshot;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasStringKey = (value: unknown, key: string) =>
  isRecord(value) && typeof value[key] === "string";

export const migrateCachedSnapshot = (value: unknown): CachedSnapshotMigration => {
  if (value === undefined || value === null) return { health: "empty" };
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return { health: "invalid" };
  }
  if (
    typeof value.savedAt !== "string" ||
    typeof value.currentUserId !== "string" ||
    !value.currentUserId ||
    !Array.isArray(value.users) ||
    !value.users.every((user) => hasStringKey(user, "id")) ||
    !Array.isArray(value.folders) ||
    !value.folders.every((folder) => hasStringKey(folder, "id")) ||
    !Array.isArray(value.chats) ||
    !value.chats.every((chat) => hasStringKey(chat, "id")) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(
      (message) => hasStringKey(message, "id") && hasStringKey(message, "chatId"),
    ) ||
    (value.drafts !== undefined && (
      !Array.isArray(value.drafts) ||
      !value.drafts.every((draft) => hasStringKey(draft, "chatId"))
    )) ||
    (value.outbox !== undefined && (
      !Array.isArray(value.outbox) ||
      !value.outbox.every((item) =>
        hasStringKey(item, "id") &&
        hasStringKey(item, "chatId") &&
        hasStringKey(item, "text") &&
        hasStringKey(item, "createdAt") &&
        isRecord(item) &&
        (item.status === "queued" || item.status === "failed") &&
        (item.replyToMessageId === undefined || typeof item.replyToMessageId === "string")
      )
    )) ||
    (value.activeChatId !== undefined && typeof value.activeChatId !== "string") ||
    (value.chatFilter !== undefined && typeof value.chatFilter !== "string")
  ) {
    return { health: "invalid" };
  }

  return {
    health: value.version === TELEGRAM_CACHE_VERSION ? "healthy" : "migrated",
    snapshot: {
      ...(value as unknown as CachedTelegramSnapshot),
      version: TELEGRAM_CACHE_VERSION,
      outbox: value.version === 1 ? [] : (value.outbox ?? []),
    },
  };
};

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
  outbox: state.outbox ?? [],
  activeChatId: state.activeChatId,
  chatFilter: state.chatFilter,
});
