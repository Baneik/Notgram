import { useRef, useSyncExternalStore } from "react";
import type { ChatFilter } from "../store/telegramStore";
import type { GlobalSearchFilter } from "../telegram/types";
import type { SidebarSearchScope } from "./useSidebarSearch";

export interface ConversationNavigationLocation {
  chatId?: string;
  topicId?: string;
  chatFilter: ChatFilter;
  searchQuery: string;
  searchScope: SidebarSearchScope;
  searchSenderId?: string;
  globalSearchFilter: GlobalSearchFilter;
  globalSearchPending: boolean;
  searchScrollTop: number;
  mobileChatOpen: boolean;
}

export interface ConversationNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ConversationNavigation {
  getState: () => ConversationNavigationState;
  subscribe: (listener: () => void) => () => void;
  initialize: (location: ConversationNavigationLocation) => void;
  reset: (location: ConversationNavigationLocation) => void;
  replace: (location: ConversationNavigationLocation) => void;
  push: (location: ConversationNavigationLocation) => void;
  goBack: () => ConversationNavigationLocation | undefined;
  goForward: () => ConversationNavigationLocation | undefined;
}

const sameLocation = (
  left: ConversationNavigationLocation | undefined,
  right: ConversationNavigationLocation,
) => Boolean(left &&
  left.chatId === right.chatId &&
  left.topicId === right.topicId &&
  left.chatFilter === right.chatFilter &&
  left.searchQuery === right.searchQuery &&
  left.searchScope.type === right.searchScope.type &&
  (left.searchScope.type !== "chat" || left.searchScope.chatId === (right.searchScope.type === "chat" ? right.searchScope.chatId : undefined)) &&
  left.searchSenderId === right.searchSenderId &&
  left.globalSearchFilter === right.globalSearchFilter &&
  left.globalSearchPending === right.globalSearchPending &&
  left.searchScrollTop === right.searchScrollTop &&
  left.mobileChatOpen === right.mobileChatOpen);

export const createConversationNavigation = (): ConversationNavigation => {
  let entries: ConversationNavigationLocation[] = [];
  let index = -1;
  let state: ConversationNavigationState = {
    canGoBack: false,
    canGoForward: false,
  };
  const listeners = new Set<() => void>();

  const updateState = () => {
    const nextState = {
      canGoBack: index > 0,
      canGoForward: index >= 0 && index < entries.length - 1,
    };
    if (
      nextState.canGoBack === state.canGoBack &&
      nextState.canGoForward === state.canGoForward
    ) return;
    state = nextState;
    for (const listener of listeners) listener();
  };

  const move = (delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= entries.length) return undefined;
    index = nextIndex;
    updateState();
    return entries[nextIndex];
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize: (location) => {
      if (index >= 0) return;
      entries = [location];
      index = 0;
      updateState();
    },
    reset: (location) => {
      entries = [location];
      index = 0;
      updateState();
    },
    replace: (location) => {
      if (index < 0) {
        entries = [location];
        index = 0;
      } else {
        entries[index] = location;
      }
      updateState();
    },
    push: (location) => {
      if (index < 0) {
        entries = [location];
        index = 0;
        updateState();
        return;
      }
      if (sameLocation(entries[index], location)) return;
      entries = entries.slice(0, index + 1);
      entries.push(location);
      index = entries.length - 1;
      updateState();
    },
    goBack: () => move(-1),
    goForward: () => move(1),
  };
};

export const useConversationNavigation = (): ConversationNavigation => {
  const navigationRef = useRef<ConversationNavigation | undefined>(undefined);
  navigationRef.current ??= createConversationNavigation();
  return navigationRef.current;
};

export const useConversationNavigationState = (
  navigation: Pick<ConversationNavigation, "getState" | "subscribe">,
) => useSyncExternalStore(navigation.subscribe, navigation.getState, navigation.getState);
