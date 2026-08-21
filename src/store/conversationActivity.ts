import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Chat } from "../telegram/types";

export interface ConversationActivityRecord {
  accountId: string;
  chatId: string;
  sentMessageCount: number;
  activeDurationMs: number;
  updatedAt: string;
}

interface ConversationActivityState {
  records: ConversationActivityRecord[];
  recordSentMessages: (accountId: string, chatId: string, count?: number) => void;
  addActiveDuration: (accountId: string, chatId: string, durationMs: number) => void;
}

const STORAGE_KEY = "notgram:conversation-activity:v1";
const MESSAGE_ACTIVITY_WEIGHT_MS = 60_000;
const MAX_RECORDS = 1_000;

const isActivityRecord = (value: unknown): value is ConversationActivityRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConversationActivityRecord>;
  return typeof record.accountId === "string" &&
    typeof record.chatId === "string" &&
    Number.isSafeInteger(record.sentMessageCount) &&
    record.sentMessageCount! >= 0 &&
    Number.isFinite(record.activeDurationMs) &&
    record.activeDurationMs! >= 0 &&
    typeof record.updatedAt === "string";
};

const readRecords = () => {
  try {
    const serialized = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!serialized) return [];
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isActivityRecord).slice(-MAX_RECORDS) : [];
  } catch {
    return [];
  }
};

const writeRecords = (records: ConversationActivityRecord[]) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Activity ranking remains available for the current session.
  }
};

const updateRecord = (
  records: ConversationActivityRecord[],
  accountId: string,
  chatId: string,
  update: (record: ConversationActivityRecord) => ConversationActivityRecord,
) => {
  const index = records.findIndex((record) =>
    record.accountId === accountId && record.chatId === chatId
  );
  const current = index >= 0 ? records[index]! : {
    accountId,
    chatId,
    sentMessageCount: 0,
    activeDurationMs: 0,
    updatedAt: new Date().toISOString(),
  };
  const nextRecord = update(current);
  const next = index >= 0
    ? records.map((record, recordIndex) => recordIndex === index ? nextRecord : record)
    : [...records, nextRecord];
  return next.length <= MAX_RECORDS
    ? next
    : [...next]
        .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
        .slice(-MAX_RECORDS);
};

export const conversationActivityScore = (
  record: Pick<ConversationActivityRecord, "sentMessageCount" | "activeDurationMs"> | undefined,
) => record
  ? record.sentMessageCount * MESSAGE_ACTIVITY_WEIGHT_MS + record.activeDurationMs
  : 0;

export const sortChatsByConversationActivity = (
  chats: Iterable<Chat>,
  accountId: string,
  records: readonly ConversationActivityRecord[],
) => {
  const scores = new Map(records
    .filter((record) => record.accountId === accountId)
    .map((record) => [record.chatId, conversationActivityScore(record)] as const));
  return [...chats].sort((left, right) =>
    (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
};

export const conversationActivityStore = createStore<ConversationActivityState>((set, get) => ({
  records: readRecords(),
  recordSentMessages: (accountId, chatId, count = 1) => {
    if (!accountId || !chatId || !Number.isSafeInteger(count) || count <= 0) return;
    const records = updateRecord(get().records, accountId, chatId, (record) => ({
      ...record,
      sentMessageCount: record.sentMessageCount + count,
      updatedAt: new Date().toISOString(),
    }));
    writeRecords(records);
    set({ records });
  },
  addActiveDuration: (accountId, chatId, durationMs) => {
    const normalizedDuration = Math.round(durationMs);
    if (!accountId || !chatId || !Number.isFinite(normalizedDuration) || normalizedDuration <= 0) return;
    const records = updateRecord(get().records, accountId, chatId, (record) => ({
      ...record,
      activeDurationMs: record.activeDurationMs + normalizedDuration,
      updatedAt: new Date().toISOString(),
    }));
    writeRecords(records);
    set({ records });
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    conversationActivityStore.setState({ records: readRecords() });
  });
}

export const recordConversationSentMessages = (
  accountId: string,
  chatId: string,
  count = 1,
) => conversationActivityStore.getState().recordSentMessages(accountId, chatId, count);

export const useConversationActivity = <T,>(
  selector: (state: ConversationActivityState) => T,
) => useStore(conversationActivityStore, selector);
