import type { TelegramTransport } from "../telegram/transport";
import { chatMessageSearchCriteriaActive } from "../telegram/messageSearch";
import type { ChatMessageSearchInput, GlobalSearchFilter } from "../telegram/types";
import {
  chatMessageSearchInputKey,
  emptyChatMessageSearch,
  mergeChatMessageSearchPage,
} from "./chatMessageSearchState";
import { emptyGlobalSearch, mergeGlobalSearchPage } from "./globalSearchState";
import type { TelegramState } from "./telegramStore.types";

type StoreState = Pick<
  TelegramState,
  | "authorization"
  | "globalSearch"
  | "chatMessageSearch"
  | "searchQuery"
>;

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface SearchController {
  searchChatMessages: (input: ChatMessageSearchInput) => Promise<void>;
  loadMoreChatMessages: () => Promise<void>;
  cancelChatMessageSearch: () => void;
  clearChatMessageSearch: () => void;
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
  onError,
}: SearchControllerOptions): SearchController => {
  let chatMessageSearchGeneration = 0;
  let globalSearchGeneration = 0;

  return {
    searchChatMessages: async (input) => {
      const normalizedInput: ChatMessageSearchInput = {
        ...input,
        query: input.query?.trim() ?? "",
        filter: input.filter ?? "all",
        limit: undefined,
      };
      const generation = ++chatMessageSearchGeneration;
      if (!chatMessageSearchCriteriaActive(normalizedInput)) {
        set({ chatMessageSearch: emptyChatMessageSearch() });
        return;
      }
      if (get().authorization.kind !== "ready") {
        set({
          chatMessageSearch: {
            ...emptyChatMessageSearch(normalizedInput),
            error: "Telegram 就绪后才能搜索",
          },
        });
        return;
      }
      set({
        chatMessageSearch: {
          ...emptyChatMessageSearch(normalizedInput),
          loading: true,
        },
      });
      try {
        const page = await transport.searchChatMessages({ ...normalizedInput, limit: 30 });
        if (generation !== chatMessageSearchGeneration ||
          chatMessageSearchInputKey(get().chatMessageSearch.input) !== chatMessageSearchInputKey(normalizedInput)) return;
        set({
          chatMessageSearch: mergeChatMessageSearchPage(
            { ...emptyChatMessageSearch(normalizedInput), loading: true },
            page,
          ),
          operationError: undefined,
        });
      } catch (error) {
        if (generation !== chatMessageSearchGeneration) return;
        set({ chatMessageSearch: { ...emptyChatMessageSearch(normalizedInput), error: onError(error, "无法搜索聊天消息") } });
      }
    },

    loadMoreChatMessages: async () => {
      const current = get().chatMessageSearch;
      const input = current.input;
      if (current.loading || current.loadingMore || !input || !current.nextFromMessageId) return;
      const generation = ++chatMessageSearchGeneration;
      set({ chatMessageSearch: { ...current, loadingMore: true, error: undefined } });
      try {
        const page = await transport.searchChatMessages({
          ...input,
          fromMessageId: current.nextFromMessageId,
          limit: 30,
        });
        if (generation !== chatMessageSearchGeneration) return;
        set({ chatMessageSearch: mergeChatMessageSearchPage(current, page) });
      } catch (error) {
        if (generation !== chatMessageSearchGeneration) return;
        set({ chatMessageSearch: { ...current, loadingMore: false, error: onError(error, "无法加载更多聊天搜索结果") } });
      }
    },

    cancelChatMessageSearch: () => {
      chatMessageSearchGeneration += 1;
      set((state) => ({ chatMessageSearch: { ...state.chatMessageSearch, loading: false, loadingMore: false } }));
    },

    clearChatMessageSearch: () => {
      chatMessageSearchGeneration += 1;
      set({ chatMessageSearch: emptyChatMessageSearch() });
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
    },

    reset: () => {
      chatMessageSearchGeneration += 1;
      globalSearchGeneration += 1;
      set({ chatMessageSearch: emptyChatMessageSearch() });
    },
  };
};
