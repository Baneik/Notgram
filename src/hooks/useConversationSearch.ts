import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessageSearchFilter, ChatMessageSearchInput, Message } from "../telegram/types";
import {
  chatMessageSearchCriteriaActive,
  chatMessageSearchFilterDisallowsQueryOrSender,
  localDateSearchRange,
} from "../telegram/messageSearch";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import { chatMessageSearchInputKey } from "../store/chatMessageSearchState";

export type ConversationSearchScope = "topic" | "chat";

interface ConversationSearchOptions {
  chatId?: string;
  topicId?: string;
  isForum?: boolean;
  messages: Message[];
  searchState: ChatMessageSearchState;
  onSearchMessages: (input: ChatMessageSearchInput) => Promise<void>;
  onClearSearch: () => void;
}

export const useConversationSearch = ({
  chatId,
  topicId,
  isForum = false,
  messages,
  searchState,
  onSearchMessages,
  onClearSearch,
}: ConversationSearchOptions) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilterState] = useState<ChatMessageSearchFilter>("all");
  const [senderId, setSenderId] = useState<string>();
  const [date, setDate] = useState("");
  const [scope, setScope] = useState<ConversationSearchScope>(topicId ? "topic" : "chat");
  const dateRange = useMemo(() => localDateSearchRange(date), [date]);
  const input = useMemo<ChatMessageSearchInput>(() => ({
    chatId: chatId ?? "",
    topicId: isForum && scope === "topic" ? topicId : undefined,
    query: query.trim(),
    senderId,
    filter,
    ...dateRange,
  }), [chatId, dateRange, filter, isForum, query, scope, senderId, topicId]);
  const active = Boolean(chatId && chatMessageSearchCriteriaActive(input));
  const stateMatchesInput = chatMessageSearchInputKey(searchState.input) === chatMessageSearchInputKey(input);
  const searchResults = stateMatchesInput ? searchState.messages : [];

  useEffect(() => {
    setOpen(false);
    setQuery("");
    setFilterState("all");
    setSenderId(undefined);
    setDate("");
    setScope(topicId ? "topic" : "chat");
    onClearSearch();
  }, [chatId, onClearSearch, topicId]);

  useEffect(() => {
    if (!open || !active || !chatId || !dateRange && date) return;
    const timer = globalThis.setTimeout(() => void onSearchMessages(input), 250);
    return () => globalThis.clearTimeout(timer);
  }, [active, chatId, date, dateRange, input, onSearchMessages, open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setFilterState("all");
    setSenderId(undefined);
    setDate("");
    setScope(topicId ? "topic" : "chat");
    onClearSearch();
  }, [onClearSearch, topicId]);

  const show = useCallback(() => setOpen(true), []);
  const toggle = useCallback(() => {
    if (open) close();
    else show();
  }, [close, open, show]);

  const setFilter = useCallback((next: ChatMessageSearchFilter) => {
    setFilterState(next);
    if (chatMessageSearchFilterDisallowsQueryOrSender(next)) {
      setQuery("");
      setSenderId(undefined);
    }
  }, []);

  const searchSender = useCallback((nextSenderId: string) => {
    setOpen(true);
    setFilterState("all");
    setQuery("");
    setDate("");
    setSenderId(nextSenderId);
  }, []);

  return {
    open,
    query,
    filter,
    senderId,
    date,
    scope,
    active,
    input,
    visibleMessages: messages,
    matchingMessages: searchResults,
    searchResults,
    stateMatchesInput,
    setQuery,
    setFilter,
    setSenderId,
    setDate,
    setScope,
    searchSender,
    close,
    show,
    toggle,
  };
};
