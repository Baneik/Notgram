import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createTelegramTransport } from "../telegram/createTransport";
import type { TelegramTransport } from "../telegram/transport";
import type {
  CachedTelegramSnapshot,
  ChatDraft,
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
  reconcileCachedMessageWindow,
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
import { logPerformance } from "../utils/performanceMonitor";
import { protectedCachePaths } from "./cacheProtection";
import { emptyGlobalSearch, mergeGlobalSearchPage } from "./globalSearchState";
import { emptyProfileState } from "./profileState";

export type {
  ChatFilter,
  ChatListState,
  HistoryState,
  RuntimePhase,
  TelegramState,
} from "./telegramStore.types";
export { filterAndSortChats, selectVisibleChats } from "./telegramStore.selectors";

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

const reloadCurrentApplication = () => {
  if (typeof window !== "undefined") window.location.reload();
};

export const createTelegramStore = (
  transport: TelegramTransport,
  reloadApplication: () => void = reloadCurrentApplication,
) =>
  createStore<TelegramState>((set, get) => {
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
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
    let contactsGeneration = 0;

    const scheduleCacheWrite = () => {
      const state = get();
      if (state.authorization.kind !== "ready" || !state.currentUserId || cacheTimer) {
        return;
      }
      cacheTimer = globalThis.setTimeout(() => {
        cacheTimer = undefined;
        const current = get();
        if (current.authorization.kind !== "ready" || !current.currentUserId) return;
        const snapshot = cachedSnapshotFrom(current);
        cacheWrite = cacheWrite
          .catch(() => undefined)
          .then(() => transport.saveCachedSnapshot(snapshot))
          .then(() => set({ cacheHealth: "healthy" }))
          .catch(() => set({ cacheHealth: "invalid" }));
      }, 600);
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
      if (cacheTimer) globalThis.clearTimeout(cacheTimer);
      cacheTimer = undefined;
      cachedMessageIds.clear();
      draftSync.clear();
      for (const timer of readTimers.values()) globalThis.clearTimeout(timer);
      readTimers.clear();
      readRequestChains.clear();
      if (chatSearchTimer) globalThis.clearTimeout(chatSearchTimer);
      chatSearchTimer = undefined;
      chatSearchGeneration += 1;
      globalSearchGeneration += 1;
      profileGeneration += 1;
      contactsGeneration += 1;
      set({
        currentUserId: undefined,
        users: new Map(),
        folders: [],
        chats: new Map(),
        chatListReady: false,
        chatLists: new Map(),
        messages: new Map(),
        drafts: new Map(),
        outbox: [],
        histories: new Map(),
        activeChatId: undefined,
        globalSearch: emptyGlobalSearch(),
        profile: emptyProfileState(),
        contacts: [],
        contactsLoading: false,
        contactsError: undefined,
        contactPendingUserId: undefined,
        chatManagementPending: new Set(),
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
      if (cacheTimer) {
        globalThis.clearTimeout(cacheTimer);
        cacheTimer = undefined;
      }
      await cacheWrite.catch(() => undefined);
      const state = get();
      if (state.authorization.kind === "ready" && state.currentUserId) {
        await transport.saveCachedSnapshot(cachedSnapshotFrom(state));
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
            await transport.sendMessage({
              chatId: item.chatId,
              text: item.text,
              replyToMessageId: item.replyToMessageId,
              clearDraft: !get().drafts.has(item.chatId),
            });
          } catch (error) {
            setOutbox(get().outbox.map((candidate) =>
              candidate.id === item.id ? { ...candidate, status: "failed" } : candidate,
            ));
            set({ operationError: errorMessage(error, "离线消息恢复发送失败") });
            await persistOutboxState();
            return;
          }

          setOutbox(get().outbox.filter((candidate) => candidate.id !== item.id));
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
        : snapshot.folders.filter((folder) => folder.id !== "archive");
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

    const loadHistory = async (chatId: string) => {
      if (get().authorization.kind !== "ready") return;
      const current = get().histories.get(chatId);
      if (current?.loading || current?.hasMore === false) return;

      const histories = new Map(get().histories);
      histories.set(chatId, { loading: true, hasMore: current?.hasMore ?? true });
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

          const currentMessages = get().messages.get(chatId) ?? [];
          const reconciled = reconcileCachedMessageWindow(
            currentMessages,
            pendingCachedIds,
            confirmedIds,
          );
          if (reconciled.messages.length !== currentMessages.length) {
            const nextMessages = new Map(get().messages);
            nextMessages.set(chatId, reconciled.messages);
            set({ messages: nextMessages });
          }
          if (reconciled.pendingCachedIds.size === 0) {
            cachedMessageIds.delete(chatId);
          } else {
            cachedMessageIds.set(chatId, reconciled.pendingCachedIds);
          }
        }
        const nextHistories = new Map(get().histories);
        nextHistories.set(chatId, { loading: false, hasMore: page.hasMore });
        set({ histories: nextHistories, operationError: undefined });
        logPerformance("ui_history_data", {
          durationMs: performance.now() - startedAt,
          beforeCount,
          afterCount: get().messages.get(chatId)?.length ?? 0,
          loadedCount: page.loadedCount,
          hasMore: page.hasMore,
          failed: false,
        });
        scheduleCacheWrite();
      } catch (error) {
        const nextHistories = new Map(get().histories);
        nextHistories.set(chatId, { loading: false, hasMore: true });
        set({
          histories: nextHistories,
          operationError: error instanceof Error ? error.message : "无法加载历史消息",
        });
        logPerformance("ui_history_data", {
          durationMs: performance.now() - startedAt,
          beforeCount,
          afterCount: get().messages.get(chatId)?.length ?? 0,
          failed: true,
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

    const markChatRead = (chatId: string) => {
      const previous = readRequestChains.get(chatId) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          if (
            get().authorization.kind !== "ready" ||
            get().activeChatId !== chatId ||
            !documentIsVisible()
          ) {
            return;
          }
          await transport.markChatRead(chatId);
        })
        .catch((error) => {
          set({ operationError: error instanceof Error ? error.message : "无法更新已读状态" });
        });
      const tracked = operation.finally(() => {
        if (readRequestChains.get(chatId) === tracked) readRequestChains.delete(chatId);
      });
      readRequestChains.set(chatId, tracked);
      return tracked;
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
            void loadHistory(activeChatId).then(() => markChatRead(activeChatId));
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
        const folders = event.folders.filter((folder) => folder.id !== "archive");
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
          void loadHistory(firstChat).then(() => markChatRead(firstChat));
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

      if (event.type === "message.remove") {
        const messages = new Map(get().messages);
        messages.set(
          event.chatId,
          (messages.get(event.chatId) ?? []).filter(
            (message) => message.id !== event.messageId,
          ),
        );
        set({ messages });
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
          messages.set(chatId, upsertMessages(existing, incoming));
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
      messages.set(
        event.message.chatId,
        upsertMessage(messages.get(event.message.chatId) ?? [], event.message),
      );
      set({ messages });
      if (!event.message.outgoing && event.message.chatId === get().activeChatId) {
        scheduleChatRead(event.message.chatId);
      }
      scheduleCacheWrite();
    };

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
      operation: () => Promise<void>,
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
      drafts: new Map(),
      outbox: [],
      histories: new Map(),
      searchQuery: "",
      chatFilter: "main",
      globalSearch: emptyGlobalSearch(),
      profile: emptyProfileState(),
      contacts: [],
      contactsLoading: false,
      chatManagementPending: new Set(),

      initialize: async () => {
        if (get().phase !== "idle") return;
        set({
          phase: "loading",
          connectionStatus: "connecting",
          error: undefined,
          operationError: undefined,
        });
        try {
          applyAccountState(await transport.getAccountState());
          try {
            hydrateCachedSnapshot(await transport.loadCachedSnapshot());
          } catch {
            // A corrupt or unavailable cache must not block the live connection.
            set({ cacheHealth: "invalid" });
            void transport.clearCachedSnapshot().catch(() => undefined);
          }
          const snapshot = await transport.connect(applyEvent);
          const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
          const users = new Map(snapshot.users.map((user) => [user.id, user]));
          const folders = snapshot.folders.filter((folder) => folder.id !== "archive");
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
          const refreshChatId = get().activeChatId ?? firstChat?.id;
          if (authorization.kind === "ready" && refreshChatId) {
            await loadHistory(refreshChatId);
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
          await transport.saveCachedSnapshot(cachedSnapshotFrom(get()));
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
        await loadHistory(chatId);
        await markChatRead(chatId);
      },

      loadMoreChats: loadChats,
      setChatPinned: (chatListId, chatId, pinned) => manageChat(
        chatId,
        "无法更新置顶状态",
        () => transport.setChatPinned(chatListId, chatId, pinned),
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
      setChatMuted: (chatId, muted) => manageChat(
        chatId,
        "无法更新通知设置",
        () => transport.setChatMuted(chatId, muted),
      ),
      setChatArchived: (chatId, archived) => manageChat(
        chatId,
        archived ? "无法归档会话" : "无法移出归档",
        () => transport.setChatArchived(chatId, archived),
      ),
      loadMoreHistory: loadHistory,
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
        const generation = ++profileGeneration;
        set({ profile: { target: { kind: "current" }, loading: true } });
        try {
          const value = await transport.getCurrentUserProfile();
          if (generation !== profileGeneration) return;
          set({ profile: { target: { kind: "current" }, value, loading: false } });
        } catch (error) {
          if (generation !== profileGeneration) return;
          set({
            profile: {
              target: { kind: "current" },
              loading: false,
              error: errorMessage(error, "无法读取账号资料"),
            },
          });
        }
      },

      loadChatProfile: async (chatId) => {
        const generation = ++profileGeneration;
        set({ profile: { target: { kind: "chat", chatId }, loading: true } });
        try {
          const value = await transport.getChatProfile(chatId);
          if (generation !== profileGeneration) return;
          set({ profile: { target: { kind: "chat", chatId }, value, loading: false } });
        } catch (error) {
          if (generation !== profileGeneration) return;
          set({
            profile: {
              target: { kind: "chat", chatId },
              loading: false,
              error: errorMessage(error, "无法读取聊天资料"),
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

      setSearchQuery: (searchQuery) => {
        set({ searchQuery });
        if (chatSearchTimer) globalThis.clearTimeout(chatSearchTimer);
        chatSearchTimer = undefined;
        const normalized = searchQuery.trim();
        const generation = ++chatSearchGeneration;
        if (!normalized || get().authorization.kind !== "ready") return;
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
          const drafts = new Map(get().drafts);
          drafts.delete(chatId);
          set({ drafts, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          draftSync.cancelExpectation(chatId, clearGeneration);
          if (previousDraft) {
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
        try {
          await transport.deleteMessage({ chatId, messageId, revoke });
          const messages = new Map(get().messages);
          messages.set(
            chatId,
            (messages.get(chatId) ?? []).filter((message) => message.id !== messageId),
          );
          set({ messages, operationError: undefined });
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
            candidate.id === itemId ? { ...candidate, status: "queued" } : candidate,
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
        try {
          const sent = await transport.sendFile({ chatId, file });
          if (sent) set({ operationError: undefined });
          return sent;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : "文件发送失败" });
          return false;
        }
      },

      cancelFileUpload: async (messageId) => {
        const chatId = get().activeChatId;
        if (!chatId) return;
        try {
          await transport.cancelFileUpload(chatId, messageId);
          const messages = new Map(get().messages);
          messages.set(
            chatId,
            (messages.get(chatId) ?? []).filter((message) => message.id !== messageId),
          );
          set({ messages, operationError: undefined });
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
