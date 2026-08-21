import type { CachedTelegramSnapshot, Chat, ChatProfile, ForumTopic, LocalAttachmentDraft, Message, QueuedOutgoingAttachment } from "../telegram/types";
import { logPerformance } from "../utils/performanceMonitor";
import type { TelegramState } from "./telegramStore.types";

export const TELEGRAM_CACHE_VERSION = 3 as const;
const MAX_CACHED_MESSAGES_PER_CHAT = 60;
const MAX_CACHED_MESSAGES = 5_000;
const MAX_CACHED_FORUM_CHATS = 20;
const MAX_CACHED_TOPICS_PER_FORUM = 100;
const MAX_CACHED_FORUM_TOPIC_BYTES = 256 * 1_024;
const MAX_CACHED_FORUM_SELECTIONS = 100;
const CACHE_SNAPSHOT_LOG_THRESHOLD_MS = 8;

export type CacheHealth = "empty" | "healthy" | "migrated" | "invalid" | "rebuilt";

export interface CachedSnapshotMigration {
  health: Exclude<CacheHealth, "rebuilt">;
  snapshot?: CachedTelegramSnapshot;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasStringKey = (value: unknown, key: string) =>
  isRecord(value) && typeof value[key] === "string";

const isQueuedAttachment = (value: unknown): value is QueuedOutgoingAttachment =>
  isRecord(value) &&
  hasStringKey(value, "storageId") &&
  hasStringKey(value, "name") &&
  hasStringKey(value, "mimeType") &&
  hasStringKey(value, "fingerprint") &&
  typeof value.size === "number" && value.size >= 0 &&
  typeof value.lastModified === "number" && value.lastModified >= 0 &&
  typeof value.kind === "string" &&
  ["photo", "video", "audio", "animation", "document"].includes(value.kind) &&
  (value.thumbnailStorageId === undefined || typeof value.thumbnailStorageId === "string") &&
  (value.width === undefined || typeof value.width === "number") &&
  (value.height === undefined || typeof value.height === "number") &&
  (value.duration === undefined || typeof value.duration === "number") &&
  (value.title === undefined || typeof value.title === "string") &&
  (value.performer === undefined || typeof value.performer === "string") &&
  (value.hasSpoiler === undefined || typeof value.hasSpoiler === "boolean") &&
  (value.showCaptionAboveMedia === undefined || typeof value.showCaptionAboveMedia === "boolean");

const isLocalAttachmentDraft = (value: unknown): value is LocalAttachmentDraft =>
  isRecord(value) &&
  hasStringKey(value, "draftKey") &&
  hasStringKey(value, "chatId") &&
  hasStringKey(value, "batchId") &&
  hasStringKey(value, "updatedAt") &&
  (value.mode === "media" || value.mode === "file") &&
  typeof value.hasSpoiler === "boolean" &&
  typeof value.muteVideos === "boolean" &&
  Array.isArray(value.attachments) &&
  value.attachments.length > 0 &&
  value.attachments.every(isQueuedAttachment);

export const migrateCachedSnapshot = (value: unknown): CachedSnapshotMigration => {
  if (value === undefined || value === null) return { health: "empty" };
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
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
    (value.localAttachmentDrafts !== undefined && (
      !Array.isArray(value.localAttachmentDrafts) ||
      !value.localAttachmentDrafts.every(isLocalAttachmentDraft)
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
        (item.replyToMessageId === undefined || typeof item.replyToMessageId === "string") &&
        (item.replyQuote === undefined || (
          isRecord(item.replyQuote) &&
          typeof item.replyQuote.text === "string" &&
          typeof item.replyQuote.position === "number" &&
          Number.isInteger(item.replyQuote.position) &&
          item.replyQuote.position >= 0
        )) &&
        (item.kind === undefined || item.kind === "text" || item.kind === "attachments") &&
        (item.caption === undefined || typeof item.caption === "string") &&
        (item.error === undefined || typeof item.error === "string") &&
        (item.attachments === undefined || (
          Array.isArray(item.attachments) &&
          item.attachments.length > 0 &&
          item.attachments.every(isQueuedAttachment)
        ))
      )
    )) ||
    (value.activeChatId !== undefined && typeof value.activeChatId !== "string") ||
    (value.chatFilter !== undefined && typeof value.chatFilter !== "string") ||
    (value.forumTopics !== undefined && (
      !Array.isArray(value.forumTopics) ||
      !value.forumTopics.every((entry) =>
        hasStringKey(entry, "chatId") &&
        isRecord(entry) &&
        Array.isArray(entry.topics) &&
        entry.topics.every((topic) =>
          hasStringKey(topic, "id") &&
          hasStringKey(topic, "chatId") &&
          hasStringKey(topic, "name") &&
          isRecord(topic) &&
          topic.chatId === entry.chatId
        )
      )
    )) ||
    (value.lastForumTopicIds !== undefined && (
      !Array.isArray(value.lastForumTopicIds) ||
      !value.lastForumTopicIds.every((entry) =>
        hasStringKey(entry, "chatId") && hasStringKey(entry, "topicId")
      )
    )) ||
    (value.profiles !== undefined && (
      !Array.isArray(value.profiles) ||
      !value.profiles.every((profile) => hasStringKey(profile, "id"))
    ))
  ) {
    return { health: "invalid" };
  }

  return {
    health: value.version === TELEGRAM_CACHE_VERSION ? "healthy" : "migrated",
    snapshot: {
      ...(value as unknown as CachedTelegramSnapshot),
      version: TELEGRAM_CACHE_VERSION,
      outbox: value.version === 1 ? [] : (value.outbox ?? []),
      chats: (value.chats as unknown as Chat[]).map((chat) => {
        const result = {
          ...chat,
          unreadMentionCount: Number.isFinite(chat.unreadMentionCount)
            ? Math.max(0, chat.unreadMentionCount)
            : 0,
        };
        delete result.management;
        delete result.canCreateTopics;
        return result;
      }),
      forumTopics: value.version === 3 ? (value.forumTopics ?? []) : [],
      lastForumTopicIds: value.version === 3 ? (value.lastForumTopicIds ?? []) : [],
    },
  };
};

