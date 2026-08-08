import type { TelegramTransport } from "../telegram/transport";
import { isRegexMessageSearchQuery } from "../telegram/messageSearch";
import type { GlobalSearchFilter } from "../telegram/types";
import { emptyGlobalSearch, mergeGlobalSearchPage } from "./globalSearchState";
import type { TelegramState } from "./telegramStore.types";

type StoreState = Pick<
  TelegramState,
  | "activeChatId"
  | "activeTopicId"
  | "authorization"
  | "globalSearch"
  | "searchQuery"
  | "chatFilter"
>;

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface SearchController {
  searchChatMessages: (query: string) => Promise<void>;
  searchGlobal: (query: string, filter?: GlobalSearchFilter) => Promise<void>;
  loadMoreGlobalSearch: () => Promise<void>;
  cancelGlobalSearch: () => void;
  clearGlobalSearch: () => void;
  setSearchQuery: (query: string) => void;
  reset: () => void;
}

export interface SearchControllerOptions {
  transport: TelegramTransport;
  get: () => StoreState;
  set: StoreSetter;
  loadChats: (chatListId?: string) => Promise<void>;
  onError: (error: unknown, fallback: string) => string;
}

/**
 * Owns search request generations and debounce timers so the root store only
 * coordinates state and transport wiring. Every request is still guarded by
 * the same generation checks as the original implementation.
 */
export const createSearchController = ({
  transport,
  get,
  set,
  loadChats,
  onError,
}: SearchControllerOptions): SearchController => {
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let chatSearchGeneration = 0;
  let globalSearchGeneration = 0;

  const clearChatSearchTimer = () => {
    if (chatSearchTimer) globalThis.clearTimeout(chatSearchTimer);
    chatSearchTimer = undefined;
  };

  return {
    searchChatMessages: async (query) => {
      const chatId = get().activeChatId;
      const topicId = get().activeTopicId;
      const normalized = query.trim();
      if (!chatId || !normalized || get().authorization.kind !== "ready") return;
      try {
        await transport.searchChatMessages(chatId, normalized, 100, topicId);
        set({ operationError: undefined });
      } catch (error) {
        set({ operationError: onError(error, "无法搜索聊天消息") });
      }
    },

    searchGlobal: async (query, filter = "all") => {
      const normalized = query.trim();
      const generation = ++globalSearchGeneration;
      if (!normalized) {
        set({ globalSearch: emptyGlobalSearch() });
        return;
      }
      if (get().authorization.kind !== "ready") {
        set({
          globalSearch: {
            ...emptyGlobalSearch(normalized, filter),
            error: "Telegram 就绪后才能搜索",
          },
        });
        return;
      }
      set({
        globalSearch: {
          ...emptyGlobalSearch(normalized, filter),
          loading: true,
        },
      });
      try {
        const page = await transport.searchGlobal({
          query: normalized,
          filter,
          limit: 30,
        });
        if (generation !== globalSearchGeneration) return;
        set({
          globalSearch: mergeGlobalSearchPage(
            { ...emptyGlobalSearch(normalized, filter), loading: true },
            page,
          ),
        });
      } catch (error) {
        if (generation !== globalSearchGeneration) return;
        set({
          globalSearch: {
            ...emptyGlobalSearch(normalized, filter),
            error: onError(error, "全局搜索失败"),
          },
        });
      }
    },

    loadMoreGlobalSearch: async () => {
      const current = get().globalSearch;
      if (current.loading || !current.query || !current.nextOffset) return;
      const generation = ++globalSearchGeneration;
      set({ globalSearch: { ...current, loading: true, error: undefined } });
      try {
        const page = await transport.searchGlobal({
          query: current.query,
          filter: current.filter,
          offset: current.nextOffset,
          limit: 30,
        });
        if (generation !== globalSearchGeneration) return;
        set({ globalSearch: mergeGlobalSearchPage(current, page) });
      } catch (error) {
        if (generation !== globalSearchGeneration) return;
        set({
          globalSearch: {
            ...current,
            loading: false,
            error: onError(error, "无法加载更多搜索结果"),
          },
        });
      }
    },

    cancelGlobalSearch: () => {
      globalSearchGeneration += 1;
      set((state) => ({
        globalSearch: { ...state.globalSearch, loading: false, error: undefined },
      }));
    },

    clearGlobalSearch: () => {
      globalSearchGeneration += 1;
      set({ globalSearch: emptyGlobalSearch() });
    },

    setSearchQuery: (searchQuery) => {
      set({ searchQuery });
      clearChatSearchTimer();
      const normalized = searchQuery.trim();
      const generation = ++chatSearchGeneration;
      if (
        !normalized ||
        isRegexMessageSearchQuery(normalized) ||
        get().authorization.kind !== "ready"
      ) return;
      chatSearchTimer = globalThis.setTimeout(() => {
        chatSearchTimer = undefined;
        void transport.searchChats(normalized, 50).catch((error) => {
          if (generation !== chatSearchGeneration) return;
          set({ operationError: onError(error, "无法搜索会话") });
        });
      }, 250);
    },

    reset: () => {
      clearChatSearchTimer();
      chatSearchGeneration += 1;
      globalSearchGeneration += 1;
    },
  };
};
