import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { LoadedMessageThread, Message } from "../telegram/types";

export interface DiscussionHistoryState {
  loading: boolean;
  error?: boolean;
  retryMore?: boolean;
  replyChatId?: string;
  replyMessageId?: string;
  nextFromMessageId?: string;
  hasMore: boolean;
}

type Loader = (chatId: string, messageId: string, limit?: number, fromMessageId?: string) => Promise<LoadedMessageThread | undefined>;

/** Owns request deduplication and cursors; cached messages remain owned by the store. */
export function useChannelDiscussionHistory(loadPage: Loader, accountId?: string) {
  const [states, setStates] = useState<Record<string, DiscussionHistoryState>>({});
  const statesRef = useRef(states);
  const requests = useRef(new Map<string, Promise<void>>());
  const generation = useRef(0);
  useLayoutEffect(() => {
    statesRef.current = {};
    setStates({});
    return () => { generation.current += 1; requests.current.clear(); };
  }, [accountId]);
  const load = useCallback((post: Message, more = false) => {
    const key = `${post.chatId}:${post.id}`;
    const pending = requests.current.get(key);
    if (pending) return pending;
    const previous = statesRef.current[key];
    if (more && !previous?.hasMore) return Promise.resolve();
    const currentGeneration = generation.current;
    const update = (state: DiscussionHistoryState) => {
      if (generation.current !== currentGeneration) return;
      statesRef.current = { ...statesRef.current, [key]: state };
      setStates(statesRef.current);
    };
    const before = more ? previous?.nextFromMessageId : undefined;
    const loading: DiscussionHistoryState = { ...previous, hasMore: previous?.hasMore ?? true, loading: true, error: false, retryMore: more };
    update(loading);
    const operation = Promise.resolve().then(() => loadPage(post.chatId, post.id, 100, before)).then(page => {
      if (!page || page.error) {
        update({ ...loading, loading: false, error: true,
          replyChatId: page?.chatId ?? previous?.replyChatId,
          replyMessageId: page?.messageId ?? previous?.replyMessageId });
        return;
      }
      // Refreshing after a send must not discard the older-history cursor.
      const preserveCursor = !more && previous?.nextFromMessageId;
      update({ loading: false, replyChatId: page.chatId, replyMessageId: page.messageId,
        nextFromMessageId: preserveCursor ? previous.nextFromMessageId : page.nextFromMessageId,
        hasMore: preserveCursor ? previous.hasMore : page.hasMore });
    }).catch(() => update({ ...loading, loading: false, error: true })).finally(() => {
      if (requests.current.get(key) === operation) requests.current.delete(key);
    });
    requests.current.set(key, operation);
    return operation;
  }, [loadPage]);
  return { states, load };
}
