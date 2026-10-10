import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { useEffect, useMemo } from "react";
import { readAccountMetadata, subscribeAccountMetadata, writeAccountMetadata } from "./accountMetadata";
import type { ForumTopic } from "../telegram/types";

interface TopicOrderRecord { accountId: string; chatId: string; topicIds: string[] }
const STORAGE_KEY = "notgram:forum-topic-order:v1";
const MAX_RECORDS = 128;
const MAX_TOPICS = 1_000;
const writeRecords = (records: TopicOrderRecord[]) => {
  try { writeAccountMetadata(STORAGE_KEY, JSON.stringify(records)); }
  catch { globalThis.dispatchEvent(new Event("notgram:local-save-failed")); }
};

const readRecords = (): TopicOrderRecord[] => {
  try {
    const value: unknown = JSON.parse(readAccountMetadata(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is TopicOrderRecord => Boolean(record &&
      typeof record.accountId === "string" && typeof record.chatId === "string" &&
      Array.isArray(record.topicIds) && record.topicIds.every((id: unknown) => typeof id === "string")))
      .slice(-MAX_RECORDS).map(record => ({ ...record, topicIds: [...new Set(record.topicIds)].slice(0, MAX_TOPICS) }));
  } catch { return []; }
};

// Preserve the first observed positions. Server activity and pin updates do not
// move existing tabs; new topics are appended to the user's local order.
export const reconcileForumTopicOrder = (order: readonly string[], topics: readonly Pick<ForumTopic, "id">[]) =>
  [...new Set([...order, ...topics.map(topic => topic.id)])].slice(0, MAX_TOPICS);

export const forumTopicOrderStore = createStore<{
  records: TopicOrderRecord[];
  setOrder: (accountId: string, chatId: string, topicIds: string[]) => void;
}>((set, get) => ({
  records: readRecords(),
  setOrder: (accountId, chatId, topicIds) => {
    const normalized = [...new Set(topicIds)].slice(0, MAX_TOPICS);
    const current = get().records.find(record => record.accountId === accountId && record.chatId === chatId);
    if (current?.topicIds.length === normalized.length && current.topicIds.every((id, i) => id === normalized[i])) return;
    const records = [...get().records.filter(record => record !== current), { accountId, chatId, topicIds: normalized }].slice(-MAX_RECORDS);
    set({ records });
    writeRecords(records);
  },
}));
export const removeAccountForumTopicOrder = (accountId: string) => {
  const records = forumTopicOrderStore.getState().records.filter(record => record.accountId !== accountId);
  forumTopicOrderStore.setState({ records });
  writeRecords(records);
};
subscribeAccountMetadata(STORAGE_KEY, () => forumTopicOrderStore.setState({ records: readRecords() }));
export const useForumTopicOrder = (accountId: string, chatId: string) => useStore(forumTopicOrderStore,
  state => state.records.find(record => record.accountId === accountId && record.chatId === chatId)?.topicIds);

export function useOrderedForumTopics(accountId: string, chatId: string, topics: ForumTopic[]) {
  const order = useForumTopicOrder(accountId, chatId);
  const reconciled = useMemo(() => reconcileForumTopicOrder(order ?? [], topics), [order, topics]);
  useEffect(() => {
    if (topics.length > 0) forumTopicOrderStore.getState().setOrder(accountId, chatId, reconciled);
  }, [accountId, chatId, reconciled, topics.length]);
  return useMemo(() => {
    const byId = new Map(topics.map(topic => [topic.id, topic]));
    return reconciled.map(id => byId.get(id)).filter((topic): topic is ForumTopic => Boolean(topic && !topic.isHidden));
  }, [reconciled, topics]);
}