const TRANSFER_STATE_KEYS = [
  "isDownloading",
  "isUploading",
  "uploadedSize",
  "progress",
  "thumbnailIsDownloading",
] as const;

const stripTransferState = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripTransferState);
  if (!value || typeof value !== "object") return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of TRANSFER_STATE_KEYS) delete copy[key];
  for (const [key, child] of Object.entries(copy)) copy[key] = stripTransferState(child);
  return copy;
};

const cacheableMessage = (message: Message): Message => {
  const result = { ...message };
  if (
    result.content.kind === "file" ||
    result.content.kind === "media" ||
    result.content.kind === "rich"
  ) {
    result.content = stripTransferState(result.content) as Message["content"];
  }
  delete result.renderKey;
  delete result.permissions;
  delete result.isRemoving;
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

const cacheableChat = (chat: Chat): Chat => {
  const result = { ...chat };
  delete result.management;
  delete result.canCreateTopics;
  return result;
};

const forumTopicsForCache = (state: TelegramState) => {
  const lastForumTopicIds = state.lastForumTopicIds ?? new Map<string, string>();
  const forumTopics = state.forumTopics ?? new Map();
  const seen = new Set<string>();
  const orderedChatIds = [
    state.activeChatId,
    ...[...lastForumTopicIds.keys()].reverse(),
    ...[...forumTopics.keys()].reverse(),
  ].filter((chatId): chatId is string => {
    if (!chatId || seen.has(chatId) || !forumTopics.get(chatId)?.length) return false;
    seen.add(chatId);
    return true;
  }).slice(0, MAX_CACHED_FORUM_CHATS);

  const encoder = new TextEncoder();
  const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const cachedGroups: Array<{ chatId: string; topics: ForumTopic[] }> = [];
  let totalBytes = 2;
  for (const chatId of orderedChatIds) {
    const topics = forumTopics.get(chatId);
    if (!topics?.length) continue;
    const cachedTopics: ForumTopic[] = [];
    let groupBytes = byteLength({ chatId, topics: [] });
    const groupSeparatorBytes = cachedGroups.length > 0 ? 1 : 0;
    for (const topic of topics.slice(0, MAX_CACHED_TOPICS_PER_FORUM)) {
      const cachedTopic = { ...topic };
      delete cachedTopic.lastMessage;
      delete cachedTopic.draft;
      const topicBytes = byteLength(cachedTopic) + (cachedTopics.length > 0 ? 1 : 0);
      if (totalBytes + groupSeparatorBytes + groupBytes + topicBytes > MAX_CACHED_FORUM_TOPIC_BYTES) break;
      cachedTopics.push(cachedTopic);
      groupBytes += topicBytes;
    }
    if (cachedTopics.length === 0) continue;
    cachedGroups.push({ chatId, topics: cachedTopics });
    totalBytes += groupSeparatorBytes + groupBytes;
  }
  return cachedGroups;
};

const lastForumTopicIdsForCache = (state: TelegramState) => {
  const selections = [...(state.lastForumTopicIds ?? new Map<string, string>())];
  if (state.activeChatId) {
    const activeIndex = selections.findIndex(([chatId]) => chatId === state.activeChatId);
    if (activeIndex >= 0) selections.push(...selections.splice(activeIndex, 1));
  }
  return selections.slice(-MAX_CACHED_FORUM_SELECTIONS).map(([chatId, topicId]) => ({
    chatId,
    topicId,
  }));
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
    const recent = (state.messages.get(chatId) ?? []).filter((message) => !message.isPending).slice(
      -Math.min(MAX_CACHED_MESSAGES_PER_CHAT, remaining),
    );
    messages.push(...recent.map(cacheableMessage));
  }
  return messages;
};

export const cachedSnapshotFrom = (
  state: TelegramState,
  profiles: ChatProfile[] = [],
): CachedTelegramSnapshot => {
  const startedAt = performance.now();
  const snapshot: CachedTelegramSnapshot = {
    version: TELEGRAM_CACHE_VERSION,
    savedAt: new Date().toISOString(),
    currentUserId: state.currentUserId ?? "",
    users: [...state.users.values()],
    folders: state.folders,
    chats: [...state.chats.values()].map(cacheableChat),
    messages: recentMessagesForCache(state),
    drafts: [...state.drafts.values()],
    localAttachmentDrafts: [...(state.localAttachmentDrafts ?? new Map()).values()],
    outbox: state.outbox ?? [],
    activeChatId: state.activeChatId,
    chatFilter: state.chatFilter,
    profiles,
    forumTopics: forumTopicsForCache(state),
    lastForumTopicIds: lastForumTopicIdsForCache(state),
  };
  const durationMs = performance.now() - startedAt;
  if (durationMs >= CACHE_SNAPSHOT_LOG_THRESHOLD_MS) {
    logPerformance("ui_cache_snapshot", {
      startTimeMs: startedAt,
      durationMs,
      messageCount: snapshot.messages.length,
      chatCount: snapshot.chats.length,
      forumCount: snapshot.forumTopics?.length ?? 0,
    });
  }
  return snapshot;
};
