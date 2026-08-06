import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "../telegram/types";
import { messageContentText } from "../telegram/messageContent";
import { messageSearchMatches, parseMessageSearchQuery } from "../telegram/messageSearch";

export const useConversationSearch = (
  chatId: string | undefined,
  messages: Message[],
  onSearchMessages: (query: string) => Promise<void>,
) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matchingMessages = useMemo(() => {
    const normalized = query.trim();
    if (!normalized) return [];
    let pattern;
    try {
      pattern = parseMessageSearchQuery(normalized);
    } catch {
      return [];
    }
    return messages.filter((message) => {
      return messageSearchMatches(messageContentText(message.content), pattern);
    });
  }, [messages, query]);

  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [chatId]);

  useEffect(() => {
    const normalized = query.trim();
    if (!chatId || !normalized) return;
    const timer = globalThis.setTimeout(() => void onSearchMessages(normalized), 250);
    return () => globalThis.clearTimeout(timer);
  }, [chatId, onSearchMessages, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const show = useCallback(() => setOpen(true), []);

  const toggle = useCallback(() => {
    if (open) close();
    else show();
  }, [close, open, show]);

  return {
    open,
    query,
    visibleMessages: messages,
    matchingMessages,
    setQuery,
    close,
    show,
    toggle,
  };
};
