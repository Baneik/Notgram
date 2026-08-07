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
  ChatProfile,
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
import { emptyGlobalSearch, mergeGlobalSearchPage } from "./globalSearchState";
import { emptyProfileState } from "./profileState";
import { isRegexMessageSearchQuery } from "../telegram/messageSearch";
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

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

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
    let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
    let chatSearchGeneration = 0;
    let outboxFlush: Promise<void> | undefined;
    let globalSearchGeneration = 0;
    let profileGeneration = 0;
    const profileCache = new Map<string, { value: ChatProfile; cachedAt: number }>();
    const profileRefreshes = new Map<string, Promise<ChatProfile>>();
    const groupManagementLoads = new Map<string, Promise<ChatManagement | undefined>>();
    let accountProfileGeneration = 0;
    let contactsGeneration = 0;
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
            [...profileCache.values()].map(({ value }) => value),
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
      sendDraft: (chatId, draft) => transport.setChatDraft({
        chatId,
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
      if (chatSearchTimer) globalThis.clearTimeout(chatSearchTimer);
      chatSearchTimer = undefined;
      chatSearchGeneration += 1;
      globalSearchGeneration += 1;
      accountProfileGeneration += 1;
      profileGeneration += 1;
      profileCache.clear();
      profileRefreshes.clear();
      contactsGeneration += 1;
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
        activeChatId: undefined,
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
          cachedSnapshotFrom(state, [...profileCache.values()].map(({ value }) => value)),
        );
        set({ cacheHealth: "healthy" });
      }
    };

    const setOutbox = (outbox: QueuedOutgoingMessage[]) => {
      const state = get();
      set({
        outbox,
        messages: messagesWithOutbox(
          state.messages,
          outbox,
          state.currentUserId ?? "self",
        ),
      });
    };

    const persistOutboxState = async () => {
      try {
        await flushCachedSnapshot();
        return true;
      } catch {
        await transport.clearCachedSnapshot().catch(() => undefined);
        set({ cacheHealth: "invalid" });
        return false;
      }
    };

    const flushOutbox = () => {
      if (outboxFlush) return outboxFlush;
      const operation = (async () => {
        while (
          get().authorization.kind === "ready" &&
          get().connectionStatus === "online"
        ) {
          const item = get().outbox.find((candidate) => candidate.status === "queued");
          if (!item) return;
          try {
            if (item.attachments?.length) {
              const stored = await attachmentOutbox.get(item.id);
              if (!stored) throw new Error("离线附件已过期或文件内容已变更，请重新选择");
              const sent = await transport.sendFiles({
                chatId: item.chatId,
                attachments: stored.attachments,
                caption: item.caption,
              });
              if (!sent) throw new Error("附件上传未完成");
            } else {
              await transport.sendMessage({
                chatId: item.chatId,
                text: item.text,
                replyToMessageId: item.replyToMessageId,
                clearDraft: !get().drafts.has(item.chatId),
              });
            }
          } catch (error) {
            setOutbox(get().outbox.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, status: "failed", error: errorMessage(error, "离线发送失败") }
                : candidate,
            ));
            set({ operationError: errorMessage(error, item.attachments?.length ? "离线附件恢复发送失败" : "离线消息恢复发送失败") });
            await persistOutboxState();
            return;
          }

          setOutbox(get().outbox.filter((candidate) => candidate.id !== item.id));
          if (item.attachments?.length) await attachmentOutbox.remove(item.id);
          if (!await persistOutboxState()) return;
        }
      })();
      const tracked = operation.finally(() => {
        if (outboxFlush === tracked) outboxFlush = undefined;
      });
      outboxFlush = tracked;
      return tracked;
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
      profileCache.clear();
      for (const value of snapshot.profiles ?? []) {
        const cacheKey = value.chatId
          ? `chat:${value.chatId}`
          : value.userId ? `user:${value.userId}` : undefined;
        if (cacheKey) profileCache.set(cacheKey, { value, cachedAt: Date.now() });
      }
      const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
      const users = new Map(snapshot.users.map((user) => [user.id, user]));
      let messages = messageMapFrom(snapshot.messages);
      const drafts = new Map((snapshot.drafts ?? []).map((draft) => [draft.chatId, draft]));
      const outbox = snapshot.outbox ?? [];
      cachedMessageIds.clear();
      for (const message of snapshot.messages) {
        const ids = cachedMessageIds.get(message.chatId) ?? new Set<string>();
        ids.add(message.id);
        cachedMessageIds.set(message.chatId, ids);
      }
      for (const [id, chat] of current.chats) chats.set(id, chat);
      for (const [id, user] of current.users) users.set(id, user);
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
      set({
        currentUserId: current.currentUserId ?? snapshot.currentUserId,
        users,
        folders,
        chats,
        chatListReady: true,
        messages,
        drafts,
        outbox,
        activeChatId: current.activeChatId ?? cachedActiveChatId,
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

    const scheduleChatRead = (chatId: string, delayMs = 120) => {
      const currentTimer = readTimers.get(chatId);
      if (currentTimer) globalThis.clearTimeout(currentTimer);
      readTimers.set(chatId, globalThis.setTimeout(() => {
        readTimers.delete(chatId);
        void markChatRead(chatId);
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
            void loadHistory(activeChatId, "ensure").then(() => markChatRead(activeChatId));
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
        const chats = new Map(get().chats);
        for (const chat of incomingChats) {
          chats.set(chat.id, chat);
        }
        const firstChat = get().activeChatId
          ? undefined
          : [...chats.values()].sort(compareChats)[0]?.id;
        set({
          chats,
          chatListReady: true,
          activeChatId: get().activeChatId ?? firstChat,
        });
        scheduleCacheWrite();
        if (firstChat) {
          void loadHistory(firstChat, "ensure").then(() => markChatRead(firstChat));
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
          (message) => message.chatId === activeChatId && !message.outgoing,
        )) {
          scheduleChatRead(activeChatId);
        }
        scheduleCacheWrite();
        return;
      }

      if (event.type === "chat.draftChanged") {
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
      if (!event.message.outgoing && event.message.chatId === get().activeChatId) {
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

    const refreshProfileCache = (
      cacheKey: string,
      loadProfile: () => Promise<ChatProfile>,
    ) => {
      const pending = profileRefreshes.get(cacheKey);
      if (pending) return pending;
      const request = loadProfile().then((value) => {
        profileCache.set(cacheKey, { value, cachedAt: Date.now() });
        scheduleCacheWrite();
        return value;
      }).finally(() => {
        if (profileRefreshes.get(cacheKey) === request) profileRefreshes.delete(cacheKey);
      });
      profileRefreshes.set(cacheKey, request);
      return request;
    };

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
            await loadHistory(refreshChatId, "ensure");
            await markChatRead(refreshChatId);
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
            [...profileCache.values()].map(({ value }) => value),
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

      selectChat: async (chatId) => {
        const previousChatId = get().activeChatId;
        if (previousChatId && previousChatId !== chatId) void draftSync.flush(previousChatId);
        set({ activeChatId: chatId });
        scheduleCacheWrite();
        if (get().authorization.kind !== "ready") return;
        void loadHistory(chatId, "ensure");
        void markChatRead(chatId);
      },

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
        set({ activeChatId: nextChat?.id });
        scheduleCacheWrite();
        if (nextChat) {
          await loadHistory(nextChat.id, "ensure");
          await markChatRead(nextChat.id);
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
      loadMoreHistory: (chatId) => loadHistory(chatId, "older"),
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
        if (chatId) await markChatRead(chatId);
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

      searchChatMessages: async (query) => {
        const chatId = get().activeChatId;
        const normalized = query.trim();
        if (!chatId || !normalized || get().authorization.kind !== "ready") return;
        try {
          await transport.searchChatMessages(chatId, normalized, 100);
          set({ operationError: undefined });
        } catch (error) {
          set({
            operationError: error instanceof Error ? error.message : "无法搜索聊天消息",
          });
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
              error: errorMessage(error, "全局搜索失败"),
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
              error: errorMessage(error, "无法加载更多搜索结果"),
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

      loadCurrentUserProfile: async () => {
        const generation = ++accountProfileGeneration;
        set({ accountProfile: { target: { kind: "current" }, loading: true } });
        try {
          const value = await transport.getCurrentUserProfile();
          if (generation !== accountProfileGeneration) return;
          set({ accountProfile: { target: { kind: "current" }, value, loading: false } });
        } catch (error) {
          if (generation !== accountProfileGeneration) return;
          set({
            accountProfile: {
              target: { kind: "current" },
              loading: false,
              error: errorMessage(error, "无法读取账号资料"),
            },
          });
        }
      },

      updateCurrentUserProfile: async (input) => {
        const current = get().accountProfile;
        if (current.target?.kind !== "current" || current.updating) return false;
        set({ accountProfile: { ...current, updating: true, updateError: undefined } });
        try {
          const value = await transport.updateCurrentUserProfile(input);
          const latest = get().accountProfile;
          if (latest.target?.kind !== "current") return false;
          set({ accountProfile: { ...latest, value, loading: false, updating: false, updateError: undefined } });
          void registerCurrentAccount();
          return true;
        } catch (error) {
          const latest = get().accountProfile;
          if (latest.target?.kind === "current") {
            set({
              accountProfile: {
                ...latest,
                updating: false,
                updateError: errorMessage(error, "无法更新账号资料"),
              },
            });
          }
          return false;
        }
      },

      changeCurrentUserAvatar: async (file) => {
        const current = get().accountProfile;
        if (current.target?.kind !== "current" || current.updating) return false;
        set({ accountProfile: { ...current, updating: true, updateError: undefined } });
        try {
          const value = await transport.setCurrentUserAvatar(file);
          const latest = get().accountProfile;
          if (latest.target?.kind !== "current") return false;
          set({
            accountProfile: {
              ...latest,
              value: value ?? latest.value,
              loading: false,
              updating: false,
              updateError: undefined,
            },
          });
          if (value) void registerCurrentAccount();
          return Boolean(value);
        } catch (error) {
          const latest = get().accountProfile;
          if (latest.target?.kind === "current") {
            set({
              accountProfile: {
                ...latest,
                updating: false,
                updateError: errorMessage(error, "无法更新头像"),
              },
            });
          }
          return false;
        }
      },

      loadChatProfile: async (chatId) => {
        const target = { kind: "chat" as const, chatId };
        const current = get().profile;
        if (current.loading && current.target?.kind === "chat" && current.target.chatId === chatId) {
          return;
        }
        const generation = ++profileGeneration;
        const cacheKey = `chat:${chatId}`;
        const cached = profileCache.get(cacheKey);
        if (cached) {
          set({ profile: { target, value: cached.value, loading: false } });
          return;
        }
        set({ profile: { target, loading: true } });
        try {
          const value = await refreshProfileCache(
            cacheKey,
            () => transport.getChatProfile(chatId),
          );
          if (generation !== profileGeneration) return;
          set({ profile: { target, value, loading: false } });
        } catch (error) {
          if (generation !== profileGeneration) return;
          set({
            profile: {
              target,
              loading: false,
              error: errorMessage(error, "无法读取聊天资料"),
            },
          });
        }
      },

      refreshChatProfile: async (chatId) => {
        const cacheKey = `chat:${chatId}`;
        try {
          const value = await refreshProfileCache(
            cacheKey,
            () => transport.getChatProfile(chatId),
          );
          const current = get().profile;
          if (current.target?.kind === "chat" && current.target.chatId === chatId) {
            set({ profile: { ...current, value, loading: false, error: undefined } });
          }
        } catch {
          // Conversation entry refresh is best-effort and never blocks the UI.
        }
      },

      loadUserProfile: async (userId) => {
        const target = { kind: "user" as const, userId };
        const current = get().profile;
        if (current.loading && current.target?.kind === "user" && current.target.userId === userId) {
          return;
        }
        const generation = ++profileGeneration;
        const cacheKey = `user:${userId}`;
        const cached = profileCache.get(cacheKey);
        if (cached) {
          set({ profile: { target, value: cached.value, loading: false } });
          return;
        }
        set({ profile: { target, loading: true } });
        try {
          const value = await refreshProfileCache(
            cacheKey,
            () => transport.getUserProfile(userId),
          );
          if (generation !== profileGeneration) return;
          set({ profile: { target, value, loading: false } });
        } catch (error) {
          if (generation !== profileGeneration) return;
          set({
            profile: {
              target,
              loading: false,
              error: errorMessage(error, "无法读取用户资料"),
            },
          });
        }
      },

      clearProfile: () => {
        profileGeneration += 1;
        set({ profile: emptyProfileState() });
      },

      loadContacts: async () => {
        const generation = ++contactsGeneration;
        set({ contactsLoading: true, contactsError: undefined });
        try {
          const contacts = await transport.getContacts();
          if (generation !== contactsGeneration) return;
          set({ contacts, contactsLoading: false });
        } catch (error) {
          if (generation !== contactsGeneration) return;
          set({
            contactsLoading: false,
            contactsError: errorMessage(error, "无法读取联系人"),
          });
        }
      },

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

      sendInlineQueryResultMessage: async (chatId, botUserId, queryId, resultId, replyToMessageId) => {
        try { await transport.sendInlineQueryResultMessage(chatId, botUserId, queryId, resultId, replyToMessageId); set({ operationError: undefined }); return true; }
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

      getActiveSessions: async () => {
        try { return await transport.getActiveSessions(); }
        catch (error) { set({ operationError: errorMessage(error, "无法读取设备会话") }); return []; }
      },
      terminateSession: async (sessionId) => {
        try { await transport.terminateSession(sessionId); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法终止设备会话") }); return false; }
      },
      terminateAllOtherSessions: async () => {
        try { await transport.terminateAllOtherSessions(); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法终止其他设备") }); return false; }
      },
      getPrivacySettingRules: async (setting) => {
        try { return await transport.getPrivacySettingRules(setting); }
        catch (error) { set({ operationError: errorMessage(error, "无法读取隐私设置") }); return []; }
      },
      setPrivacySettingRules: async (setting, rules) => {
        try { await transport.setPrivacySettingRules(setting, rules); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, "无法保存隐私设置") }); return false; }
      },

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
          if (pinned.length > 0) {
            const messages = new Map(get().messages);
            messages.set(chatId, upsertMessages(messages.get(chatId) ?? [], pinned));
            set({ messages, operationError: undefined });
            scheduleCacheWrite();
          } else {
            set({ operationError: undefined });
          }
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
        if (!chatId) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          set({ operationError: "联网后才能发送贴纸" });
          return false;
        }
        try {
          await transport.sendSticker({ chatId, asset, replyToMessageId });
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
        if (!chatId) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          set({ operationError: "联网后才能发送 GIF" });
          return false;
        }
        try {
          await transport.sendAnimation({ chatId, asset, replyToMessageId });
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

      setSearchQuery: (searchQuery) => {
        set({ searchQuery });
        if (chatSearchTimer) globalThis.clearTimeout(chatSearchTimer);
        chatSearchTimer = undefined;
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
            set({ operationError: error instanceof Error ? error.message : "无法搜索会话" });
          });
        }, 250);
      },
      setChatFilter: (chatFilter) => {
        set({ chatFilter });
        scheduleCacheWrite();
        void loadChats(chatFilter);
      },

      updateChatDraft: (chatId, text, replyToMessageId) => {
        if (!get().chats.has(chatId)) return;
        const current = get().drafts.get(chatId);
        const next: ChatDraft = {
          chatId,
          text,
          replyToMessageId,
          updatedAt: new Date().toISOString(),
          pending: true,
        };
        if (draftSignature(current) === draftSignature(next)) return;
        const drafts = new Map(get().drafts);
        drafts.set(chatId, next);
        set({ drafts });
        draftSync.expect(chatId, draftForSync(next), DRAFT_SYNC_DELAY_MS);
        scheduleCacheWrite();
      },

      setChatTyping: async (chatId, typing) => {
        if (get().authorization.kind !== "ready") return;
        try {
          await transport.setChatTyping(chatId, typing);
        } catch {
          // Typing state is ephemeral and must not replace actionable operation errors.
        }
      },

      sendMessage: async (text, replyToMessageId) => {
        const chatId = get().activeChatId;
        const normalizedText = text.trim();
        if (!chatId || !normalizedText) return false;
        const previousDraft = get().drafts.get(chatId);
        if (!connectionPresentation(get().connectionStatus).operational) {
          const previousOutbox = get().outbox;
          const previousMessages = get().messages;
          const previousDrafts = get().drafts;
          const item: QueuedOutgoingMessage = {
            id: globalThis.crypto.randomUUID(),
            chatId,
            text: normalizedText,
            replyToMessageId,
            createdAt: new Date().toISOString(),
            status: "queued",
          };
          const outbox = [...previousOutbox, item];
          const drafts = new Map(previousDrafts);
          drafts.delete(chatId);
          const clearGeneration = draftSync.expect(chatId, undefined);
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
            draftSync.cancelExpectation(chatId, clearGeneration);
            if (previousDraft?.pending) {
              draftSync.expect(chatId, draftForSync(previousDraft));
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
        await draftSync.flush(chatId);
        const clearGeneration = draftSync.expect(chatId, undefined);
        try {
          await transport.sendMessage({ chatId, text: normalizedText, replyToMessageId });
          draftSync.markAwaitingAck(chatId, clearGeneration);
          const currentDraft = get().drafts.get(chatId);
          if (draftSignature(currentDraft) === draftSignature(previousDraft)) {
            const drafts = new Map(get().drafts);
            drafts.delete(chatId);
            set({ drafts, operationError: undefined });
          } else {
            set({ operationError: undefined });
          }
          scheduleCacheWrite();
          return true;
        } catch (error) {
          draftSync.cancelExpectation(chatId, clearGeneration);
          const currentDraft = get().drafts.get(chatId);
          if (previousDraft && draftSignature(currentDraft) === draftSignature(previousDraft)) {
            const restored = { ...previousDraft, pending: true };
            const drafts = new Map(get().drafts);
            drafts.set(chatId, restored);
            set({ drafts });
            draftSync.expect(chatId, draftForSync(restored), 0);
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

      forwardMessages: async (fromChatId, messageIds, toChatId) => {
        if (!get().chats.has(fromChatId) || !get().chats.has(toChatId)) return undefined;
        const uniqueMessageIds = [...new Set(messageIds)];
        if (uniqueMessageIds.length === 0) return undefined;
        if (uniqueMessageIds.length > 100) {
          set({ operationError: "单次最多转发 100 条消息" });
          return undefined;
        }
        try {
          const result = await transport.forwardMessages({ fromChatId, toChatId, messageIds: uniqueMessageIds });
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
        if (!chatId) return false;
        if (file && !connectionPresentation(get().connectionStatus).operational) {
          return get().sendFiles([await inspectOutgoingAttachment(file)]);
        }
        try {
          const sent = await transport.sendFile({ chatId, file });
          if (sent) set({ operationError: undefined });
          return sent;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "文件发送失败" });
          return false;
        }
      },

      sendFiles: async (attachments, caption) => {
        const chatId = get().activeChatId;
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
          const sent = await transport.sendFiles({ chatId, attachments, caption });
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
