import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessageSearchInput } from "../telegram/types";
import { chatMessageSearchCriteriaActive } from "../telegram/messageSearch";
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
 * conversation scope and its optional sender criterion. The scope is explicit;
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
  const [senderId, setSenderId] = useState<string>();
  const chatId = scope.type === "chat" ? scope.chatId : undefined;
  const input = useMemo<ChatMessageSearchInput>(() => ({
    chatId: chatId ?? "",
    query: query.trim(),
    senderId,
    filter: "all",
  }), [chatId, query, senderId]);
  const active = Boolean(chatId && chatMessageSearchCriteriaActive(input));
  const stateMatchesInput = !active && !chatMessageSearch.input
    ? true
    : chatMessageSearchInputKey(chatMessageSearch.input) === chatMessageSearchInputKey(input);

  useEffect(() => {
    if (!chatId) return;
    if (!active) {
      onClearSearch();
      return;
    }
    const timer = globalThis.setTimeout(() => void onSearchMessages(input), 250);
    return () => globalThis.clearTimeout(timer);
  }, [active, chatId, input, onClearSearch, onSearchMessages]);

  const enterChat = useCallback((nextChatId: string, nextSenderId?: string) => {
    onClearSearch();
    setScope({ type: "chat", chatId: nextChatId });
    setSenderId(nextSenderId);
    onQueryChange("");
  }, [onClearSearch, onQueryChange]);

  const exitScope = useCallback((preserveQuery = false) => {
    onClearSearch();
    setScope({ type: "global" });
    setSenderId(undefined);
    if (!preserveQuery) onQueryChange("");
  }, [onClearSearch, onQueryChange]);

  return {
    scope,
    chatId,
    senderId,
    stateMatchesInput,
    enterChat,
    exitScope,
    setSenderId,
  };
};
