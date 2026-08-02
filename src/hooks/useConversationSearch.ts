import { useEffect, useMemo, useState } from "react";
import type { Message } from "../telegram/types";
import { messageContentText } from "../telegram/messageContent";

export const useConversationSearch = (
  chatId: string | undefined,
  messages: Message[],
  onSearchMessages: (query: string) => Promise<void>,
) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const visibleMessages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return messages;
    return messages.filter((message) => {
      return messageContentText(message.content).toLocaleLowerCase().includes(normalized);
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

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const toggle = () => {
    if (open) close();
    else setOpen(true);
  };

  return { open, query, visibleMessages, setQuery, close, toggle };
};
