import { translate } from "../i18n";
import type { TelegramTransport } from "../telegram/transport";
import type { Chat, ForumTopic, ForumTopicPage } from "../telegram/types";
import { hasChatDraftContent } from "../telegram/chatDraft";
import { canDeleteForumTopic } from "../telegram/forumTopicPermissions";
import type { TelegramState } from "./telegramStore.types";

type ForumStoreState = Pick<
  TelegramState,
  "chats" | "drafts" | "forumTopics" | "forumTopicsLoading"
>;

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface ForumController {
  reset: () => void;
  loadForumTopics: (chatId: string, query?: string) => Promise<ForumTopicPage | undefined>;
  loadMoreForumTopics: (chatId: string) => Promise<ForumTopicPage | undefined>;
  resolveForumTopic: (chatId: string, topicId: string) => Promise<ForumTopic | undefined>;
  createForumTopic: (chatId: string, name: string) => Promise<ForumTopicPage["topics"][number] | undefined>;
  editForumTopic: (chatId: string, topicId: string, name: string) => Promise<boolean>;
  setForumTopicClosed: (chatId: string, topicId: string, closed: boolean) => Promise<boolean>;
  setForumTopicPinned: (chatId: string, topicId: string, pinned: boolean) => Promise<boolean>;
  setGeneralForumTopicHidden: (chatId: string, hidden: boolean) => Promise<boolean>;
  deleteForumTopic: (chatId: string, topicId: string) => Promise<boolean>;
}

export interface ForumControllerOptions {
  transport: TelegramTransport;
  get: () => ForumStoreState;
  set: StoreSetter;
  topicKey: (chatId: string, topicId?: string) => string;
  onError: (error: unknown, fallback: string) => string;
  onTopicsLoaded?: (chatId: string, query: string, page: ForumTopicPage, sourceChat: Chat | undefined,
    unreadRevision: number | undefined) => void;
  captureUnreadRevision?: (chatId: string) => number | undefined;
  captureDraftRevision?: () => number;
  acceptTopicDraft?: (key: string, draft: ForumTopic["draft"], revision: number) => void;
}

