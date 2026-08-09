import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Message } from "../telegram/types";

interface UsePinnedMessagesOptions {
  chat?: Chat;
  chatMessages: Message[];
  onLoadPinnedMessages: (chatId: string) => Promise<Message[]>;
}

const mergePinnedMessages = (loaded: Message[], chatMessages: Message[]) => {
  const byId = new Map<string, Message>();
  for (const message of loaded) byId.set(message.id, message);
  for (const message of chatMessages) {
    if (message.isPinned || byId.has(message.id)) byId.set(message.id, message);
  }
  return [...byId.values()]
    .filter((message) => message.isPinned)
    .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
};

export const usePinnedMessages = ({
  chat,
  chatMessages,
  onLoadPinnedMessages,
}: UsePinnedMessagesOptions) => {
  const chatId = chat?.id;
  const chatKind = chat?.kind;
  const [viewChatId, setViewChatId] = useState<string>();
  const [loadedState, setLoadedState] = useState<{
    chatId: string;
    messages: Message[];
  }>();
  const [loadingChatId, setLoadingChatId] = useState<string>();
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (targetChatId: string) => {
    const requestId = ++requestIdRef.current;
    setLoadingChatId(targetChatId);
    const loaded = await onLoadPinnedMessages(targetChatId);
    if (requestId === requestIdRef.current) {
      setLoadedState({ chatId: targetChatId, messages: loaded });
      setLoadingChatId(undefined);
    }
    return loaded;
  }, [onLoadPinnedMessages]);

  useEffect(() => {
    if (!chatId || (chatKind !== "group" && chatKind !== "channel")) {
      requestIdRef.current += 1;
      setLoadedState(undefined);
      setLoadingChatId(undefined);
      return;
    }
    setLoadedState({ chatId, messages: [] });
    void refresh(chatId);
    return () => {
      requestIdRef.current += 1;
    };
  }, [chatId, chatKind, refresh]);

  useEffect(() => {
    if (viewChatId && viewChatId !== chatId) setViewChatId(undefined);
  }, [chatId, viewChatId]);

  const loadedMessages = loadedState && loadedState.chatId === chatId
    ? loadedState.messages
    : [];
  const messages = useMemo(
    () => mergePinnedMessages(loadedMessages, chatMessages),
    [chatMessages, loadedMessages],
  );

  const openView = useCallback((knownMessages: Message[] = []) => {
    if (!chatId) return;
    if (knownMessages.length > 0) {
      setLoadedState({ chatId, messages: knownMessages });
    }
    setViewChatId(chatId);
    void refresh(chatId);
  }, [chatId, refresh]);

  const closeView = useCallback(() => setViewChatId(undefined), []);

  const removeLoadedMessage = useCallback((message: Message) => {
    setLoadedState((current) => current?.chatId === message.chatId
      ? { ...current, messages: current.messages.filter((item) => item.id !== message.id) }
      : current);
  }, []);

  return {
    messages,
    loading: Boolean(chatId && loadingChatId === chatId),
    viewOpen: Boolean(chatId && viewChatId === chatId),
    openView,
    closeView,
    removeLoadedMessage,
  };
};
