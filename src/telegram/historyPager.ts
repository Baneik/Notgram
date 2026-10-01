import { asTdObjects, tdId, tdNumber, type TdObject } from "./tdlibMapper";
import { numericId } from "./tdlibRequests";

const MAX_CONSECUTIVE_STALLS = 3;

interface LoadHistoryWindowOptions {
  chatId: string;
  topicId?: string;
  targetCount: number;
  cursor: number;
  direction?: "older" | "newer";
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
  direction = "older",
  knownMessages,
  request,
  emitMessage,
}: LoadHistoryWindowOptions): Promise<LoadedHistoryWindow> => {
  if (direction === "newer") {
    const query = (cursor: number, offset: number) => request({
      "@type": topicId ? "getForumTopicHistory" : "getChatHistory",
      chat_id: numericId(chatId),
      ...(topicId ? { forum_topic_id: numericId(topicId) } : { only_local: false }),
      from_message_id: cursor, offset, limit: Math.min(100, targetCount + 1),
    });
    const staged = new Map<string, TdObject>();
    let boundaryReached = false;
    let cursor = initialCursor;
    let empty = 0;
    let stalls = 0;
    for (let attempt = 0; attempt < targetCount + 5; attempt++) {
      const response = await query(cursor, cursor === initialCursor ? -Math.min(99, targetCount) : 0);
      const page = asTdObjects(response.messages);
      const newer = page.filter(raw => (tdNumber(raw.id) ?? 0) > initialCursor);
      for (const raw of newer) staged.set(tdId(raw.id), raw);
      boundaryReached = page.some(raw => (tdNumber(raw.id) ?? 0) <= initialCursor);
      if (boundaryReached && staged.size > 0) break;
      if (!page.length || (boundaryReached && !newer.length)) {
        if (++empty >= 2) break;
        await new Promise(resolve => globalThis.setTimeout(resolve, 100));
        continue;
      }
      const nextCursor = tdNumber(page.at(-1)?.id) ?? cursor;
      if (nextCursor === cursor) {
        if (++stalls >= MAX_CONSECUTIVE_STALLS) break;
        await new Promise(resolve => globalThis.setTimeout(resolve, 100));
      } else { cursor = nextCursor; stalls = 0; }
    }
    // A short negative-offset response may start above the requested boundary.
    // Walk it back before committing, then emit the nearest newer records first.
    if (!boundaryReached && staged.size) return {
      loadedCount: 0, messageIds: [], cursor: initialCursor, exhausted: false, stalled: true,
    };
    const accepted = [...staged.values()].sort((left, right) => tdNumber(left.id)! - tdNumber(right.id)!).slice(0, targetCount);
    for (const raw of accepted) emitMessage(raw);
    return { loadedCount: accepted.filter(raw => !knownMessages.has(tdId(raw.id))).length,
      messageIds: accepted.map(raw => tdId(raw.id)), cursor: tdNumber(accepted.at(-1)?.id) ?? initialCursor,
      exhausted: empty >= 2 && accepted.length === 0, stalled: stalls >= MAX_CONSECUTIVE_STALLS };
  }
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
    let nextCursor: number | undefined;
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
      nextCursor = tdNumber(raw.id) ?? nextCursor;
      // Some responses omit the boundary message reserved by limit + 1.
      // Leave overflow for the next page and commit only the emitted cursor.
      if (windowCount >= targetCount) break;
    }
    loadedCount += addedThisRequest;

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