/** Keeps forum topic list state and topic mutations behind one Store boundary. */
export const createForumController = ({
  transport,
  get,
  set,
  topicKey,
  onError,
  onTopicsLoaded,
  captureUnreadRevision,
  captureDraftRevision,
  acceptTopicDraft,
}: ForumControllerOptions): ForumController => {
  const pendingLoads = new Map<string, Promise<ForumTopicPage | undefined>>();
  const topicPages = new Map<string, ForumTopicPage>();
  const pendingTopicLoads = new Map<string, Promise<ForumTopic | undefined>>();
  let generation = 0;

  const loadForumTopics: ForumController["loadForumTopics"] = async (chatId, query = "") => {
    if (!get().chats.get(chatId)?.isForum) return undefined;
    const pending = pendingLoads.get(chatId);
    if (pending) return pending;
    const currentGeneration = generation;
    const draftRevision = captureDraftRevision?.() ?? 0;
    const sourceChat = get().chats.get(chatId);
    const unreadRevision = captureUnreadRevision?.(chatId);

    const request = (async () => {
      const loading = new Set(get().forumTopicsLoading);
      loading.add(chatId);
      set({ forumTopicsLoading: loading });
      try {
        let page = await transport.getForumTopics({ chatId, query, limit: 100 });
        if (currentGeneration !== generation) return undefined;
        // TDLib returns a last-topic cursor even for the final nonempty page.
        // Confirm exhaustion before using a small forum's totals for unread repair.
        if (!query.trim() && page.hasMore && page.topics.length < 100) {
          const tail = await transport.getForumTopics({ chatId, limit: 1,
            offsetDate: page.nextOffsetDate, offsetMessageId: page.nextOffsetMessageId,
            offsetTopicId: page.nextOffsetTopicId }).catch(() => undefined);
          if (tail?.topics.length === 0 && !tail.hasMore) page = { ...page, hasMore: false };
        }
        if (currentGeneration !== generation) return undefined;
        if (!query) topicPages.set(chatId, page);
        const forumTopics = new Map(get().forumTopics);
        forumTopics.set(chatId, page.topics);
        const drafts = new Map(get().drafts);
        for (const topic of page.topics) {
          const key = topicKey(chatId, topic.id);
          if (acceptTopicDraft) {
            acceptTopicDraft(key, topic.draft, draftRevision);
            continue;
          }
          if (drafts.get(key)?.pending) continue;
          if (hasChatDraftContent(topic.draft)) drafts.set(key, { ...topic.draft, pending: false });
          else drafts.delete(key);
        }
        set({ forumTopics, ...(!acceptTopicDraft ? { drafts } : {}), operationError: undefined });
        onTopicsLoaded?.(chatId, query, page, sourceChat, unreadRevision);
        return page;
      } catch (error) {
        if (currentGeneration !== generation) return undefined;
        set({ operationError: onError(error, translate("无法加载话题列表")) });
        return undefined;
      } finally {
        if (currentGeneration === generation) {
          pendingLoads.delete(chatId);
          const latest = new Set(get().forumTopicsLoading);
          latest.delete(chatId);
          set({ forumTopicsLoading: latest });
        }
      }
    })();
    pendingLoads.set(chatId, request);
    return request;
  };

  const reloadTopics = async (chatId: string) => {
    await pendingLoads.get(chatId);
    await loadForumTopics(chatId);
  };

  const canCreateTopic = (chatId: string) => {
    const chat = get().chats.get(chatId);
    return chat?.isForum === true && chat.isMember !== false && (
      chat.canCreateTopics === true || chat.management?.canManageTopics === true
    );
  };
  const canChangeTopic = (chatId: string, topicId: string) => {
    const chat = get().chats.get(chatId);
    if (chat?.isForum !== true || chat.isMember === false) return false;
    if (chat.management?.canManageTopics === true) return true;
    return get().forumTopics.get(chatId)?.some((topic) => topic.id === topicId && topic.isOutgoing) === true;
  };
  const rejectTopicMutation = (message: string) => {
    set({ operationError: message });
    return false;
  };

  return {
    reset: () => {
      generation += 1;
      pendingLoads.clear();
      topicPages.clear();
      pendingTopicLoads.clear();
      set({ forumTopicsLoading: new Set() });
    },
    loadForumTopics,
    resolveForumTopic: async (chatId, topicId) => {
      const currentGeneration = generation;
      const key = topicKey(chatId, topicId);
      const pending = pendingTopicLoads.get(key);
      if (pending) return pending;
      const cached = get().forumTopics.get(chatId)?.find((topic) => topic.id === topicId);
      const request = transport.getForumTopic(chatId, topicId)
        .then((topic) => {
          if (currentGeneration !== generation) return undefined;
          if (!topic) return cached;
          const existing = get().forumTopics.get(chatId) ?? [];
          const forumTopics = new Map(get().forumTopics);
          const index = existing.findIndex((candidate) => candidate.id === topicId);
          forumTopics.set(chatId, index >= 0
            ? existing.map((candidate) => candidate.id === topicId ? topic : candidate)
            : [...existing, topic]);
          set({ forumTopics });
          return topic;
        })
        .catch(() => currentGeneration === generation ? cached : undefined)
        .finally(() => {
          if (pendingTopicLoads.get(key) === request) pendingTopicLoads.delete(key);
        });
      pendingTopicLoads.set(key, request);
      return request;
    },

    loadMoreForumTopics: async (chatId) => {
      const previous = topicPages.get(chatId);
      if (!previous?.hasMore || get().forumTopicsLoading.has(chatId)) return previous;
      const currentGeneration = generation;
      const loading = new Set(get().forumTopicsLoading); loading.add(chatId); set({ forumTopicsLoading: loading });
      try {
        const page = await transport.getForumTopics({ chatId, offsetDate: previous.nextOffsetDate, offsetMessageId: previous.nextOffsetMessageId, offsetTopicId: previous.nextOffsetTopicId, limit: 100 });
        if (currentGeneration !== generation) return undefined;
        const unchanged = page.nextOffsetDate === previous.nextOffsetDate && page.nextOffsetMessageId === previous.nextOffsetMessageId && page.nextOffsetTopicId === previous.nextOffsetTopicId;
        const next = { ...page, hasMore: page.hasMore && !unchanged };
        topicPages.set(chatId, next);
        const forumTopics = new Map(get().forumTopics);
        const current = forumTopics.get(chatId) ?? [];
        forumTopics.set(chatId, [...current, ...page.topics.filter(topic => !current.some(old => old.id === topic.id))]);
        set({ forumTopics, operationError: undefined });
        return next;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法加载话题列表")) });
        return undefined;
      } finally {
        if (currentGeneration === generation) { const loading = new Set(get().forumTopicsLoading); loading.delete(chatId); set({ forumTopicsLoading: loading }); }
      }
    },

    createForumTopic: async (chatId, name) => {
      if (!canCreateTopic(chatId)) {
        rejectTopicMutation(translate("当前账号没有创建话题的权限"));
        return undefined;
      }
      const currentGeneration = generation;
      try {
        const topic = await transport.createForumTopic({ chatId, name });
        if (currentGeneration !== generation) return undefined;
        await reloadTopics(chatId);
        return currentGeneration === generation ? topic : undefined;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法创建话题")) });
        return undefined;
      }
    },

    editForumTopic: async (chatId, topicId, name) => {
      if (!canChangeTopic(chatId, topicId)) return rejectTopicMutation(translate("当前账号没有编辑该话题的权限"));
      const currentGeneration = generation;
      try {
        await transport.editForumTopic(chatId, topicId, name);
        if (currentGeneration !== generation) return false;
        await reloadTopics(chatId);
        return currentGeneration === generation;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法编辑话题")) });
        return false;
      }
    },

    setForumTopicClosed: async (chatId, topicId, closed) => {
      if (!canChangeTopic(chatId, topicId)) return rejectTopicMutation(translate("当前账号没有修改该话题状态的权限"));
      const currentGeneration = generation;
      try {
        await transport.setForumTopicClosed(chatId, topicId, closed);
        if (currentGeneration !== generation) return false;
        await reloadTopics(chatId);
        return currentGeneration === generation;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法更新话题状态")) });
        return false;
      }
    },

    setForumTopicPinned: async (chatId, topicId, pinned) => {
      if (get().chats.get(chatId)?.isMember === false || get().chats.get(chatId)?.management?.canManageTopics !== true) {
        return rejectTopicMutation(translate("当前账号没有置顶话题的权限"));
      }
      const currentGeneration = generation;
      try {
        await transport.setForumTopicPinned(chatId, topicId, pinned);
        if (currentGeneration !== generation) return false;
        await reloadTopics(chatId);
        return currentGeneration === generation;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法更新话题置顶")) });
        return false;
      }
    },

    setGeneralForumTopicHidden: async (chatId, hidden) => {
      if (get().chats.get(chatId)?.isMember === false || get().chats.get(chatId)?.management?.canManageTopics !== true) return rejectTopicMutation(translate("当前账号没有管理话题的权限"));
      const currentGeneration = generation;
      try {
        await transport.setGeneralForumTopicHidden(chatId, hidden);
        if (currentGeneration !== generation) return false;
        await reloadTopics(chatId);
        return currentGeneration === generation;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法更新默认话题")) });
        return false;
      }
    },

    deleteForumTopic: async (chatId, topicId) => {
      const chat = get().chats.get(chatId);
      const topic = get().forumTopics.get(chatId)?.find(candidate => candidate.id === topicId);
      if (!chat || !topic || !canDeleteForumTopic(chat, topic)) {
        return rejectTopicMutation(translate("当前账号没有删除该话题的权限"));
      }
      const currentGeneration = generation;
      try {
        await transport.deleteForumTopic(chatId, topicId);
        if (currentGeneration !== generation) return false;
        const forumTopics = new Map(get().forumTopics);
        forumTopics.set(chatId, (forumTopics.get(chatId) ?? []).filter(candidate => candidate.id !== topicId));
        set({ forumTopics, operationError: undefined });
        await reloadTopics(chatId);
        return currentGeneration === generation;
      } catch (error) {
        if (currentGeneration === generation) set({ operationError: onError(error, translate("无法删除话题")) });
        return false;
      }
    },
  };
};
