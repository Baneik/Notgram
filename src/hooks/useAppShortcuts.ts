import { useEffect, useRef } from "react";
import { preferencesStore } from "../store/preferencesStore";
import { telegramStore } from "../store/telegramStore";
import { forumTopicOrderStore, reconcileForumTopicOrder, visibleForumTopicIds } from "../store/forumTopicOrder";
import { filterAndSortChats } from "../store/telegramStore.selectors";
import { FORUM_ALL_TOPIC_ID } from "../telegram/types";
import { shortcutActionForEvent } from "../shortcuts/shortcuts";
import { activeModal, isAvailableFocusTarget } from "../utils/focusPolicy";
import { isBlockedWebviewShortcut } from "../utils/webviewGuards";

export function useAppShortcuts(selectChat: (id: string) => void, selectFolder: (id: string) => void, selectTopic: (id: string) => void) {
  const callbacks = useRef({ selectChat, selectFolder, selectTopic });
  callbacks.current = { selectChat, selectFolder, selectTopic };
  const startAtFirstChat = useRef(false);
  useEffect(() => {
    const unsubscribe = telegramStore.subscribe((state, previous) => {
      if (state.activeAccountId !== previous.activeAccountId || state.accountSwitching) {
        startAtFirstChat.current = false;
      } else if (state.chatFilter !== previous.chatFilter) {
        // The retained conversation is not the cursor in the newly opened folder.
        startAtFirstChat.current = true;
      } else if (state.activeChatId !== previous.activeChatId) {
        startAtFirstChat.current = false;
      }
    });
    let composing = false;
    const startComposition = () => { composing = true; };
    const endComposition = () => { composing = false; };
    const keydown = (event: KeyboardEvent) => {
      // WebView guards cancel browser defaults but forward registered app actions.
      if ((event.defaultPrevented && !isBlockedWebviewShortcut(event)) || composing || document.hidden) return;
      const action = shortcutActionForEvent(event, preferencesStore.getState().shortcuts);
      if (!action || action === "editLastMessage" || action === "toggleMediaSendMode") return;
      const state = telegramStore.getState();
      if (!state.chatListReady || !["ready", "preparing"].includes(state.authorization.kind) ||
        state.accountSwitching || activeModal() ||
        [...document.querySelectorAll<HTMLElement>('[role="menu"]')].some(isAvailableFocusTarget)) return;
      const topicNavigation = action === "previousTopic" || action === "nextTopic";
      if (topicNavigation && (!state.activeChatId || !state.chats.get(state.activeChatId)?.isForum)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const direction = action === "previousChat" || action === "previousFolder" || action === "previousTopic" ? -1 : 1;
      if (action === "previousChat" || action === "nextChat") {
        const chats = filterAndSortChats(state.chats.values(), state.chatFilter, "");
        const current = startAtFirstChat.current ? -1 : chats.findIndex(chat => chat.id === state.activeChatId);
        const target = chats[current < 0 ? 0 : Math.max(0, Math.min(chats.length - 1, current + direction))];
        if (target) startAtFirstChat.current = false;
        if (target && target.id !== state.activeChatId) callbacks.current.selectChat(target.id);
      } else if (topicNavigation) {
        const chatId = state.activeChatId!;
        const topics = state.forumTopics.get(chatId) ?? [];
        const order = forumTopicOrderStore.getState().records.find(record =>
          record.accountId === state.activeAccountId && record.chatId === chatId)?.topicIds ?? [];
        const ids = visibleForumTopicIds(reconcileForumTopicOrder(order, topics, true), topics);
        const active = state.activeTopicId ?? FORUM_ALL_TOPIC_ID;
        const current = ids.indexOf(active);
        const target = ids[current < 0 ? 0 : (current + direction + ids.length) % ids.length];
        if (target && target !== active) callbacks.current.selectTopic(target);
      } else {
        const folders = state.folders.filter(folder => folder.id !== "archive");
        const current = folders.findIndex(folder => folder.id === state.chatFilter);
        const target = folders[current < 0 ? 0 : Math.max(0, Math.min(folders.length - 1, current + direction))];
        if (target) callbacks.current.selectFolder(target.id);
      }
    };
    window.addEventListener("compositionstart", startComposition, true);
    window.addEventListener("compositionend", endComposition, true);
    window.addEventListener("blur", endComposition);
    window.addEventListener("keydown", keydown, true);
    return () => {
      unsubscribe();
      window.removeEventListener("compositionstart", startComposition, true);
      window.removeEventListener("compositionend", endComposition, true);
      window.removeEventListener("blur", endComposition);
      window.removeEventListener("keydown", keydown, true);
    };
  }, []);
  // A pointer selection also establishes the cursor, even if its chat is already open.
  return () => { startAtFirstChat.current = false; };
}
