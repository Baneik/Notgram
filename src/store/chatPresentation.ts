import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { readAccountMetadata, subscribeAccountMetadata, writeAccountMetadata } from "./accountMetadata";

interface ChatPresentationRecord { accountId: string; chatId: string; hideMessageAvatars: true }
const STORAGE_KEY = "notgram:chat-presentation:v1";
const MAX_RECORDS = 1_000;

const readRecords = (): ChatPresentationRecord[] => {
  try {
    const value: unknown = JSON.parse(readAccountMetadata(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is ChatPresentationRecord => Boolean(record &&
      typeof record.accountId === "string" && typeof record.chatId === "string" &&
      record.hideMessageAvatars === true)).slice(-MAX_RECORDS);
  } catch { return []; }
};
const writeRecords = (records: ChatPresentationRecord[]) => {
  try { writeAccountMetadata(STORAGE_KEY, JSON.stringify(records)); }
  catch { globalThis.dispatchEvent(new Event("notgram:local-save-failed")); }
};

export const chatPresentationStore = createStore<{
  records: ChatPresentationRecord[];
  setMessageAvatarsHidden: (accountId: string, chatId: string, hidden: boolean) => void;
}>((set, get) => ({
  records: readRecords(),
  setMessageAvatarsHidden: (accountId, chatId, hidden) => {
    const current = get().records.find(record => record.accountId === accountId && record.chatId === chatId);
    if (Boolean(current) === hidden) return;
    const records = get().records.filter(record => record !== current);
    if (hidden) records.push({ accountId, chatId, hideMessageAvatars: true });
    const bounded = records.slice(-MAX_RECORDS);
    set({ records: bounded });
    writeRecords(bounded);
  },
}));

export const removeAccountChatPresentation = (accountId: string) => {
  const records = chatPresentationStore.getState().records.filter(record => record.accountId !== accountId);
  chatPresentationStore.setState({ records });
  writeRecords(records);
};

subscribeAccountMetadata(STORAGE_KEY, () => chatPresentationStore.setState({ records: readRecords() }));
export const useMessageAvatarsHidden = (accountId: string, chatId?: string) => useStore(chatPresentationStore,
  state => state.records.some(record => record.accountId === accountId && record.chatId === chatId));
