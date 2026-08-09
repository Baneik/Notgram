import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { createTelegramTransport } from "../telegram/createTransport";
import type { TelegramTransport } from "../telegram/transport";
import type {
  CachedTelegramSnapshot,
  ChatManagement,
  ChatDraft,
  Message,
  QueuedOutgoingMessage,
  TelegramEvent,
  TelegramAccountState,
} from "../telegram/types";
import { connectionPresentation } from "../telegram/connectionState";
import {
  accountStatePatch,
  currentAccountRegistration,
  shouldDiscardUnregisteredAccount,
} from "./telegramStore.accounts";
import { cachedSnapshotFrom, migrateCachedSnapshot } from "./telegramStore.cache";
import {
  DRAFT_SYNC_DELAY_MS,
  DraftSyncController,
  draftForSync,
  draftSignature,
} from "./telegramStore.drafts";
import {
  messageMapFrom,
  pendingCachedIdsAfterConfirmation,
  replaceMessage,
  upsertMessage,
  upsertMessages,
  withEmojiReaction,
} from "./telegramStore.messages";
import { messagesWithOutbox, outboxItemId } from "./telegramStore.outbox";
import {
  compareChats,
  filterAndSortChats,
  isChatPinnedInFolder,
} from "./telegramStore.selectors";
import type { TelegramState } from "./telegramStore.types";
import {
  getActiveConversationTraceId,
  logPerformance,
} from "../utils/performanceMonitor";
import { markMessageEntrance, transferMessageEntrance } from "../utils/messageEntrance";
import { protectedCachePaths } from "./cacheProtection";
import { emptyGlobalSearch } from "./globalSearchState";
import { emptyProfileState } from "./profileState";
import { createSearchController } from "./telegramStore.search";
import { createProfileController } from "./telegramStore.profile";
import { createOutboxController } from "./telegramStore.outboxController";
import { createForumController } from "./telegramStore.forum";
import { createSessionController } from "./telegramStore.session";
import { SharedMediaIndex } from "./sharedMediaIndex";
import {
  attachmentOutbox,
  describeOutgoingAttachments,
} from "./attachmentOutbox";
import { inspectOutgoingAttachment } from "../media/outgoingAttachments";

export type {
  ChatFilter,
  ChatListState,
  HistoryState,
  RuntimePhase,
  TelegramState,
} from "./telegramStore.types";
export { filterAndSortChats, selectVisibleChats } from "./telegramStore.selectors";

const CACHE_WRITE_DELAY_MS = 2_000;
const CACHE_WRITE_IDLE_TIMEOUT_MS = 1_500;
const FORUM_TOPICS_REFRESH_TTL_MS = 10_000;
const FORUM_TOPICS_CHANGE_COALESCE_MS = 500;

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

const topicKey = (chatId: string, topicId?: string) => topicId ? `${chatId}:topic:${topicId}` : chatId;

const reloadCurrentApplication = () => {
  if (typeof window === "undefined") return;
  if (isTauri()) {
    void emit("notgram://reload-application").catch(() => window.location.reload());
    return;
  }
  window.location.reload();
};

