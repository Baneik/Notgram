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
  stalled: boolean;
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
  let consecutiveEmptyPages = 0;
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
      // TDLib documents a getHistory/deleteMessages race that can yield a
      // temporary empty response. Confirm the same boundary on a later turn.
      consecutiveEmptyPages += 1;
      if (consecutiveEmptyPages >= 2) {
        exhausted = true;
        break;
      }
      await new Promise(resolve => globalThis.setTimeout(resolve, 100));
      continue;
    }
    consecutiveEmptyPages = 0;

    let addedThisRequest = 0;
    for (const raw of rawPage) {
      const id = tdId(raw.id);
      if (id && !returnedIds.has(id)) {
        returnedIds.add(id);
        messageIds.push(id);
        // Revalidating a known message still fills the requested window.
        // Otherwise reconnecting a warm cache can scan hundreds of old pages.
        const numericMessageId = tdNumber(raw.id);
        if (numericMessageId && (!initialCursor || numericMessageId < initialCursor)) windowCount += 1;
      }
      if (id && !knownMessages.has(id)) addedThisRequest += 1;
      emitMessage(raw);
      if (id) knownMessages.set(id, raw);
    }
    loadedCount += addedThisRequest;

    const nextCursor = tdNumber(rawPage.at(-1)?.id);
    if (!nextCursor || (cursor !== 0 && nextCursor >= cursor)) {
      consecutiveStalls += 1;
      if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) break;
      // Boundary-only responses start TDLib's asynchronous prefetch. Tight
      // immediate retries otherwise read the same cache before it can finish.
      await new Promise(resolve => globalThis.setTimeout(resolve, consecutiveStalls * 100));
      continue;
    }
    cursor = nextCursor;
    consecutiveStalls = 0;
  }

  return { loadedCount, messageIds, cursor, exhausted, stalled: !exhausted && windowCount < targetCount };
};
