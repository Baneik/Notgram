import type { TelegramTransport } from "../telegram/transport";
import type { ForumTopicPage } from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

type ForumStoreState = Pick<
  TelegramState,
  "chats" | "drafts" | "forumTopics" | "forumTopicsLoading"
>;

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface ForumController {
  loadForumTopics: (chatId: string, query?: string) => Promise<ForumTopicPage | undefined>;
  createForumTopic: (chatId: string, name: string) => Promise<ForumTopicPage["topics"][number] | undefined>;
  editForumTopic: (chatId: string, topicId: string, name: string) => Promise<boolean>;
  setForumTopicClosed: (chatId: string, topicId: string, closed: boolean) => Promise<boolean>;
  setForumTopicPinned: (chatId: string, topicId: string, pinned: boolean) => Promise<boolean>;
}

export interface ForumControllerOptions {
  transport: TelegramTransport;
  get: () => ForumStoreState;
  set: StoreSetter;
  topicKey: (chatId: string, topicId?: string) => string;
  onError: (error: unknown, fallback: string) => string;
  onTopicsLoaded?: (chatId: string, query: string) => void;
}

/** Keeps forum topic list state and topic mutations behind one Store boundary. */
export const createForumController = ({
  transport,
  get,
  set,
  topicKey,
  onError,
  onTopicsLoaded,
}: ForumControllerOptions): ForumController => {
  const pendingLoads = new Map<string, Promise<ForumTopicPage | undefined>>();

  const loadForumTopics: ForumController["loadForumTopics"] = async (chatId, query = "") => {
    if (!get().chats.get(chatId)?.isForum) return undefined;
    const pending = pendingLoads.get(chatId);
    if (pending) return pending;

    const request = (async () => {
      const loading = new Set(get().forumTopicsLoading);
      loading.add(chatId);
      set({ forumTopicsLoading: loading });
      try {
        const page = await transport.getForumTopics({ chatId, query, limit: 100 });
        const forumTopics = new Map(get().forumTopics);
        forumTopics.set(chatId, page.topics);
        const drafts = new Map(get().drafts);
        for (const topic of page.topics) {
          const key = topicKey(chatId, topic.id);
          if (drafts.get(key)?.pending) continue;
          if (topic.draft) drafts.set(key, { ...topic.draft, pending: false });
          else drafts.delete(key);
        }
        set({ forumTopics, drafts, operationError: undefined });
        onTopicsLoaded?.(chatId, query);
        return page;
      } catch (error) {
        set({ operationError: onError(error, "无法加载话题列表") });
        return undefined;
      } finally {
        pendingLoads.delete(chatId);
        const latest = new Set(get().forumTopicsLoading);
        latest.delete(chatId);
        set({ forumTopicsLoading: latest });
      }
    })();
    pendingLoads.set(chatId, request);
    return request;
  };

  const reloadTopics = async (chatId: string) => {
    await loadForumTopics(chatId);
  };

  return {
    loadForumTopics,

    createForumTopic: async (chatId, name) => {
      try {
        const topic = await transport.createForumTopic({ chatId, name });
        await reloadTopics(chatId);
        return topic;
      } catch (error) {
        set({ operationError: onError(error, "无法创建话题") });
        return undefined;
      }
    },

    editForumTopic: async (chatId, topicId, name) => {
      try {
        await transport.editForumTopic(chatId, topicId, name);
        await reloadTopics(chatId);
        return true;
      } catch (error) {
        set({ operationError: onError(error, "无法编辑话题") });
        return false;
      }
    },

    setForumTopicClosed: async (chatId, topicId, closed) => {
      try {
        await transport.setForumTopicClosed(chatId, topicId, closed);
        await reloadTopics(chatId);
        return true;
      } catch (error) {
        set({ operationError: onError(error, "无法更新话题状态") });
        return false;
      }
    },

    setForumTopicPinned: async (chatId, topicId, pinned) => {
      try {
        await transport.setForumTopicPinned(chatId, topicId, pinned);
        await reloadTopics(chatId);
        return true;
      } catch (error) {
        set({ operationError: onError(error, "无法更新话题置顶") });
        return false;
      }
    },
  };
};
