import { useEffect, useRef } from "react";
import { telegramStore } from "../store/telegramStore";
import { filterAndSortChats } from "../store/telegramStore.selectors";

export function useFolderNavigation(selectChat: (id: string) => void, clearChat: () => void, closeSearch: () => void) {
  const callbacks = useRef({ selectChat, clearChat, closeSearch });
  callbacks.current = { selectChat, clearChat, closeSearch };
  const pending = useRef<{ accountId: string; folderId: string } | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = telegramStore.subscribe(() => {
      if (!pending.current) return;
      // Store updates can arrive during a React commit; navigation owns its own
      // flushSync boundary and must run after that commit has finished.
      queueMicrotask(() => {
        const intent = pending.current;
        if (!intent) return;
        const state = telegramStore.getState();
        if (state.accountSwitching || state.activeAccountId !== intent.accountId ||
          state.chatFilter !== intent.folderId || state.activeChatId) {
          pending.current = undefined;
          return;
        }
        const chats = filterAndSortChats(state.chats.values(), intent.folderId, "");
        const target = chats.find(chat => chat.id === state.lastFolderChatIds.get(intent.folderId)) ?? chats[0];
        if (!target) return;
        pending.current = undefined;
        callbacks.current.selectChat(target.id);
      });
    });
    return () => { pending.current = undefined; unsubscribe(); };
  }, []);

  return (folderId: string) => {
    const state = telegramStore.getState();
    if (state.accountSwitching || !state.folders.some(folder => folder.id === folderId)) return;
    if (state.chatFilter === folderId) { callbacks.current.closeSearch(); return; }
    pending.current = undefined;
    callbacks.current.closeSearch();
    state.setChatFilter(folderId);
    const current = telegramStore.getState();
    const chats = filterAndSortChats(current.chats.values(), folderId, "");
    const target = chats.find(chat => chat.id === current.lastFolderChatIds.get(folderId)) ?? chats[0];
    if (target) {
      if (target.id !== current.activeChatId) callbacks.current.selectChat(target.id);
    } else {
      callbacks.current.clearChat();
      pending.current = { accountId: current.activeAccountId, folderId };
    }
  };
}