export const createTelegramStore = (
  transport: TelegramTransport,
  reloadApplication: () => void = reloadCurrentApplication,
) =>
  createStore<TelegramState>((set, get) => {
    const sharedMediaIndex = new SharedMediaIndex();
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    let cacheIdleCallback: number | undefined;
    let cacheWrite = Promise.resolve();
    const cachedMessageIds = new Map<string, Set<string>>();
    let accountTransition = false;
    let registeredAccountKey: string | undefined;
    let accountRegistration = Promise.resolve();
    const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const readRequestChains = new Map<string, Promise<void>>();
    const forumTopicsRefreshedAt = new Map<string, number>();
    const groupManagementLoads = new Map<string, Promise<ChatManagement | undefined>>();
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const liveAttentionCandidates = new Set<string>();
    const messageEventKey = (message: Message) => `${message.chatId}:${message.id}`;
    const queueLiveMessageAttention = (message: Message, live: boolean) => {
      const key = messageEventKey(message);
      if (message.outgoing) {
        liveAttentionCandidates.delete(key);
        return;
      }
      if (live) {
        liveAttentionCandidates.add(key);
        if (liveAttentionCandidates.size > 512) {
          liveAttentionCandidates.delete(liveAttentionCandidates.values().next().value!);
        }
      }
      if (!liveAttentionCandidates.has(key)) return;

      const reply = message.replyTo?.kind === "message" ? message.replyTo : undefined;
      const replyChatId = reply?.chatId ?? message.chatId;
      const repliedMessage = reply?.messageId
        ? get().messages.get(replyChatId)?.find((candidate) => candidate.id === reply.messageId)
        : undefined;
      const needsAttention = message.containsUnreadMention === true ||
        reply?.outgoing === true || repliedMessage?.outgoing === true;
      const replyResolved = !reply || reply.outgoing !== undefined || repliedMessage !== undefined;
      if (!needsAttention && !replyResolved) return;

      liveAttentionCandidates.delete(key);
      if (!needsAttention) return;
      const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
      const current = unreadAttentionMessageIds.get(message.chatId) ?? [];
      if (current.includes(message.id)) return;
      unreadAttentionMessageIds.set(message.chatId, [...current, message.id]);
      set({ unreadAttentionMessageIds });
    };
    const markMessageRemoving = (chatId: string, messageId: string) => {
      const key = `${chatId}:${messageId}`;
      const previous = removalTimers.get(key);
      if (previous) globalThis.clearTimeout(previous);
      const messages = new Map(get().messages);
      const current = messages.get(chatId) ?? [];
      const removed = current.find((message) => message.id === messageId);
      if (!removed) return;
      messages.set(chatId, current.filter((message) => message.id !== messageId));
      const removingMessages = new Map(get().removingMessages);
      const ghosts = removingMessages.get(chatId) ?? [];
      removingMessages.set(chatId, [...ghosts.filter((message) => message.id !== messageId), { ...removed, isRemoving: true }]);
      set({ messages, removingMessages });
      removalTimers.set(key, globalThis.setTimeout(() => {
        removalTimers.delete(key);
        const nextRemoving = new Map(get().removingMessages);
        nextRemoving.set(chatId, (nextRemoving.get(chatId) ?? []).filter((message) => message.id !== messageId));
        sharedMediaIndex.remove(chatId, [messageId]);
        set({ removingMessages: nextRemoving });
        scheduleCacheWrite();
      }, 180));
    };

    const setTypingUser = (chatId: string, senderId: string, typing: boolean) => {
      const key = `${chatId}:${senderId}`;
      const previousTimer = typingTimers.get(key);
      if (previousTimer) globalThis.clearTimeout(previousTimer);
      typingTimers.delete(key);

      const currentIds = get().typingUserIds.get(chatId) ?? [];
      const hasSender = currentIds.includes(senderId);
      if (typing && !hasSender) {
        const typingUserIds = new Map(get().typingUserIds);
        typingUserIds.set(chatId, [...currentIds, senderId]);
        set({ typingUserIds });
      } else if (!typing && hasSender) {
        const typingUserIds = new Map(get().typingUserIds);
        const nextIds = currentIds.filter((id) => id !== senderId);
        if (nextIds.length > 0) typingUserIds.set(chatId, nextIds);
        else typingUserIds.delete(chatId);
        set({ typingUserIds });
      }

      if (typing) {
        typingTimers.set(key, globalThis.setTimeout(() => {
          typingTimers.delete(key);
          setTypingUser(chatId, senderId, false);
        }, 6_000));
      }
    };

    const clearTypingUsers = () => {
      for (const timer of typingTimers.values()) globalThis.clearTimeout(timer);
      typingTimers.clear();
    };

    const cancelScheduledCacheWrite = () => {
      if (cacheTimer) globalThis.clearTimeout(cacheTimer);
      cacheTimer = undefined;
      if (cacheIdleCallback !== undefined && typeof globalThis.cancelIdleCallback === "function") {
        globalThis.cancelIdleCallback(cacheIdleCallback);
      }
      cacheIdleCallback = undefined;
    };

    const scheduleCacheWrite = () => {
      const state = get();
      if (
        state.authorization.kind !== "ready" ||
        !state.currentUserId ||
        cacheTimer ||
        cacheIdleCallback !== undefined
      ) {
        return;
      }
      cacheTimer = globalThis.setTimeout(() => {
        cacheTimer = undefined;
        const writeSnapshot = () => {
          cacheIdleCallback = undefined;
          const current = get();
          if (current.authorization.kind !== "ready" || !current.currentUserId) return;
          const snapshot = cachedSnapshotFrom(
            current,
            profileController.getCachedProfiles(),
          );
          cacheWrite = cacheWrite
            .catch(() => undefined)
            .then(() => transport.saveCachedSnapshot(snapshot))
            .then(() => set({ cacheHealth: "healthy" }))
            .catch(() => set({ cacheHealth: "invalid" }));
        };
        if (typeof globalThis.requestIdleCallback === "function") {
          cacheIdleCallback = globalThis.requestIdleCallback(writeSnapshot, {
            timeout: CACHE_WRITE_IDLE_TIMEOUT_MS,
          });
        } else {
          cacheTimer = globalThis.setTimeout(() => {
            cacheTimer = undefined;
            writeSnapshot();
          }, 0);
        }
      }, CACHE_WRITE_DELAY_MS);
    };

    const draftSync = new DraftSyncController({
      isReady: () => get().authorization.kind === "ready",
      getDrafts: () => get().drafts,
      setDrafts: (drafts) => set({ drafts }),
      sendDraft: (draftKey, draft) => transport.setChatDraft({
        chatId: draft?.chatId ?? draftKey.split(":topic:")[0],
        topicId: draft?.topicId,
        text: draft?.text ?? "",
        replyToMessageId: draft?.replyToMessageId,
      }),
      reportError: (operationError) => set({ operationError }),
      scheduleCacheWrite,
    });

    const clearCachedData = (clearSnapshot = true) => {
      cancelScheduledCacheWrite();
      cachedMessageIds.clear();
      draftSync.clear();
      clearTypingUsers();
      liveAttentionCandidates.clear();
      for (const timer of readTimers.values()) globalThis.clearTimeout(timer);
      readTimers.clear();
      readRequestChains.clear();
      forumTopicsRefreshedAt.clear();
      searchController.reset();
      profileController.reset();
      set({
        currentUserId: undefined,
        users: new Map(),
        folders: [],
        chats: new Map(),
        chatListReady: false,
        chatLists: new Map(),
        messages: new Map(),
        removingMessages: new Map(),
        unreadAttentionMessageIds: new Map(),
        drafts: new Map(),
        typingUserIds: new Map(),
        outbox: [],
        histories: new Map(),
        forumTopics: new Map(),
        forumTopicsLoading: new Set(),
        topicHistories: new Map(),
        lastForumTopicIds: new Map(),
        activeChatId: undefined,
        activeTopicId: undefined,
        globalSearch: emptyGlobalSearch(),
        accountProfile: emptyProfileState(),
        profile: emptyProfileState(),
        contacts: [],
        contactsLoading: false,
        contactsError: undefined,
        contactPendingUserId: undefined,
        chatManagementPending: new Set(),
        groupManagement: undefined,
        groupManagementLoading: false,
        groupManagementError: undefined,
        blockedSenders: [],
        blockedSendersLoading: false,
        folderManagementPending: false,
        chatCreationPending: false,
        chatFilter: "main",
        cacheHealth: clearSnapshot ? "empty" : get().cacheHealth,
      });
      if (clearSnapshot) void transport.clearCachedSnapshot().catch(() => undefined);
    };

    const applyAccountState = (accountState: TelegramAccountState) => {
      set(accountStatePatch(accountState));
    };

    const registerCurrentAccount = () => {
      const state = get();
      if (accountTransition) return Promise.resolve();
      const registration = currentAccountRegistration(state);
      if (!registration) return Promise.resolve();
      const { accountId, account, key } = registration;
      if (registeredAccountKey === key) return accountRegistration;
      registeredAccountKey = key;
      const request = transport.registerCurrentAccount(account).then((accountState) => {
        if (!accountTransition && get().activeAccountId === accountId) {
          applyAccountState(accountState);
        }
      }).catch((error) => {
        if (registeredAccountKey === key) registeredAccountKey = undefined;
        if (!accountTransition) {
          set({
            accountError: error instanceof Error ? error.message : "无法保存账号信息",
          });
        }
      });
      accountRegistration = request;
      return request;
    };

    const flushCachedSnapshot = async () => {
      cancelScheduledCacheWrite();
      await cacheWrite.catch(() => undefined);
      const state = get();
      if (state.authorization.kind === "ready" && state.currentUserId) {
        await transport.saveCachedSnapshot(
          cachedSnapshotFrom(state, profileController.getCachedProfiles()),
        );
        set({ cacheHealth: "healthy" });
      }
    };

    const hydrateCachedSnapshot = (persistedSnapshot?: CachedTelegramSnapshot) => {
      const migration = migrateCachedSnapshot(persistedSnapshot);
      const snapshot = migration.snapshot;
      set({ cacheHealth: migration.health });
      if (!snapshot) {
        if (migration.health === "invalid") {
          void transport.clearCachedSnapshot().catch(() => undefined);
        }
        return;
      }
      const current = get();
      profileController.hydrateCachedProfiles(snapshot.profiles ?? []);
      const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
      const users = new Map(snapshot.users.map((user) => [user.id, user]));
      const forumTopics = new Map(
        (snapshot.forumTopics ?? []).map((entry) => [entry.chatId, entry.topics]),
      );
      const lastForumTopicIds = new Map(
        (snapshot.lastForumTopicIds ?? []).map((entry) => [entry.chatId, entry.topicId]),
      );
      let messages = messageMapFrom(snapshot.messages);
      const drafts = new Map((snapshot.drafts ?? []).map((draft) => [topicKey(draft.chatId, draft.topicId), draft]));
      const outbox = snapshot.outbox ?? [];
      cachedMessageIds.clear();
      for (const message of snapshot.messages) {
        const ids = cachedMessageIds.get(message.chatId) ?? new Set<string>();
        ids.add(message.id);
        cachedMessageIds.set(message.chatId, ids);
      }
      for (const [id, chat] of current.chats) chats.set(id, chat);
      for (const [id, user] of current.users) users.set(id, user);
      for (const [chatId, topics] of current.forumTopics) forumTopics.set(chatId, topics);
      for (const [chatId, topicId] of current.lastForumTopicIds) {
        lastForumTopicIds.set(chatId, topicId);
      }
      for (const [chatId, draft] of current.drafts) {
        if (draft.pending || !drafts.has(chatId)) drafts.set(chatId, draft);
      }
      for (const [chatId, chatMessages] of current.messages) {
        for (const message of chatMessages) {
          messages.set(chatId, upsertMessage(messages.get(chatId) ?? [], message));
        }
      }
      messages = messagesWithOutbox(
        messages,
        outbox,
        current.currentUserId ?? snapshot.currentUserId,
      );
      const folders = current.folders.length > 0
        ? current.folders
        : snapshot.folders;
      const requestedFilter = snapshot.chatFilter ?? "main";
      const chatFilter = folders.some((folder) => folder.id === requestedFilter)
        ? requestedFilter
        : (folders[0]?.id ?? "main");
      const cachedActiveChatId = snapshot.activeChatId && chats.has(snapshot.activeChatId)
        ? snapshot.activeChatId
        : undefined;
      const nextActiveChatId = current.activeChatId ?? cachedActiveChatId;
      const cachedActiveTopicId = nextActiveChatId && chats.get(nextActiveChatId)?.isForum
        ? lastForumTopicIds.get(nextActiveChatId)
        : undefined;
      set({
        currentUserId: current.currentUserId ?? snapshot.currentUserId,
        users,
        folders,
        chats,
        chatListReady: true,
        messages,
        drafts,
        outbox,
        forumTopics,
        lastForumTopicIds,
        activeChatId: nextActiveChatId,
        activeTopicId: current.activeTopicId ?? cachedActiveTopicId,
        chatFilter: current.chatFilter !== "main" ? current.chatFilter : chatFilter,
        cacheHealth: migration.health,
      });
    };

    const loadHistory = async (chatId: string, mode: "ensure" | "older") => {
      if (get().authorization.kind !== "ready") return;
      const current = get().histories.get(chatId);
      if (
        current?.loading ||
        current?.hasMore === false ||
        (mode === "ensure" && current?.initialized)
      ) return;

      const histories = new Map(get().histories);
      histories.set(chatId, {
        loading: true,
        hasMore: current?.hasMore ?? true,
        initialized: current?.initialized ?? false,
      });
      set({ histories });
      const startedAt = performance.now();
      const beforeCount = get().messages.get(chatId)?.length ?? 0;
      try {
        let page = await transport.loadChatHistory(chatId, 30);
        const pendingCachedIds = cachedMessageIds.get(chatId);
        if (pendingCachedIds) {
          const confirmedIds = new Set(page.messageIds);
          const hasUnconfirmedCache = [...pendingCachedIds].some(
            (messageId) => !confirmedIds.has(messageId),
          );
          if (hasUnconfirmedCache && page.hasMore) {
            const continuation = await transport.loadChatHistory(chatId, 30);
            for (const messageId of continuation.messageIds) confirmedIds.add(messageId);
            page = {
              loadedCount: page.loadedCount + continuation.loadedCount,
              hasMore: continuation.hasMore,
              messageIds: [...confirmedIds],
            };
          }

          const remainingCachedIds = pendingCachedIdsAfterConfirmation(
            pendingCachedIds,
            confirmedIds,
          );
          if (remainingCachedIds.size === 0) {
            cachedMessageIds.delete(chatId);
          } else {
            cachedMessageIds.set(chatId, remainingCachedIds);
          }
        }
        const nextHistories = new Map(get().histories);
        nextHistories.set(chatId, {
          loading: false,
          hasMore: page.hasMore,
          initialized: true,
        });
        set({ histories: nextHistories });
        logPerformance("ui_history_data", {
          durationMs: performance.now() - startedAt,
          beforeCount,
          afterCount: get().messages.get(chatId)?.length ?? 0,
          loadedCount: page.loadedCount,
          hasMore: page.hasMore,
          failed: false,
          traceId: getActiveConversationTraceId(),
          duringConversationSwitch: getActiveConversationTraceId() !== undefined,
        });
        scheduleCacheWrite();
      } catch (error) {
        const nextHistories = new Map(get().histories);
        nextHistories.set(chatId, {
          loading: false,
          hasMore: true,
          initialized: current?.initialized ?? false,
        });
        set({
          histories: nextHistories,
          operationError: error instanceof Error ? error.message : "无法加载历史消息",
        });
        logPerformance("ui_history_data", {
          durationMs: performance.now() - startedAt,
          beforeCount,
          afterCount: get().messages.get(chatId)?.length ?? 0,
          failed: true,
          traceId: getActiveConversationTraceId(),
          duringConversationSwitch: getActiveConversationTraceId() !== undefined,
        });
      }
    };

    const loadForumTopicHistory = async (
      chatId: string,
      topicId: string,
      mode: "ensure" | "older",
    ) => {
      if (get().authorization.kind !== "ready") return;
      const key = topicKey(chatId, topicId);
      const current = get().topicHistories.get(key);
      if (current?.loading || current?.hasMore === false || (mode === "ensure" && current?.initialized)) return;
      const topicHistories = new Map(get().topicHistories);
      topicHistories.set(key, { loading: true, hasMore: current?.hasMore ?? true, initialized: current?.initialized ?? false });
      set({ topicHistories });
      try {
        const page = await transport.loadForumTopicHistory(chatId, topicId, 30);
        const next = new Map(get().topicHistories);
        next.set(key, { loading: false, hasMore: page.hasMore, initialized: true });
        set({ topicHistories: next, operationError: undefined });
        scheduleCacheWrite();
      } catch (error) {
        const next = new Map(get().topicHistories);
        next.set(key, { loading: false, hasMore: true, initialized: current?.initialized ?? false });
        set({ topicHistories: next, operationError: errorMessage(error, "无法加载话题消息") });
      }
    };

    const loadChats = async (chatListId = get().chatFilter) => {
      if (get().authorization.kind !== "ready") return;
      const current = get().chatLists.get(chatListId);
      if (current?.loading || current?.hasMore === false) return;

      const chatLists = new Map(get().chatLists);
      chatLists.set(chatListId, { loading: true, hasMore: current?.hasMore ?? true });
      set({ chatLists });
      try {
        const page = await transport.loadMoreChats(chatListId, 50);
        const nextChatLists = new Map(get().chatLists);
        nextChatLists.set(chatListId, { loading: false, hasMore: page.hasMore });
        set({ chatLists: nextChatLists, operationError: undefined });
        scheduleCacheWrite();
      } catch (error) {
        const nextChatLists = new Map(get().chatLists);
        nextChatLists.set(chatListId, { loading: false, hasMore: true });
        set({
          chatLists: nextChatLists,
          operationError: error instanceof Error ? error.message : "无法加载更多会话",
        });
      }
    };

    const searchController = createSearchController({
      transport,
      get,
      set,
      loadChats,
      onError: errorMessage,
    });

    const documentIsVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    const markChatRead = (chatId: string, activeOnly = true) => {
      const previous = readRequestChains.get(chatId) ?? Promise.resolve();
      let succeeded = false;
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          if (
            get().authorization.kind !== "ready" ||
            (activeOnly && get().activeChatId !== chatId) ||
            !documentIsVisible()
          ) {
            return;
          }
          await transport.markChatRead(chatId);
          succeeded = true;
        })
        .catch((error) => {
          set({ operationError: error instanceof Error ? error.message : "无法更新已读状态" });
        });
      const tracked = operation.finally(() => {
        if (readRequestChains.get(chatId) === tracked) readRequestChains.delete(chatId);
      });
      readRequestChains.set(chatId, tracked);
      return tracked.then(() => succeeded);
    };

    const markForumTopicRead = async (chatId: string, topicId: string) => {
      if (
        get().authorization.kind !== "ready" ||
        get().activeChatId !== chatId ||
        get().activeTopicId !== topicId ||
        !documentIsVisible()
      ) return false;
      const messages = get().messages.get(chatId) ?? [];
      let latestIncoming: Message | undefined;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.topicId === topicId && !message.outgoing) {
          latestIncoming = message;
          break;
        }
      }
      if (!latestIncoming) return false;
      const topic = get().forumTopics.get(chatId)?.find((candidate) => candidate.id === topicId);
      if (
        topic?.lastReadInboxMessageId === latestIncoming.id &&
        topic.unreadCount === 0 &&
        topic.unreadMentionCount === 0 &&
        topic.unreadReactionCount === 0
      ) return false;
      try {
        await transport.markForumTopicRead(chatId, topicId, latestIncoming.id);
        const forumTopics = new Map(get().forumTopics);
        forumTopics.set(chatId, (forumTopics.get(chatId) ?? []).map((topic) => topic.id === topicId
          ? {
              ...topic,
              unreadCount: 0,
              unreadMentionCount: 0,
              unreadReactionCount: 0,
              lastReadInboxMessageId: latestIncoming.id,
            }
          : topic));
        set({ forumTopics });
        return true;
      } catch (error) {
        set({ operationError: errorMessage(error, "无法更新话题已读状态") });
        return false;
      }
    };

    const markActiveConversationRead = (chatId: string) => {
      const current = get();
      if (current.activeChatId !== chatId) return Promise.resolve(false);
      if (current.chats.get(chatId)?.isForum) {
        return current.activeTopicId
          ? markForumTopicRead(chatId, current.activeTopicId)
          : Promise.resolve(false);
      }
      return markChatRead(chatId);
    };

    const scheduleChatRead = (chatId: string, delayMs = 120) => {
      const currentTimer = readTimers.get(chatId);
      if (currentTimer) globalThis.clearTimeout(currentTimer);
      readTimers.set(chatId, globalThis.setTimeout(() => {
        readTimers.delete(chatId);
        void markActiveConversationRead(chatId);
      }, delayMs));
    };

    const applyEvent = (event: TelegramEvent) => {
      if (event.type === "authorization.changed") {
        set({
          authorization: event.state,
          authorizationPending: false,
          authorizationError: undefined,
        });
        if (event.state.kind === "ready") {
          scheduleCacheWrite();
          draftSync.resumePending();
          void flushOutbox();
          const activeChatId = get().activeChatId;
          if (activeChatId) {
            const activeTopicId = get().activeTopicId;
            if (get().chats.get(activeChatId)?.isForum) {
              if (activeTopicId) loadActiveForumTopic(activeChatId, activeTopicId);
              void refreshForumConversation(activeChatId);
            } else {
              void loadHistory(activeChatId, "ensure").then(() => markChatRead(activeChatId));
            }
          }
        } else if (event.state.kind !== "preparing") {
          if (event.state.kind === "closing" || event.state.kind === "closed") {
            set({ connectionStatus: "offline" });
          }
          clearCachedData(!accountTransition);
        }
        return;
      }

      if (event.type === "connection.changed") {
        set({ connectionStatus: event.status });
        if (event.status === "online") void flushOutbox();
        return;
      }

      if (event.type === "currentUser.changed") {
        set({ currentUserId: event.userId });
        scheduleCacheWrite();
        void registerCurrentAccount();
        return;
      }

      if (event.type === "sync.error") {
        set({
          phase: event.fatal ? "error" : get().phase,
          connectionStatus: event.fatal ? "offline" : get().connectionStatus,
          error: event.fatal ? event.message : get().error,
          operationError: event.fatal ? undefined : event.message,
        });
        return;
      }

      if (event.type === "folders.replaced") {
        const folders = event.folders;
        const activeFolderExists = folders.some(
          (folder) => folder.id === get().chatFilter,
        );
        set({
          folders,
          chatFilter: activeFolderExists
            ? get().chatFilter
            : (folders[0]?.id ?? "main"),
        });
        scheduleCacheWrite();
        return;
      }

      if (event.type === "chats.upserted" || event.type === "chat.upsert") {
        const incomingChats = event.type === "chats.upserted" ? event.chats : [event.chat];
        const previousChats = get().chats;
        const activeChatId = get().activeChatId;
        const previousActiveChat = activeChatId ? previousChats.get(activeChatId) : undefined;
        const chats = new Map(previousChats);
        for (const chat of incomingChats) {
          chats.set(chat.id, chat);
        }
        const firstChat = get().activeChatId
          ? undefined
          : [...chats.values()].sort(compareChats)[0]?.id;
        const activeChat = activeChatId ? chats.get(activeChatId) : undefined;
        const activeChatModeChanged = Boolean(
          activeChatId &&
          activeChat &&
          (!previousActiveChat || previousActiveChat.isForum !== activeChat.isForum),
        );
        set({
          chats,
          chatListReady: true,
          activeChatId: get().activeChatId ?? firstChat,
          activeTopicId: activeChatModeChanged && !activeChat?.isForum
            ? undefined
            : get().activeTopicId,
        });
        scheduleCacheWrite();
        if (activeChatModeChanged && activeChatId && activeChat) {
          if (activeChat.isForum) void refreshForumConversation(activeChatId);
          else void loadHistory(activeChatId, "ensure").then(() => markChatRead(activeChatId));
        }
        if (firstChat) {
          if (chats.get(firstChat)?.isForum) void refreshForumConversation(firstChat);
          else void loadHistory(firstChat, "ensure").then(() => markChatRead(firstChat));
        }
        return;
      }

      if (event.type === "user.upsert") {
        const users = new Map(get().users);
        users.set(event.user.id, event.user);
        set({ users });
        scheduleCacheWrite();
        if (event.user.id === get().currentUserId) void registerCurrentAccount();
        return;
      }

      if (event.type === "chat.typingChanged") {
        if (event.senderId !== get().currentUserId) {
          setTypingUser(event.chatId, event.senderId, event.typing);
        }
        return;
      }

      if (event.type === "forumTopics.changed") {
        if (get().chats.get(event.chatId)?.isForum) {
          void refreshForumConversation(event.chatId, true);
        }
        return;
      }

      if (event.type === "message.remove") {
        const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
        const unreadAttention = (unreadAttentionMessageIds.get(event.chatId) ?? [])
          .filter((messageId) => messageId !== event.messageId);
        if (unreadAttention.length > 0) unreadAttentionMessageIds.set(event.chatId, unreadAttention);
        else unreadAttentionMessageIds.delete(event.chatId);
        liveAttentionCandidates.delete(`${event.chatId}:${event.messageId}`);
        if (event.immediate) {
          const messages = new Map(get().messages);
          messages.set(event.chatId, (messages.get(event.chatId) ?? []).filter((message) => message.id !== event.messageId));
          const removingMessages = new Map(get().removingMessages);
          removingMessages.set(event.chatId, (removingMessages.get(event.chatId) ?? []).filter((message) => message.id !== event.messageId));
          if (removingMessages.get(event.chatId)?.length === 0) removingMessages.delete(event.chatId);
          set({ messages, removingMessages, unreadAttentionMessageIds });
          return;
        }
        set({ unreadAttentionMessageIds });
        markMessageRemoving(event.chatId, event.messageId);
        scheduleCacheWrite();
        return;
      }

      if (event.type === "message.replace") {
        const chatId = event.message.chatId;
        transferMessageEntrance(chatId, event.oldMessageId, event.message);
        const oldKey = `${chatId}:${event.oldMessageId}`;
        const removalTimer = removalTimers.get(oldKey);
        if (removalTimer) globalThis.clearTimeout(removalTimer);
        removalTimers.delete(oldKey);

        const messages = new Map(get().messages);
        messages.set(
          chatId,
          replaceMessage(messages.get(chatId) ?? [], event.oldMessageId, event.message),
        );
        const removingMessages = new Map(get().removingMessages);
        const ghosts = (removingMessages.get(chatId) ?? []).filter(
          (message) => message.id !== event.oldMessageId && message.id !== event.message.id,
        );
        if (ghosts.length > 0) removingMessages.set(chatId, ghosts);
        else removingMessages.delete(chatId);
        set({ messages, removingMessages });
        scheduleCacheWrite();
        return;
      }

      if (event.type === "messages.upserted") {
        if (event.messages.length === 0) return;
        const mergeStartedAt = performance.now();
        const messages = new Map(get().messages);
        const incomingByChat = new Map<string, typeof event.messages>();
        let beforeCount = 0;
        for (const message of event.messages) {
          const chatMessages = incomingByChat.get(message.chatId) ?? [];
          chatMessages.push(message);
          incomingByChat.set(message.chatId, chatMessages);
        }
        for (const [chatId, incoming] of incomingByChat) {
          const existing = messages.get(chatId) ?? [];
          beforeCount += existing.length;
          messages.set(chatId, upsertMessages(existing, incoming).map((message) => ({ ...message, isRemoving: false })));
          const removingMessages = new Map(get().removingMessages);
          const incomingIds = new Set(incoming.map((message) => message.id));
          const ghosts = (removingMessages.get(chatId) ?? []).filter((message) => !incomingIds.has(message.id));
          if (ghosts.length > 0) removingMessages.set(chatId, ghosts); else removingMessages.delete(chatId);
          set({ removingMessages });
        }
        set({ messages });
        logPerformance("ui_history_merge", {
          durationMs: performance.now() - mergeStartedAt,
          batchCount: event.messages.length,
          beforeCount,
          afterCount: [...incomingByChat.keys()].reduce(
            (total, chatId) => total + (messages.get(chatId)?.length ?? 0),
            0,
          ),
          traceId: getActiveConversationTraceId(),
          duringConversationSwitch: getActiveConversationTraceId() !== undefined,
        });
        const activeChatId = get().activeChatId;
        if (activeChatId && event.messages.some(
          (message) => message.chatId === activeChatId &&
            !message.outgoing &&
            (!get().chats.get(activeChatId)?.isForum || (
              Boolean(get().activeTopicId) && message.topicId === get().activeTopicId
            )),
        )) {
          scheduleChatRead(activeChatId);
        }
        scheduleCacheWrite();
        return;
      }

      if (event.type === "chat.draftChanged") {
        if (event.draft?.topicId) {
          const key = topicKey(event.chatId, event.draft.topicId);
          const drafts = new Map(get().drafts);
          if (event.draft.text || event.draft.replyToMessageId) drafts.set(key, { ...event.draft, pending: false });
          else drafts.delete(key);
          set({ drafts });
          scheduleCacheWrite();
          return;
        }
        draftSync.acceptServerDraft(event.chatId, event.draft);
        return;
      }

      if (event.type === "drafts.replaced") {
        draftSync.replaceServerDrafts(event.drafts, event.chatIds);
        return;
      }

      const messages = new Map(get().messages);
      const existingMessages = messages.get(event.message.chatId) ?? [];
      queueLiveMessageAttention(event.message, event.animateEntrance === true);
      if (
        event.animateEntrance &&
        !existingMessages.some((message) => message.id === event.message.id)
      ) {
        markMessageEntrance(event.message);
      }
      if (!event.message.outgoing) {
        setTypingUser(event.message.chatId, event.message.senderId, false);
      }
      messages.set(
        event.message.chatId,
        upsertMessage(existingMessages, event.message),
      );
      set({ messages });
      if (
        !event.message.outgoing &&
        event.message.chatId === get().activeChatId &&
        (!get().chats.get(event.message.chatId)?.isForum || (
          Boolean(get().activeTopicId) && event.message.topicId === get().activeTopicId
        ))
      ) {
        scheduleChatRead(event.message.chatId);
      }
      scheduleCacheWrite();
    };

    if (import.meta.env.VITE_WEBVIEW_STRESS === "1") {
      (
        globalThis as typeof globalThis & {
          __notgramWebviewStressDispatch?: (event: TelegramEvent) => void;
        }
      ).__notgramWebviewStressDispatch = (event) => {
        globalThis.queueMicrotask(() => applyEvent(event));
      };
    }

    const selectAccountAndReload = async (accountId: string) => {
      const current = get();
      if (accountId === current.activeAccountId && current.authorization.kind === "ready") {
        return true;
      }
      const previousAccountId = current.activeAccountId;
      const discardPreviousAccount = shouldDiscardUnregisteredAccount(
        current.accounts,
        previousAccountId,
        accountId,
      );
      let disconnected = false;
      accountTransition = true;
      registeredAccountKey = undefined;
      set({
        accountPending: true,
        accountError: undefined,
        error: undefined,
        operationError: undefined,
      });
      try {
        await accountRegistration;
        await draftSync.flushPending();
        await flushCachedSnapshot();
        await transport.disconnect();
        disconnected = true;
        if (discardPreviousAccount) {
          await transport.removeAccount(previousAccountId);
        }
        applyAccountState(await transport.selectAccount(accountId));
        reloadApplication();
        return true;
      } catch (error) {
        accountTransition = false;
        set({
          accountPending: false,
          accountError: error instanceof Error ? error.message : "无法切换账号",
        });
        if (disconnected) reloadApplication();
        return false;
      }
    };

    const manageChat = async (
      chatId: string,
      fallbackError: string,
      confirmationError: string,
      operation: () => Promise<void>,
      confirmed: () => boolean,
    ) => {
      const state = get();
      if (
        state.authorization.kind !== "ready" ||
        !state.chats.has(chatId) ||
        state.chatManagementPending.has(chatId)
      ) return false;

      const pending = new Set(state.chatManagementPending);
      pending.add(chatId);
      set({ chatManagementPending: pending, operationError: undefined });
      try {
        await operation();
        if (!confirmed()) throw new Error(confirmationError);
        await flushCachedSnapshot();
        return true;
      } catch (error) {
        set({ operationError: errorMessage(error, fallbackError) });
        return false;
      } finally {
        const latestPending = new Set(get().chatManagementPending);
        latestPending.delete(chatId);
        set({ chatManagementPending: latestPending });
      }
    };

    const manageFolder = async <T,>(
      fallbackError: string,
      confirmationError: string,
      operation: () => Promise<T>,
      confirmed: (result: T) => boolean,
    ): Promise<T | undefined> => {
      if (get().authorization.kind !== "ready" || get().folderManagementPending) {
        return undefined;
      }
      set({ folderManagementPending: true, operationError: undefined });
      try {
        const result = await operation();
        if (!confirmed(result)) throw new Error(confirmationError);
        await flushCachedSnapshot();
        return result;
      } catch (error) {
        set({ operationError: errorMessage(error, fallbackError) });
        return undefined;
      } finally {
        set({ folderManagementPending: false });
      }
    };

    const profileController = createProfileController({
      transport,
      get,
      set,
      scheduleCacheWrite,
      registerCurrentAccount,
      onError: errorMessage,
    });
    const { setOutbox, persistOutboxState, flushOutbox } = createOutboxController({
      transport,
      get,
      set,
      flushCachedSnapshot,
      topicKey,
      onError: errorMessage,
    });
    const forumController = createForumController({
      transport,
      get,
      set,
      topicKey,
      onError: errorMessage,
      onTopicsLoaded: (chatId, query) => {
        if (!query.trim()) forumTopicsRefreshedAt.set(chatId, Date.now());
      },
    });
    const touchForumTopic = (chatId: string, topicId: string) => {
      const next = new Map(get().lastForumTopicIds);
      next.delete(chatId);
      next.set(chatId, topicId);
      return next;
    };
    const restorableForumTopicId = (chatId: string, topics = get().forumTopics.get(chatId) ?? []) => {
      const remembered = get().lastForumTopicIds.get(chatId);
      if (remembered && (topics.length === 0 || topics.some((topic) => topic.id === remembered))) {
        return remembered;
      }
      return topics.find((topic) => !topic.isHidden)?.id ?? topics[0]?.id;
    };
    const loadActiveForumTopic = (chatId: string, topicId: string) => {
      if (get().authorization.kind !== "ready") return;
      void loadForumTopicHistory(chatId, topicId, "ensure")
        .then(() => markForumTopicRead(chatId, topicId));
    };
    const refreshForumConversation = async (chatId: string, changed = false) => {
      const topics = get().forumTopics.get(chatId) ?? [];
      const refreshedAt = forumTopicsRefreshedAt.get(chatId) ?? 0;
      const minimumAge = changed
        ? FORUM_TOPICS_CHANGE_COALESCE_MS
        : FORUM_TOPICS_REFRESH_TTL_MS;
      if (topics.length > 0 && Date.now() - refreshedAt < minimumAge) return;
      const page = await forumController.loadForumTopics(chatId);
      if (!page || get().activeChatId !== chatId || !get().chats.get(chatId)?.isForum) return;
      const currentTopicId = get().activeTopicId;
      if (currentTopicId && page.topics.some((topic) => topic.id === currentTopicId)) return;
      const nextTopicId = restorableForumTopicId(chatId, page.topics);
      if (nextTopicId) await get().selectForumTopic(nextTopicId);
      else set({ activeTopicId: undefined });
    };
    const sessionController = createSessionController({
      transport,
      set,
      onError: errorMessage,
    });

    return {
      phase: "idle",
      transportKind: transport.kind,
      transportLabel: transport.label,
      connectionStatus: "offline",
      authorization: { kind: "preparing" },
      authorizationPending: false,
      accounts: [],
      activeAccountId: "default",
      accountPending: false,
      proxyPending: false,
      storagePending: false,
      cacheUsage: undefined,
      cacheCleanupResult: undefined,
      cacheHealth: "empty",
      users: new Map(),
      folders: [],
      chats: new Map(),
      chatListReady: false,
      chatLists: new Map(),
      messages: new Map(),
      removingMessages: new Map(),
      unreadAttentionMessageIds: new Map(),
      drafts: new Map(),
      typingUserIds: new Map(),
      outbox: [],
      histories: new Map(),
      forumTopics: new Map(),
      forumTopicsLoading: new Set(),
      topicHistories: new Map(),
      lastForumTopicIds: new Map(),
      activeTopicId: undefined,
      searchQuery: "",
      chatFilter: "main",
      globalSearch: emptyGlobalSearch(),
      accountProfile: emptyProfileState(),
      profile: emptyProfileState(),
      contacts: [],
      contactsLoading: false,
      chatManagementPending: new Set(),
      groupManagement: undefined,
      groupManagementLoading: false,
      groupManagementError: undefined,
      blockedSenders: [],
      blockedSendersLoading: false,
      folderManagementPending: false,
      chatCreationPending: false,

      initialize: async (options = {}) => {
        if (get().phase !== "idle") return;
        const settingsOnly = options.settingsOnly === true;
        set({
          phase: "loading",
          connectionStatus: "connecting",
          error: undefined,
          operationError: undefined,
        });
        try {
          applyAccountState(await transport.getAccountState());
          if (!settingsOnly) {
            try {
              hydrateCachedSnapshot(await transport.loadCachedSnapshot());
            } catch {
              // A corrupt or unavailable cache must not block the live connection.
              set({ cacheHealth: "invalid" });
              void transport.clearCachedSnapshot().catch(() => undefined);
            }
          }
          const snapshot = await transport.connect(applyEvent, { settingsOnly });
          const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
          const users = new Map(snapshot.users.map((user) => [user.id, user]));
          const folders = snapshot.folders;
          const messages = messageMapFrom(snapshot.messages);
          const drafts = new Map((snapshot.drafts ?? []).map((draft) => [draft.chatId, draft]));
          const current = get();
          for (const [id, chat] of current.chats) chats.set(id, chat);
          for (const [id, user] of current.users) users.set(id, user);
          for (const [chatId, chatMessages] of current.messages) {
            for (const message of chatMessages) {
              messages.set(
                chatId,
                upsertMessage(messages.get(chatId) ?? [], message),
              );
            }
          }
          for (const [chatId, draft] of current.drafts) {
            if (draft.pending || !drafts.has(chatId)) drafts.set(chatId, draft);
          }
          const firstChat = [...chats.values()].sort(
            (left, right) =>
              Number(right.pinned) - Number(left.pinned) ||
              new Date(right.updatedAt).getTime() -
                new Date(left.updatedAt).getTime(),
          )[0];
          const authorization =
            current.authorization.kind === "preparing"
              ? snapshot.authorization
              : current.authorization;
          if (authorization.kind !== "ready" && authorization.kind !== "preparing") {
            clearCachedData();
            set({
              phase: current.phase === "error" ? "error" : "ready",
              authorization,
            });
            return;
          }
          set({
            phase: current.phase === "error" ? "error" : "ready",
            currentUserId:
              current.currentUserId && current.currentUserId !== "self"
                ? current.currentUserId
                : snapshot.currentUserId,
            authorization,
            chats,
            chatListReady: current.chatListReady || snapshot.chats.length > 0,
            users,
            folders: current.folders.length > 0 ? current.folders : folders,
            messages,
            drafts,
            activeChatId: current.activeChatId ?? firstChat?.id,
            chatFilter:
              (current.folders.length > 0 ? current.folders : folders).some(
                (folder) => folder.id === current.chatFilter,
              )
                ? current.chatFilter
                : (folders[0]?.id ?? "main"),
          });
          void registerCurrentAccount();
          if (settingsOnly) return;
          const refreshChatId = get().activeChatId ?? firstChat?.id;
          if (authorization.kind === "ready" && refreshChatId) {
            if (get().chats.get(refreshChatId)?.isForum) {
              const activeTopicId = get().activeTopicId;
              if (activeTopicId) loadActiveForumTopic(refreshChatId, activeTopicId);
              await refreshForumConversation(refreshChatId);
            } else {
              await loadHistory(refreshChatId, "ensure");
              await markChatRead(refreshChatId);
            }
          }
          if (authorization.kind === "ready") {
            draftSync.resumePending();
            void flushOutbox();
          }
          scheduleCacheWrite();
        } catch (error) {
          set({
            phase: "error",
            connectionStatus: "offline",
            error: errorMessage(error, "无法启动 Telegram runtime"),
          });
        }
      },

      authenticate: async (action) => {
        set({ authorizationPending: true, authorizationError: undefined });
        try {
          await transport.authenticate(action);
        } catch (error) {
          set({
            authorizationPending: false,
            authorizationError:
              error instanceof Error ? error.message : "登录请求失败",
          });
        }
      },

      loadProxySettings: async () => {
        set({ proxyPending: true, proxyError: undefined, proxyLatencyMs: undefined });
        try {
          const proxySettings = await transport.getProxySettings();
          set({ proxySettings, proxyPending: false });
        } catch (error) {
          set({
            proxyPending: false,
            proxyError: error instanceof Error ? error.message : "无法读取代理设置",
          });
        }
      },

      saveProxySettings: async (proxySettings) => {
        set({ proxyPending: true, proxyError: undefined, proxyLatencyMs: undefined });
        try {
          await transport.saveProxySettings(proxySettings);
          set({ proxySettings, proxyPending: false });
          return true;
        } catch (error) {
          set({
            proxyPending: false,
            proxyError: error instanceof Error ? error.message : "无法保存代理设置",
          });
          return false;
        }
      },

      testProxy: async (proxySettings) => {
        set({ proxyPending: true, proxyError: undefined, proxyLatencyMs: undefined });
        try {
          const proxyLatencyMs = await transport.testProxy(proxySettings);
          set({ proxyLatencyMs, proxyPending: false });
        } catch (error) {
          set({
            proxyPending: false,
            proxyError: error instanceof Error ? error.message : "代理连接失败",
          });
        }
      },

      loadStorageSettings: async () => {
        set({ storagePending: true, storageError: undefined });
        try {
          const storageSettings = await transport.getStorageSettings();
          set({ storageSettings, storagePending: false });
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : "无法读取存储路径设置",
          });
        }
      },

      saveStorageSettings: async (storageSettings) => {
        set({ storagePending: true, storageError: undefined });
        try {
          const saved = await transport.saveStorageSettings(storageSettings);
          set({ storageSettings: saved, storagePending: false });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : "无法保存存储路径设置",
          });
          return false;
        }
      },

      loadCacheUsage: async () => {
        set({ storagePending: true, storageError: undefined });
        try {
          const cacheUsage = await transport.getCacheUsage();
          set({ cacheUsage, storagePending: false });
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : "无法统计媒体缓存",
          });
        }
      },

      clearMediaCache: async (categories, olderThanDays) => {
        if (categories.length === 0) {
          set({ storageError: "至少选择一种缓存类型" });
          return false;
        }
        const current = get();
        set({ storagePending: true, storageError: undefined, cacheCleanupResult: undefined });
        try {
          const result = await transport.clearMediaCache({
            categories,
            olderThanDays,
            protectedPaths: protectedCachePaths({
              accounts: current.accounts,
              users: current.users.values(),
              chats: current.chats.values(),
              messages: current.messages.values(),
            }),
          });
          set({
            cacheUsage: result.usage,
            cacheCleanupResult: result,
            storagePending: false,
          });
          return true;
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : "无法清理媒体缓存",
          });
          return false;
        }
      },

      rebuildCachedSnapshot: async () => {
        const current = get();
        if (current.authorization.kind !== "ready" || !current.currentUserId) {
          set({ storageError: "Telegram 就绪后才能重建界面缓存" });
          return false;
        }
        if (cacheTimer) {
          globalThis.clearTimeout(cacheTimer);
          cacheTimer = undefined;
        }
        set({ storagePending: true, storageError: undefined });
        try {
          await cacheWrite.catch(() => undefined);
          await transport.clearCachedSnapshot();
          await transport.saveCachedSnapshot(cachedSnapshotFrom(
            get(),
            profileController.getCachedProfiles(),
          ));
          set({ cacheHealth: "rebuilt", storagePending: false });
          return true;
        } catch (error) {
          set({
            cacheHealth: "invalid",
            storagePending: false,
            storageError: error instanceof Error ? error.message : "无法重建界面缓存",
          });
          return false;
        }
      },

      addAccount: async () => {
        const accountId = `account-${globalThis.crypto.randomUUID()}`;
        return selectAccountAndReload(accountId);
      },

      switchAccount: selectAccountAndReload,

      logOutCurrentAccount: async () => {
        const accountId = get().activeAccountId;
        let disconnected = false;
        accountTransition = true;
        registeredAccountKey = undefined;
        set({
          accountPending: true,
          accountError: undefined,
          error: undefined,
          operationError: undefined,
        });
        try {
          await accountRegistration;
          await draftSync.flushPending();
          await flushCachedSnapshot();
          await transport.logOut();
          await transport.disconnect();
          disconnected = true;
          applyAccountState(await transport.removeAccount(accountId));
          reloadApplication();
          return true;
        } catch (error) {
          accountTransition = false;
          set({
            accountPending: false,
            accountError: error instanceof Error ? error.message : "退出登录失败",
          });
          if (disconnected) reloadApplication();
          return false;
        }
      },

      selectChat: async (chatId, options) => {
        const previousChatId = get().activeChatId;
        const previousTopicId = get().activeTopicId;
        if (previousChatId && previousChatId !== chatId) {
          void draftSync.flush(topicKey(previousChatId, previousTopicId));
        }
        const targetChat = get().chats.get(chatId);
        const restoredTopicId = targetChat?.isForum
          ? options?.forumTopicId ?? restorableForumTopicId(chatId)
          : undefined;
        const lastForumTopicIds = restoredTopicId
          ? touchForumTopic(chatId, restoredTopicId)
          : new Map(get().lastForumTopicIds);
        set({
          activeChatId: chatId,
          activeTopicId: restoredTopicId,
          lastForumTopicIds,
        });
        scheduleCacheWrite();
        if (get().authorization.kind !== "ready") return;
        if (targetChat?.isForum) {
          if (restoredTopicId) loadActiveForumTopic(chatId, restoredTopicId);
          void refreshForumConversation(chatId);
        } else {
          void loadHistory(chatId, "ensure");
          void markChatRead(chatId);
        }
      },

      selectForumTopic: async (topicId) => {
        const chatId = get().activeChatId;
        if (!chatId || !get().chats.get(chatId)?.isForum) return;
        const previousTopicId = get().activeTopicId;
        if (previousTopicId && previousTopicId !== topicId) void draftSync.flush(topicKey(chatId, previousTopicId));
        const lastForumTopicIds = topicId
          ? touchForumTopic(chatId, topicId)
          : new Map(get().lastForumTopicIds);
        set({ activeTopicId: topicId, lastForumTopicIds });
        scheduleCacheWrite();
        if (topicId) loadActiveForumTopic(chatId, topicId);
      },

      loadForumTopics: forumController.loadForumTopics,
      createForumTopic: forumController.createForumTopic,
      editForumTopic: forumController.editForumTopic,
      setForumTopicClosed: forumController.setForumTopicClosed,
      setForumTopicPinned: forumController.setForumTopicPinned,

      resolveTelegramLink: async (url) => {
        try {
          return await transport.resolveTelegramLink(url);
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "Telegram 链接无法打开" });
          return undefined;
        }
      },

      loadMoreChats: loadChats,
      setChatPinned: (chatListId, chatId, pinned) => manageChat(
        chatId,
        "无法更新置顶状态",
        "Telegram 未确认置顶状态",
        () => transport.setChatPinned(chatListId, chatId, pinned),
        () => {
          const chat = get().chats.get(chatId);
          return Boolean(chat) && isChatPinnedInFolder(chat!, chatListId) === pinned;
        },
      ),
      reorderPinnedChats: async (chatListId, orderedChatIds) => {
        const pinnedChats = filterAndSortChats(get().chats.values(), chatListId, "")
          .filter((chat) => isChatPinnedInFolder(chat, chatListId));
        const currentIds = pinnedChats.map((chat) => chat.id);
        const uniqueIds = [...new Set(orderedChatIds)];
        if (
          uniqueIds.length !== currentIds.length ||
          uniqueIds.some((chatId) => !currentIds.includes(chatId))
        ) return false;
        if (uniqueIds.every((chatId, index) => chatId === currentIds[index])) return true;

        const originalChats = new Map(pinnedChats.map((chat) => [chat.id, chat]));
        const optimisticOrders = new Map<string, string>();
        const chats = new Map(get().chats);
        const rankBase = BigInt(uniqueIds.length);
        for (const [index, chatId] of uniqueIds.entries()) {
          const chat = chats.get(chatId);
          if (!chat) return false;
          const order = String(rankBase - BigInt(index));
          optimisticOrders.set(chatId, order);
          chats.set(chatId, {
            ...chat,
            listOrderByFolder: { ...chat.listOrderByFolder, [chatListId]: order },
          });
        }
        set({ chats, operationError: undefined });

        try {
          await transport.setPinnedChats(chatListId, uniqueIds);
          await flushCachedSnapshot();
          return true;
        } catch (error) {
          const latestChats = get().chats;
          const stillOptimistic = uniqueIds.every((chatId) =>
            latestChats.get(chatId)?.listOrderByFolder?.[chatListId] ===
              optimisticOrders.get(chatId),
          );
          if (stillOptimistic) {
            const rollback = new Map(latestChats);
            for (const [chatId, chat] of originalChats) rollback.set(chatId, chat);
            set({ chats: rollback });
          }
          set({
            operationError: error instanceof Error ? error.message : "无法调整置顶顺序",
          });
          return false;
        }
      },
      setChatMuted: (chatId, muted) => {
        if (get().chats.get(chatId)?.kind === "saved") {
          set({ operationError: "收藏夹不支持静音" });
          return Promise.resolve(false);
        }
        return manageChat(
          chatId,
          "无法更新通知设置",
          "Telegram 未确认静音状态",
          () => transport.setChatMuted(chatId, muted),
          () => get().chats.get(chatId)?.muted === muted,
        );
      },
      setChatArchived: (chatId, archived) => manageChat(
        chatId,
        archived ? "无法归档会话" : "无法移出归档",
        `Telegram 未确认${archived ? "归档" : "取消归档"}状态`,
        () => transport.setChatArchived(chatId, archived),
        () => get().chats.get(chatId)?.folderIds.includes(
          archived ? "archive" : "main",
        ) === true,
      ),
      leaveGroup: async (chatId) => {
        const chat = get().chats.get(chatId);
        if (chat?.kind !== "group") {
          set({ operationError: "只能退出群组会话" });
          return false;
        }
        const succeeded = await manageChat(
          chatId,
          "无法退出群组",
          "Telegram 未确认退出群组",
          () => transport.leaveChat(chatId),
          () => get().chats.get(chatId)?.folderIds.length === 0,
        );
        if (!succeeded || get().activeChatId !== chatId) return succeeded;

        const nextChat = filterAndSortChats(
          get().chats.values(),
          get().chatFilter,
          "",
        )[0];
        const lastForumTopicIds = new Map(get().lastForumTopicIds);
        lastForumTopicIds.delete(chatId);
        set({ lastForumTopicIds });
        if (nextChat) await get().selectChat(nextChat.id);
        else {
          set({ activeChatId: undefined, activeTopicId: undefined });
          scheduleCacheWrite();
        }
        return true;
      },
      createChatFolder: async (title, chatIds) => {
        const uniqueChatIds = [...new Set(chatIds)].filter((chatId) => get().chats.has(chatId));
        if (uniqueChatIds.length === 0) {
          set({ operationError: "请至少选择一个会话" });
          return undefined;
        }
        const folder = await manageFolder(
          "无法创建文件夹",
          "Telegram 未确认新文件夹",
          () => transport.createChatFolder(title, uniqueChatIds),
          (created) => get().folders.some((item) =>
            item.id === created.id && item.title === created.title
          ) && uniqueChatIds.every((chatId) =>
            get().chats.get(chatId)?.folderIds.includes(created.id)
          ),
        );
        return folder?.id;
      },
      renameChatFolder: async (folderId, title) => Boolean(await manageFolder(
        "无法重命名文件夹",
        "Telegram 未确认文件夹名称",
        () => transport.renameChatFolder(folderId, title),
        (renamed) => get().folders.some((folder) =>
          folder.id === folderId && folder.title === renamed.title
        ),
      )),
      deleteChatFolder: async (folderId) => Boolean(await manageFolder(
        "无法删除文件夹",
        "Telegram 未确认文件夹删除",
        async () => {
          await transport.deleteChatFolder(folderId);
          return true;
        },
        () => !get().folders.some((folder) => folder.id === folderId) &&
          [...get().chats.values()].every((chat) => !chat.folderIds.includes(folderId)),
      )),
      setChatFolderMembership: async (folderId, chatId, included) => Boolean(
        await manageFolder(
          "无法更新文件夹成员",
          "Telegram 未确认文件夹成员状态",
          async () => {
            await transport.setChatFolderMembership(folderId, chatId, included);
            return true;
          },
          () => get().chats.get(chatId)?.folderIds.includes(folderId) === included,
        )
      ),
      markChatFolderRead: async (folderId) => {
        const state = get();
        if (
          state.authorization.kind !== "ready" ||
          state.folderManagementPending ||
          !state.folders.some((folder) => folder.id === folderId)
        ) return false;
        const unreadChatIds = [...state.chats.values()]
          .filter((chat) => chat.folderIds.includes(folderId) && chat.unreadCount > 0)
          .map((chat) => chat.id);
        if (unreadChatIds.length === 0) return true;

        set({ folderManagementPending: true, operationError: undefined });
        try {
          const results = await Promise.all(
            unreadChatIds.map((chatId) => markChatRead(chatId, false)),
          );
          if (results.some((result) => !result)) return false;
          scheduleCacheWrite();
          return true;
        } finally {
          set({ folderManagementPending: false });
        }
      },
      loadMoreHistory: (chatId) => {
        const topicId = get().activeChatId === chatId ? get().activeTopicId : undefined;
        return topicId ? loadForumTopicHistory(chatId, topicId, "older") : loadHistory(chatId, "older");
      },
      loadMessage: async (chatId, messageId) => {
        if ((get().messages.get(chatId) ?? []).some((message) => message.id === messageId)) {
          return true;
        }
        if (get().authorization.kind !== "ready") return false;
        try {
          const context = await transport.getMessageContext(chatId, messageId, 31);
          let message = context.find((item) =>
            item.chatId === chatId && item.id === messageId
          );
          if (!message) message = await transport.getMessage(chatId, messageId);
          if (!message || message.chatId !== chatId || message.id !== messageId) return false;
          const messages = new Map(get().messages);
          messages.set(
            chatId,
            upsertMessages(
              messages.get(chatId) ?? [],
              [...context.filter((item) => item.chatId === chatId), message],
            ),
          );
          set({ messages, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch {
          return false;
        }
      },
      markActiveChatRead: async () => {
        const chatId = get().activeChatId;
        if (chatId) await markActiveConversationRead(chatId);
      },

      dismissMessageAttention: (chatId, messageId) => {
        const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
        const remaining = (unreadAttentionMessageIds.get(chatId) ?? [])
          .filter((candidate) => candidate !== messageId);
        if (remaining.length > 0) unreadAttentionMessageIds.set(chatId, remaining);
        else unreadAttentionMessageIds.delete(chatId);
        set({ unreadAttentionMessageIds });
      },

      loadMessageProperties: async (chatId, messageId) => {
        const requestedMessage = (get().messages.get(chatId) ?? [])
          .find((message) => message.id === messageId);
        if (!requestedMessage) return undefined;
        if (requestedMessage.permissions) return requestedMessage.permissions;
        try {
          const permissions = await transport.getMessageProperties(chatId, messageId);
          const currentMessages = get().messages.get(chatId) ?? [];
          const message = currentMessages.find((item) => item.id === messageId);
          if (!message || message !== requestedMessage) return undefined;
          const messages = new Map(get().messages);
          messages.set(chatId, upsertMessage(currentMessages, { ...message, permissions }));
          set({ messages, operationError: undefined });
          return permissions;
        } catch (error) {
          set({
            operationError: error instanceof Error ? error.message : "无法读取消息操作权限",
          });
          return undefined;
        }
      },

      searchChatMessages: searchController.searchChatMessages,
      searchGlobal: searchController.searchGlobal,
      loadMoreGlobalSearch: searchController.loadMoreGlobalSearch,
      cancelGlobalSearch: searchController.cancelGlobalSearch,
      clearGlobalSearch: searchController.clearGlobalSearch,

      loadCurrentUserProfile: profileController.loadCurrentUserProfile,
      updateCurrentUserProfile: profileController.updateCurrentUserProfile,
      changeCurrentUserAvatar: profileController.changeCurrentUserAvatar,

      loadChatProfile: profileController.loadChatProfile,

      loadMoreChatProfileMembers: profileController.loadMoreChatProfileMembers,

      loadUserProfile: profileController.loadUserProfile,

      clearProfile: profileController.clearProfile,

      loadContacts: profileController.loadContacts,

      startPrivateChat: async (userId) => {
        set({ contactPendingUserId: userId, contactsError: undefined });
        try {
          const chat = await transport.createPrivateChat(userId);
          const chats = new Map(get().chats);
          chats.set(chat.id, chat);
          set({ chats, contactPendingUserId: undefined });
          scheduleCacheWrite();
          return chat.id;
        } catch (error) {
          set({
            contactPendingUserId: undefined,
            contactsError: errorMessage(error, "无法发起私聊"),
          });
          return undefined;
        }
      },

      createChat: async (input) => {
        if (get().chatCreationPending) return undefined;
        set({ chatCreationPending: true, operationError: undefined });
        try {
          const chat = await transport.createChat(input);
          const chats = new Map(get().chats);
          chats.set(chat.id, chat);
          const messages = new Map(get().messages);
          if (!messages.has(chat.id)) messages.set(chat.id, []);
          set({
            chats,
            messages,
            activeChatId: chat.id,
            chatCreationPending: false,
            chatFilter: "main",
          });
          scheduleCacheWrite();
          return chat.id;
        } catch (error) {
          set({
            chatCreationPending: false,
            operationError: errorMessage(error, "无法创建群组或频道"),
          });
          return undefined;
        }
      },

      loadChatManagement: (chatId, memberOffset = 0) => {
        const key = `${chatId}:${memberOffset}`;
        const existing = groupManagementLoads.get(key);
        if (existing) return existing;
        const request = (async () => {
          set({ groupManagementLoading: true, groupManagementError: undefined });
          try {
            const value = await transport.getChatManagement(chatId, memberOffset);
            set({ groupManagement: value, groupManagementLoading: false });
            return value;
          } catch (error) {
            set({ groupManagementLoading: false, groupManagementError: errorMessage(error, "无法读取群组管理资料") });
            return undefined;
          } finally {
            groupManagementLoads.delete(key);
          }
        })();
        groupManagementLoads.set(key, request);
        return request;
      },

      addChatMembers: async (chatId, userIds) => {
        try {
          await transport.addChatMembers(chatId, userIds);
          await get().loadChatManagement(chatId, get().groupManagement?.memberOffset ?? 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法添加成员") });
          return false;
        }
      },

      setChatMemberStatus: async (chatId, userId, status) => {
        try {
          await transport.setChatMemberStatus({ chatId, userId, status });
          await get().loadChatManagement(chatId, get().groupManagement?.memberOffset ?? 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法更新成员权限") });
          return false;
        }
      },

      setChatPermissions: async (chatId, permissions) => {
        try {
          await transport.setChatPermissions(chatId, permissions);
          await get().loadChatManagement(chatId, get().groupManagement?.memberOffset ?? 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法更新群组默认权限") });
          return false;
        }
      },

      setChatSlowModeDelay: async (chatId, delaySeconds) => {
        try {
          await transport.setChatSlowModeDelay(chatId, delaySeconds);
          await get().loadChatManagement(chatId, get().groupManagement?.memberOffset ?? 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法更新慢速模式") });
          return false;
        }
      },

      transferChatOwnership: async (chatId, userId, password) => {
        try {
          await transport.transferChatOwnership(chatId, userId, password);
          await get().loadChatManagement(chatId, get().groupManagement?.memberOffset ?? 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法转移所有者") });
          return false;
        }
      },

      loadChatEventLog: async (input) => {
        try {
          const page = await transport.getChatEventLog(input);
          set({ operationError: undefined });
          return page;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法读取管理日志") });
          return undefined;
        }
      },

      getChatInviteLinks: async (input) => {
        try { return await transport.getChatInviteLinks(input); }
        catch (error) { set({ operationError: errorMessage(error, "无法读取邀请链接") }); return undefined; }
      },

      createChatInviteLink: async (input) => {
        try { const link = await transport.createChatInviteLink(input); set({ operationError: undefined }); return link; }
        catch (error) { set({ operationError: errorMessage(error, "无法创建邀请链接") }); return undefined; }
      },

      editChatInviteLink: async (input) => {
        try { const link = await transport.editChatInviteLink(input); set({ operationError: undefined }); return link; }
        catch (error) { set({ operationError: errorMessage(error, "无法编辑邀请链接") }); return undefined; }
      },

      revokeChatInviteLink: async (chatId, inviteLink) => {
        try { await transport.revokeChatInviteLink(chatId, inviteLink); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法撤销邀请链接") }); return false; }
      },

      getChatJoinRequests: async (input) => {
        try { return await transport.getChatJoinRequests(input); }
        catch (error) { set({ operationError: errorMessage(error, "无法读取入群申请") }); return undefined; }
      },

      processChatJoinRequest: async (chatId, userId, approve) => {
        try { await transport.processChatJoinRequest(chatId, userId, approve); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法处理入群申请") }); return false; }
      },

      processChatJoinRequests: async (chatId, inviteLink, approve) => {
        try { await transport.processChatJoinRequests(chatId, inviteLink, approve); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法批量处理入群申请") }); return false; }
      },

      getBotCommandSuggestions: async (chatId, query = "", botUsername) => {
        try { return await transport.getBotCommandSuggestions(chatId, query, botUsername); }
        catch { return []; }
      },

      getCallbackQueryAnswer: async (messageId, data) => {
        const chatId = get().activeChatId;
        if (!chatId) return undefined;
        try {
          const answer = await transport.getCallbackQueryAnswer(chatId, messageId, data);
          set({ operationError: undefined });
          return answer;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法处理机器人操作") });
          return undefined;
        }
      },

      getInlineQueryResults: async (chatId, botUsername, query, offset = "") => {
        try { return await transport.getInlineQueryResults(chatId, botUsername, query, offset); }
        catch (error) { set({ operationError: errorMessage(error, "无法读取机器人 Inline 结果") }); return undefined; }
      },

      sendInlineQueryResultMessage: async (chatId, botUserId, queryId, resultId, replyToMessageId, topicId) => {
        try { await transport.sendInlineQueryResultMessage(chatId, botUserId, queryId, resultId, replyToMessageId, topicId); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法发送 Inline 结果") }); return false; }
      },

      sendBotStartMessage: async (chatId, botUserId, parameter = "") => {
        try { await transport.sendBotStartMessage(chatId, botUserId, parameter); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法启动机器人") }); return false; }
      },

      loadBlockedSenders: async () => {
        set({ blockedSendersLoading: true });
        try { set({ blockedSenders: await transport.getBlockedSenders(), blockedSendersLoading: false }); }
        catch (error) { set({ blockedSendersLoading: false, operationError: errorMessage(error, "无法读取黑名单") }); }
      },

      setMessageSenderBlocked: async (senderId, kind, blocked) => {
        try {
          await transport.setMessageSenderBlocked(senderId, kind, blocked);
          const blockedSenders = blocked ? await transport.getBlockedSenders() : get().blockedSenders.filter((sender) => !(sender.id === senderId && sender.kind === kind));
          set({ blockedSenders, operationError: undefined });
          return true;
        } catch (error) { set({ operationError: errorMessage(error, blocked ? "无法屏蔽对象" : "无法解除屏蔽") }); return false; }
      },

      getChatReportOptions: async (chatId, messageIds) => {
        try { return await transport.getChatReportOptions(chatId, messageIds); }
        catch (error) { set({ operationError: errorMessage(error, "无法读取举报选项") }); return undefined; }
      },

      reportChat: async (input) => {
        try { await transport.reportChat(input); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法提交举报") }); return false; }
      },

      getActiveSessions: sessionController.getActiveSessions,
      terminateSession: sessionController.terminateSession,
      terminateAllOtherSessions: sessionController.terminateAllOtherSessions,
      getPrivacySettingRules: sessionController.getPrivacySettingRules,
      setPrivacySettingRules: sessionController.setPrivacySettingRules,

      setMessageReaction: async (messageId, emoji, chosen) => {
        const chatId = get().activeChatId;
        if (!chatId) return;
        const currentMessages = get().messages.get(chatId) ?? [];
        const original = currentMessages.find((message) => message.id === messageId);
        if (!original) return;
        const optimistic = withEmojiReaction(original, emoji, chosen);
        if (optimistic === original) return;
        const messages = new Map(get().messages);
        messages.set(chatId, upsertMessage(currentMessages, optimistic));
        set({ messages, operationError: undefined });
        try {
          await transport.setMessageReaction({ chatId, messageId, emoji, chosen });
          scheduleCacheWrite();
        } catch (error) {
          const latestMessages = get().messages.get(chatId) ?? [];
          const latest = latestMessages.find((message) => message.id === messageId);
          const latestReaction = latest?.interaction?.reactions.find(
            (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
          );
          if (latest && Boolean(latestReaction?.chosen) === chosen) {
            const rollback = new Map(get().messages);
            rollback.set(chatId, upsertMessage(latestMessages, original));
            set({ messages: rollback });
          }
          set({
            operationError: error instanceof Error ? error.message : "无法更新表情回应",
          });
        }
      },

      setPollAnswer: async (messageId, optionPositions) => {
        const chatId = get().activeChatId;
        if (!chatId) return false;
        try {
          await transport.setPollAnswer({ chatId, messageId, optionPositions });
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({
            operationError: error instanceof Error ? error.message : "无法提交投票",
          });
          return false;
        }
      },

      loadPinnedMessages: async (chatId) => {
        if (!get().chats.has(chatId)) return [];
        try {
          const pinned = await transport.getPinnedMessages(chatId);
          if (get().operationError) set({ operationError: undefined });
          return pinned;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法读取置顶消息") });
          return [];
        }
      },

      pinMessage: async (messageId, disableNotification, onlyForSelf) => {
        const chatId = get().activeChatId;
        if (!chatId) return false;
        try {
          await transport.pinMessage({
            chatId,
            messageId,
            disableNotification,
            onlyForSelf,
          });
          const messages = new Map(get().messages);
          messages.set(chatId, (messages.get(chatId) ?? []).map((message) =>
            message.id === messageId ? { ...message, isPinned: true, permissions: undefined } : message
          ));
          set({ messages, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法置顶消息") });
          return false;
        }
      },

      unpinMessage: async (messageId) => {
        const chatId = get().activeChatId;
        if (!chatId) return false;
        try {
          await transport.unpinMessage(chatId, messageId);
          const messages = new Map(get().messages);
          messages.set(chatId, (messages.get(chatId) ?? []).map((message) =>
            message.id === messageId ? { ...message, isPinned: false, permissions: undefined } : message
          ));
          set({ messages, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法取消置顶消息") });
          return false;
        }
      },

      setChatMessageAutoDeleteTime: async (chatId, messageAutoDeleteTime) => {
        if (!get().chats.has(chatId)) return false;
        try {
          await transport.setChatMessageAutoDeleteTime({
            chatId,
            messageAutoDeleteTime,
          });
          const chats = new Map(get().chats);
          const chat = chats.get(chatId);
          if (chat) chats.set(chatId, { ...chat, messageAutoDeleteTime });
          set({ chats, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法设置自动删除") });
          return false;
        }
      },

      loadSharedMedia: async (input, force = false) => {
        if (!get().chats.has(input.chatId)) return undefined;
        const reset = !input.fromMessageId;
        if (reset && !force) {
          const cached = sharedMediaIndex.read(input);
          if (cached) return cached;
        }
        try {
          const page = await transport.searchSharedMedia(input);
          const merged = sharedMediaIndex.merge(input, page, reset);
          set({ operationError: undefined });
          return merged;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法读取共享媒体") });
          return undefined;
        }
      },

      deleteMessagesFromChat: async (chatId, messageIds, revoke) => {
        const uniqueIds = [...new Set(messageIds)];
        if (!get().chats.has(chatId) || uniqueIds.length === 0 || uniqueIds.length > 100) {
          return false;
        }
        const deletedIds: string[] = [];
        let failure: unknown;
        for (const messageId of uniqueIds) {
          try {
            await transport.deleteMessage({ chatId, messageId, revoke });
            deletedIds.push(messageId);
          } catch (error) {
            failure ??= error;
          }
        }
        if (deletedIds.length > 0) {
          for (const messageId of deletedIds) markMessageRemoving(chatId, messageId);
          sharedMediaIndex.remove(chatId, deletedIds);
          scheduleCacheWrite();
        }
        set({
          operationError: failure
            ? errorMessage(failure, `已删除 ${deletedIds.length} 条，部分消息删除失败`)
            : undefined,
        });
        return !failure;
      },

      loadEmojiPicker: async () => {
        if (get().authorization.kind !== "ready") return undefined;
        try {
          const catalog = await transport.getEmojiPickerCatalog();
          set({ operationError: undefined });
          return catalog;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法读取表情与贴纸") });
          return undefined;
        }
      },

      loadStickerSet: async (stickerSetId) => {
        try {
          const stickerSet = await transport.getStickerSet(stickerSetId);
          set({ operationError: undefined });
          return stickerSet;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法读取贴纸包") });
          return undefined;
        }
      },

      searchStickers: async (query, chatId) => {
        const normalized = query.trim();
        if (!normalized) return [];
        try {
          return await transport.searchStickers(normalized, chatId);
        } catch (error) {
          set({ operationError: errorMessage(error, "无法搜索贴纸") });
          return [];
        }
      },

      loadEmojiAsset: async (asset) => {
        try {
          return await transport.loadEmojiAsset(asset);
        } catch {
          return undefined;
        }
      },

      sendSticker: async (asset, replyToMessageId) => {
        const chatId = get().activeChatId;
        const topicId = get().activeTopicId;
        if (!chatId) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          set({ operationError: "联网后才能发送贴纸" });
          return false;
        }
        try {
          await transport.sendSticker({ chatId, topicId, asset, replyToMessageId });
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "贴纸发送失败") });
          return false;
        }
      },

      sendAnimation: async (asset, replyToMessageId) => {
        const chatId = get().activeChatId;
        const topicId = get().activeTopicId;
        if (!chatId) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          set({ operationError: "联网后才能发送 GIF" });
          return false;
        }
        try {
          await transport.sendAnimation({ chatId, topicId, asset, replyToMessageId });
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, "GIF 发送失败") });
          return false;
        }
      },

      loadRawMessage: async (chatId, messageId) => {
        try {
          const raw = await transport.getRawMessage(chatId, messageId);
          if (!raw) set({ operationError: "找不到原始消息" });
          return raw;
        } catch (error) {
          set({ operationError: errorMessage(error, "无法读取原始消息") });
          return undefined;
        }
      },

      setSearchQuery: searchController.setSearchQuery,
      setChatFilter: (chatFilter) => {
        set({ chatFilter });
        scheduleCacheWrite();
        void loadChats(chatFilter);
      },

      updateChatDraft: (chatId, text, replyToMessageId) => {
        if (!get().chats.has(chatId)) return;
        const topicId = get().activeChatId === chatId ? get().activeTopicId : undefined;
        const key = topicKey(chatId, topicId);
        const current = get().drafts.get(key);
        const next: ChatDraft = {
          chatId,
          topicId,
          text,
          replyToMessageId,
          updatedAt: new Date().toISOString(),
          pending: true,
        };
        if (draftSignature(current) === draftSignature(next)) return;
        const drafts = new Map(get().drafts);
        drafts.set(key, next);
        set({ drafts });
        draftSync.expect(key, draftForSync(next), DRAFT_SYNC_DELAY_MS);
        scheduleCacheWrite();
      },

      setChatTyping: async (chatId, typing) => {
        if (get().authorization.kind !== "ready") return;
        try {
          await transport.setChatTyping(chatId, typing, get().activeChatId === chatId ? get().activeTopicId : undefined);
        } catch {
          // Typing state is ephemeral and must not replace actionable operation errors.
        }
      },

      sendMessage: async (text, replyToMessageId) => {
        const chatId = get().activeChatId;
        const topicId = get().activeTopicId;
        const normalizedText = text.trim();
        if (!chatId || !normalizedText) return false;
        const draftKey = topicKey(chatId, topicId);
        const previousDraft = get().drafts.get(draftKey);
        if (!connectionPresentation(get().connectionStatus).operational) {
          const previousOutbox = get().outbox;
          const previousMessages = get().messages;
          const previousDrafts = get().drafts;
          const item: QueuedOutgoingMessage = {
            id: globalThis.crypto.randomUUID(),
            chatId,
            topicId,
            text: normalizedText,
            replyToMessageId,
            createdAt: new Date().toISOString(),
            status: "queued",
          };
          const outbox = [...previousOutbox, item];
          const drafts = new Map(previousDrafts);
          drafts.delete(draftKey);
          const clearGeneration = draftSync.expect(draftKey, undefined);
          set({
            drafts,
            outbox,
            messages: messagesWithOutbox(
              previousMessages,
              outbox,
              get().currentUserId ?? "self",
            ),
            operationError: undefined,
          });
          try {
            await flushCachedSnapshot();
            return true;
          } catch (error) {
            draftSync.cancelExpectation(draftKey, clearGeneration);
            if (previousDraft?.pending) {
              draftSync.expect(draftKey, draftForSync(previousDraft));
            }
            set({
              drafts: previousDrafts,
              outbox: previousOutbox,
              messages: previousMessages,
              cacheHealth: "invalid",
              operationError: errorMessage(error, "无法保存离线发送队列"),
            });
            return false;
          }
        }
        await draftSync.flush(draftKey);
        const clearGeneration = draftSync.expect(draftKey, undefined);
        try {
          await transport.sendMessage({ chatId, topicId, text: normalizedText, replyToMessageId });
          draftSync.markAwaitingAck(draftKey, clearGeneration);
          const currentDraft = get().drafts.get(draftKey);
          if (draftSignature(currentDraft) === draftSignature(previousDraft)) {
            const drafts = new Map(get().drafts);
            drafts.delete(draftKey);
            set({ drafts, operationError: undefined });
          } else {
            set({ operationError: undefined });
          }
          scheduleCacheWrite();
          return true;
        } catch (error) {
          draftSync.cancelExpectation(draftKey, clearGeneration);
          const currentDraft = get().drafts.get(draftKey);
          if (previousDraft && draftSignature(currentDraft) === draftSignature(previousDraft)) {
            const restored = { ...previousDraft, pending: true };
            const drafts = new Map(get().drafts);
            drafts.set(draftKey, restored);
            set({ drafts });
            draftSync.expect(draftKey, draftForSync(restored), 0);
          }
          set({ operationError: error instanceof Error ? error.message : "消息发送失败" });
          return false;
        }
      },

      editMessage: async (messageId, text) => {
        const chatId = get().activeChatId;
        const normalizedText = text.trim();
        if (!chatId || !normalizedText) return false;
        try {
          await transport.editMessage({ chatId, messageId, text: normalizedText });
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "消息编辑失败" });
          return false;
        }
      },

      deleteMessage: async (messageId, revoke) => {
        const chatId = get().activeChatId;
        if (!chatId) return false;
        const queuedItemId = outboxItemId(messageId);
        if (queuedItemId) {
          const item = get().outbox.find((candidate) => candidate.id === queuedItemId);
          if (!item) return false;
          setOutbox(get().outbox.filter((candidate) => candidate.id !== queuedItemId));
          if (item.attachments?.length) {
            await attachmentOutbox.remove(queuedItemId).catch(() => undefined);
          }
          await persistOutboxState();
          set({ operationError: undefined });
          return true;
        }
        try {
          await transport.deleteMessage({ chatId, messageId, revoke });
          markMessageRemoving(chatId, messageId);
          set({ operationError: undefined });
          sharedMediaIndex.remove(chatId, [messageId]);
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "消息删除失败" });
          return false;
        }
      },

      forwardMessages: async (fromChatId, messageIds, toChatId, toTopicId) => {
        if (!get().chats.has(fromChatId) || !get().chats.has(toChatId)) return undefined;
        const uniqueMessageIds = [...new Set(messageIds)];
        if (uniqueMessageIds.length === 0) return undefined;
        if (uniqueMessageIds.length > 100) {
          set({ operationError: "单次最多转发 100 条消息" });
          return undefined;
        }
        try {
          const result = await transport.forwardMessages({ fromChatId, toChatId, toTopicId, messageIds: uniqueMessageIds });
          set({
            operationError: result.failedMessageIds.length > 0
              ? `${result.forwardedCount} 条消息已转发，${result.failedMessageIds.length} 条失败`
              : undefined,
          });
          scheduleCacheWrite();
          return result;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "消息转发失败" });
          return undefined;
        }
      },

      cacheFile: async (fileId, priority) => {
        // Callers retry opportunistic preview downloads without surfacing a
        // global runtime error, so preserve the rejection signal here.
        await transport.cacheFile(fileId, priority);
      },

      streamFile: async (fileId, size, mimeType) => {
        try {
          const source = await transport.streamFile({ fileId, size, mimeType });
          set({ operationError: undefined });
          return source;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "视频流加载失败" });
          return undefined;
        }
      },

      suspendFileStream: async (fileId) => {
        try {
          await transport.suspendFileStream(fileId);
        } catch {
          // Pausing playback is best-effort and should not surface a global
          // operation error when the stream already finished or disappeared.
        }
      },

      downloadFile: async (fileId, fileName) => {
        try {
          await transport.downloadFile(fileId, fileName);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "文件下载失败" });
        }
      },

      cancelFileDownload: async (fileId) => {
        try {
          await transport.cancelFileDownload(fileId);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "取消文件下载失败" });
        }
      },

      openFile: async (sourcePath) => {
        try {
          await transport.openFile(sourcePath);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "无法打开文件" });
        }
      },

      saveFileAs: async (sourcePath, fileName) => {
        try {
          await transport.saveFileAs(sourcePath, fileName);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "无法另存文件" });
        }
      },

      openDownloadDirectory: async () => {
        try {
          await transport.openDownloadDirectory();
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "无法打开下载目录" });
        }
      },

      retryMessage: async (messageId) => {
        const chatId = get().activeChatId;
        if (!chatId) return;
        const itemId = outboxItemId(messageId);
        if (itemId) {
          const previous = get().outbox;
          const item = previous.find((candidate) => candidate.id === itemId);
          if (!item) return;
          setOutbox(previous.map((candidate) =>
            candidate.id === itemId
              ? { ...candidate, status: "queued", error: undefined }
              : candidate,
          ));
          try {
            await flushCachedSnapshot();
          } catch (error) {
            setOutbox(previous);
            set({
              cacheHealth: "invalid",
              operationError: errorMessage(error, "无法保存重试队列"),
            });
            return;
          }
          await flushOutbox();
          return;
        }
        try {
          await transport.retryMessage(chatId, messageId);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "消息重试失败" });
        }
      },

      sendFile: async (file) => {
        const chatId = get().activeChatId;
        const topicId = get().activeTopicId;
        if (!chatId) return false;
        if (file && !connectionPresentation(get().connectionStatus).operational) {
          return get().sendFiles([await inspectOutgoingAttachment(file)]);
        }
        try {
          const sent = await transport.sendFile({ chatId, topicId, file });
          if (sent) set({ operationError: undefined });
          return sent;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "文件发送失败" });
          return false;
        }
      },

      sendFiles: async (attachments, caption) => {
        const chatId = get().activeChatId;
        const topicId = get().activeTopicId;
        if (!chatId || attachments.length === 0) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          const id = globalThis.crypto.randomUUID();
          const createdAt = new Date().toISOString();
          try {
            const metadata = await describeOutgoingAttachments(id, attachments);
            await attachmentOutbox.put({ id, createdAt, attachments, metadata });
            const previousOutbox = get().outbox;
            const previousMessages = get().messages;
            const item: QueuedOutgoingMessage = {
              id,
              chatId,
              topicId,
              text: caption?.trim() || metadata.map(({ name }) => name).join("、"),
              caption: caption?.trim() || undefined,
              kind: "attachments",
              attachments: metadata,
              createdAt,
              status: "queued",
            };
            setOutbox([...get().outbox, item]);
            set({ operationError: undefined });
            if (!await persistOutboxState()) {
              set({ outbox: previousOutbox, messages: previousMessages });
              await attachmentOutbox.remove(id).catch(() => undefined);
              return false;
            }
            return true;
          } catch (error) {
            await attachmentOutbox.remove(id).catch(() => undefined);
            set({ operationError: errorMessage(error, "无法保存离线附件") });
            return false;
          }
        }
        try {
          const sent = await transport.sendFiles({ chatId, topicId, attachments, caption });
          if (sent) set({ operationError: undefined });
          return sent;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "附件发送失败" });
          return false;
        }
      },

      cancelFileUpload: async (messageId) => {
        const chatId = get().activeChatId;
        if (!chatId) return;
        const itemId = outboxItemId(messageId);
        if (itemId) {
          const item = get().outbox.find((candidate) => candidate.id === itemId);
          if (!item) return;
          setOutbox(get().outbox.filter((candidate) => candidate.id !== itemId));
          await attachmentOutbox.remove(itemId).catch(() => undefined);
          await persistOutboxState();
          set({ operationError: undefined });
          return;
        }
        try {
          await transport.cancelFileUpload(chatId, messageId);
          markMessageRemoving(chatId, messageId);
          set({ operationError: undefined });
          scheduleCacheWrite();
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "取消上传失败" });
        }
      },

      clearError: () => set({ error: undefined }),
      clearOperationError: () => set({ operationError: undefined }),
    };
  });

export const telegramStore = createTelegramStore(createTelegramTransport());

export const useTelegramStore = <T,>(selector: (state: TelegramState) => T) =>
  useStore(telegramStore, selector);
