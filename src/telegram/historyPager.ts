import { asTdObjects, tdId, tdNumber, type TdObject } from "./tdlibMapper";
import { numericId } from "./tdlibRequests";

const MAX_CONSECUTIVE_STALLS = 3;

interface LoadHistoryWindowOptions {
  chatId: string;
  topicId?: string;
  targetCount: number;
  cursor: number;
  knownMessages: Map<string, TdObject>;
  request: (request: TdObject) => Promise<TdObject>;
  emitMessage: (message: TdObject) => void;
}

export interface LoadedHistoryWindow {
  loadedCount: number;
  messageIds: string[];
  cursor: number;
  exhausted: boolean;
}

export const loadHistoryWindow = async ({
  chatId,
  topicId,
  targetCount,
  cursor: initialCursor,
  knownMessages,
  request,
  emitMessage,
}: LoadHistoryWindowOptions): Promise<LoadedHistoryWindow> => {
  let loadedCount = 0;
  let windowCount = 0;
  const messageIds: string[] = [];
  const returnedIds = new Set<string>();
  let cursor = initialCursor;
  let requestCount = 0;
  let consecutiveStalls = 0;
  let exhausted = false;
  const maxRequestCount = targetCount + MAX_CONSECUTIVE_STALLS + 2;

  while (windowCount < targetCount && requestCount < maxRequestCount) {
    requestCount += 1;
    const response = await request({
      "@type": topicId ? "getForumTopicHistory" : "getChatHistory",
      chat_id: numericId(chatId),
      ...(topicId ? { forum_topic_id: numericId(topicId) } : { only_local: false }),
      from_message_id: cursor,
      offset: 0,
      limit: Math.min(100, targetCount - windowCount + (cursor ? 1 : 0)),
    });
    const rawPage = asTdObjects(response.messages);
    if (rawPage.length === 0) {
      exhausted = true;
      break;
    }

    let addedThisRequest = 0;
    for (const raw of rawPage) {
      const id = tdId(raw.id);
      if (id && !returnedIds.has(id)) {
        returnedIds.add(id);
        messageIds.push(id);
        // Revalidating a known message still fills the requested window.
        // Otherwise reconnecting a warm cache can scan hundreds of old pages.
        if (id !== String(initialCursor)) windowCount += 1;
      }
      if (id && !knownMessages.has(id)) addedThisRequest += 1;
      emitMessage(raw);
      if (id) knownMessages.set(id, raw);
    }
    loadedCount += addedThisRequest;

    const nextCursor = tdNumber(rawPage.at(-1)?.id);
    if (!nextCursor) {
      exhausted = true;
      break;
    }
    if (nextCursor === cursor) {
      consecutiveStalls += 1;
      if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) break;
      continue;
    }
    cursor = nextCursor;
    consecutiveStalls = 0;
  }

  return { loadedCount, messageIds, cursor, exhausted };
};
