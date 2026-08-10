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

  const canCreateTopic = (chatId: string) => {
    const chat = get().chats.get(chatId);
    return chat?.isForum === true && (
      chat.canCreateTopics === true || chat.management?.canManageTopics === true
    );
  };
  const canChangeTopic = (chatId: string, topicId: string) => {
    const chat = get().chats.get(chatId);
    if (chat?.isForum !== true) return false;
    if (chat.management?.canManageTopics === true) return true;
    return get().forumTopics.get(chatId)?.some((topic) => topic.id === topicId && topic.isOutgoing) === true;
  };
  const rejectTopicMutation = (message: string) => {
    set({ operationError: message });
    return false;
  };

  return {
    loadForumTopics,

    createForumTopic: async (chatId, name) => {
      if (!canCreateTopic(chatId)) {
        rejectTopicMutation("当前账号没有创建话题的权限");
        return undefined;
      }
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
      if (!canChangeTopic(chatId, topicId)) return rejectTopicMutation("当前账号没有编辑该话题的权限");
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
      if (!canChangeTopic(chatId, topicId)) return rejectTopicMutation("当前账号没有修改该话题状态的权限");
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
      if (get().chats.get(chatId)?.management?.canManageTopics !== true) {
        return rejectTopicMutation("当前账号没有置顶话题的权限");
      }
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
