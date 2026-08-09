import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChatMessageSearchFilter,
  ChatMessageSearchInput,
} from "../telegram/types";
import {
  chatMessageSearchCriteriaActive,
  chatMessageSearchFilterDisallowsQueryOrSender,
  localDateSearchRange,
} from "../telegram/messageSearch";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import { chatMessageSearchInputKey } from "../store/chatMessageSearchState";

export type SidebarSearchScope =
  | { type: "global" }
  | { type: "chat"; chatId: string };

interface SidebarSearchOptions {
  query: string;
  chatMessageSearch: ChatMessageSearchState;
  onQueryChange: (query: string) => void;
  onSearchMessages: (input: ChatMessageSearchInput) => Promise<void>;
  onClearSearch: () => void;
}

/**
 * Keeps the sidebar query in the root store while owning the optional
 * conversation scope and its message-search filters. The scope is explicit;
 * changing the active conversation cannot silently change an in-flight search.
 */
export const useSidebarSearch = ({
  query,
  chatMessageSearch,
  onQueryChange,
  onSearchMessages,
  onClearSearch,
}: SidebarSearchOptions) => {
  const [scope, setScope] = useState<SidebarSearchScope>({ type: "global" });
  const [filter, setFilterState] = useState<ChatMessageSearchFilter>("all");
  const [senderId, setSenderId] = useState<string>();
  const [date, setDate] = useState("");
  const dateRange = useMemo(() => localDateSearchRange(date), [date]);
  const chatId = scope.type === "chat" ? scope.chatId : undefined;
  const input = useMemo<ChatMessageSearchInput>(() => ({
    chatId: chatId ?? "",
    query: chatMessageSearchFilterDisallowsQueryOrSender(filter) ? "" : query.trim(),
    senderId: chatMessageSearchFilterDisallowsQueryOrSender(filter) ? undefined : senderId,
    filter,
    ...dateRange,
  }), [chatId, dateRange, filter, query, senderId]);
  const active = Boolean(chatId && chatMessageSearchCriteriaActive(input));
  const stateMatchesInput = !active && !chatMessageSearch.input
    ? true
    : chatMessageSearchInputKey(chatMessageSearch.input) === chatMessageSearchInputKey(input);

  useEffect(() => {
    if (!chatId) return;
    if (!active) {
      if (chatMessageSearch.input) onClearSearch();
      return;
    }
    const timer = globalThis.setTimeout(() => void onSearchMessages(input), 250);
    return () => globalThis.clearTimeout(timer);
  }, [active, chatId, chatMessageSearch.input, input, onClearSearch, onSearchMessages]);

  const enterChat = useCallback((nextChatId: string, nextSenderId?: string) => {
    onClearSearch();
    setScope({ type: "chat", chatId: nextChatId });
    setFilterState("all");
    setSenderId(nextSenderId);
    setDate("");
    onQueryChange("");
  }, [onClearSearch, onQueryChange]);

  const exitScope = useCallback((preserveQuery = false) => {
    onClearSearch();
    setScope({ type: "global" });
    setFilterState("all");
    setSenderId(undefined);
    setDate("");
    if (!preserveQuery) onQueryChange("");
  }, [onClearSearch, onQueryChange]);

  const setFilter = useCallback((nextFilter: ChatMessageSearchFilter) => {
    setFilterState(nextFilter);
    if (chatMessageSearchFilterDisallowsQueryOrSender(nextFilter)) {
      setSenderId(undefined);
      onQueryChange("");
    }
  }, [onQueryChange]);

  return {
    scope,
    chatId,
    filter,
    senderId,
    date,
    stateMatchesInput,
    enterChat,
    exitScope,
    setFilter,
    setSenderId,
    setDate,
  };
};
