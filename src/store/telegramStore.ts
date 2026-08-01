import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createTelegramTransport } from "../telegram/createTransport";
import type { TelegramTransport } from "../telegram/transport";
import type {
  AuthorizationAction,
  AuthorizationState,
  CachedTelegramSnapshot,
  Chat,
  ChatDraft,
  ChatFolder,
  Message,
  ForwardMessagesResult,
  MessagePermissions,
  ProxySettings,
  StorageSettings,
  TelegramEvent,
  TelegramAccount,
  TelegramAccountState,
  User,
} from "../telegram/types";

export type ChatFilter = string;
type RuntimePhase = "idle" | "loading" | "ready" | "error";

export interface HistoryState {
  loading: boolean;
  hasMore: boolean;
}

export interface ChatListState {
  loading: boolean;
  hasMore: boolean;
}

export interface TelegramState {
  phase: RuntimePhase;
  error?: string;
  transportKind: TelegramTransport["kind"];
  transportLabel: string;
  currentUserId?: string;
  authorization: AuthorizationState;
  authorizationPending: boolean;
  authorizationError?: string;
  proxySettings?: ProxySettings;
  proxyPending: boolean;
  proxyError?: string;
  proxyLatencyMs?: number;
  storageSettings?: StorageSettings;
  storagePending: boolean;
  storageError?: string;
  accounts: TelegramAccount[];
  activeAccountId: string;
  accountPending: boolean;
  accountError?: string;
  users: Map<string, User>;
  folders: ChatFolder[];
  chats: Map<string, Chat>;
  chatListReady: boolean;
  chatLists: Map<string, ChatListState>;
  messages: Map<string, Message[]>;
  drafts: Map<string, ChatDraft>;
  histories: Map<string, HistoryState>;
  activeChatId?: string;
  searchQuery: string;
  chatFilter: ChatFilter;
  initialize: () => Promise<void>;
  authenticate: (action: AuthorizationAction) => Promise<void>;
  loadProxySettings: () => Promise<void>;
  saveProxySettings: (settings: ProxySettings) => Promise<boolean>;
  testProxy: (settings: ProxySettings) => Promise<void>;
  loadStorageSettings: () => Promise<void>;
  saveStorageSettings: (settings: StorageSettings) => Promise<boolean>;
  addAccount: () => Promise<boolean>;
  switchAccount: (accountId: string) => Promise<boolean>;
  logOutCurrentAccount: () => Promise<boolean>;
  selectChat: (chatId: string) => Promise<void>;
  loadMoreChats: (chatListId?: string) => Promise<void>;
  loadMoreHistory: (chatId: string) => Promise<void>;
  markActiveChatRead: () => Promise<void>;
  loadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  searchChatMessages: (query: string) => Promise<void>;
  setMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: ChatFilter) => void;
  sendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  editMessage: (messageId: string, text: string) => Promise<boolean>;
  deleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  updateChatDraft: (chatId: string, text: string, replyToMessageId?: string) => void;
  forwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  downloadFile: (fileId: number, fileName: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  sendFile: (file?: File) => Promise<boolean>;
  cancelFileUpload: (messageId: string) => Promise<void>;
  clearError: () => void;
}

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

const upsertMessage = (messages: Message[], next: Message) => {
  const index = messages.findIndex((message) => message.id === next.id);
  const updated = [...messages];
  if (index >= 0) updated[index] = next;
  else updated.push(next);
  return updated.sort(
    (left, right) =>
      new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime(),
  );
};

const withEmojiReaction = (message: Message, emoji: string, chosen: boolean): Message => {
  const interaction = message.interaction ?? {
    viewCount: 0,
    forwardCount: 0,
    replyCount: 0,
    reactions: [],
  };
  const reactions = [...interaction.reactions];
  const index = reactions.findIndex(
    (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
  );
  if (index >= 0) {
    const current = reactions[index];
    if (current.chosen === chosen) return message;
    const totalCount = Math.max(0, current.totalCount + (chosen ? 1 : -1));
    if (totalCount === 0) reactions.splice(index, 1);
    else reactions[index] = { ...current, chosen, totalCount };
  } else if (chosen) {
    reactions.push({
      type: { kind: "emoji", emoji },
      totalCount: 1,
      chosen: true,
      recentSenderIds: [],
    });
  } else {
    return message;
  }
  return { ...message, interaction: { ...interaction, reactions } };
};

const messageMapFrom = (messages: Message[]) => {
  const result = new Map<string, Message[]>();
  for (const message of messages) {
    result.set(
      message.chatId,
      upsertMessage(result.get(message.chatId) ?? [], message),
    );
  }
  return result;
};

const numericMessageId = (messageId: string) => {
  if (!/^-?\d+$/.test(messageId)) return undefined;
  try {
    return BigInt(messageId);
  } catch {
    return undefined;
  }
};

const reconcileCachedMessageWindow = (
  messages: Message[],
  pendingCachedIds: Set<string>,
  confirmedIds: Set<string>,
) => {
  const confirmedNumericIds = [...confirmedIds]
    .map(numericMessageId)
    .filter((messageId): messageId is bigint => messageId !== undefined);
  const oldestConfirmedId = confirmedNumericIds.length > 0
    ? confirmedNumericIds.reduce((oldest, messageId) => messageId < oldest ? messageId : oldest)
    : undefined;
  const newestConfirmedId = confirmedNumericIds.length > 0
    ? confirmedNumericIds.reduce((newest, messageId) => messageId > newest ? messageId : newest)
    : undefined;
  const remainingCachedIds = new Set(pendingCachedIds);
  const reconciledMessages = messages.filter((message) => {
    if (!pendingCachedIds.has(message.id)) return true;
    if (confirmedIds.has(message.id)) {
      remainingCachedIds.delete(message.id);
      return true;
    }

    const messageId = numericMessageId(message.id);
    const coveredByServerWindow =
      messageId !== undefined &&
      oldestConfirmedId !== undefined &&
      newestConfirmedId !== undefined &&
      messageId >= oldestConfirmedId &&
      messageId <= newestConfirmedId;
    if (!coveredByServerWindow) return true;
    remainingCachedIds.delete(message.id);
    return false;
  });
  return { messages: reconciledMessages, pendingCachedIds: remainingCachedIds };
};

const compareChats = (left: Chat, right: Chat) =>
  Number(right.pinned) - Number(left.pinned) ||
  new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
  (left.id === right.id ? 0 : left.id < right.id ? -1 : 1);

const CACHE_VERSION = 1 as const;
const MAX_CACHED_MESSAGES_PER_CHAT = 60;
const MAX_CACHED_MESSAGES = 5_000;
const DRAFT_SYNC_DELAY_MS = 450;
const DRAFT_ACK_TIMEOUT_MS = 5_000;
const DRAFT_RETRY_DELAYS_MS = [1_000, 2_500, 5_000] as const;

interface DraftSyncEntry {
  generation: number;
  draft?: ChatDraft;
  attempts: number;
  sent: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ackTimer?: ReturnType<typeof setTimeout>;
}

const draftForSync = (draft?: ChatDraft) =>
  draft && (draft.text.length > 0 || draft.replyToMessageId) ? draft : undefined;

const draftSignature = (draft?: ChatDraft) => JSON.stringify([
  draft?.text ?? "",
  draft?.replyToMessageId ?? "",
]);

const recentMessagesForCache = (state: TelegramState) => {
  const orderedChatIds = [...state.chats.values()]
    .sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )
    .map((chat) => chat.id);
  if (state.activeChatId) {
    const index = orderedChatIds.indexOf(state.activeChatId);
    if (index >= 0) orderedChatIds.splice(index, 1);
    orderedChatIds.unshift(state.activeChatId);
  }

  const messages: Message[] = [];
  for (const chatId of orderedChatIds) {
    const remaining = MAX_CACHED_MESSAGES - messages.length;
    if (remaining <= 0) break;
    const recent = (state.messages.get(chatId) ?? []).slice(
      -Math.min(MAX_CACHED_MESSAGES_PER_CHAT, remaining),
    );
    messages.push(...recent.map((message) => {
      const cacheableMessage = { ...message };
      delete cacheableMessage.permissions;
      if (
        cacheableMessage.content.kind !== "media" ||
        !cacheableMessage.content.previewDataUrl ||
        cacheableMessage.content.previewDataUrl.length <= 32_768
      ) {
        return cacheableMessage;
      }
      return {
        ...cacheableMessage,
        content: { ...cacheableMessage.content, previewDataUrl: undefined },
      };
    }));
  }
  return messages;
};

const cachedSnapshotFrom = (state: TelegramState): CachedTelegramSnapshot => ({
  version: CACHE_VERSION,
  savedAt: new Date().toISOString(),
  currentUserId: state.currentUserId ?? "",
  users: [...state.users.values()],
  folders: state.folders.filter((folder) => folder.id !== "archive"),
  chats: [...state.chats.values()],
  messages: recentMessagesForCache(state),
  drafts: [...state.drafts.values()],
  activeChatId: state.activeChatId,
  chatFilter: state.chatFilter,
});

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
    let draftGeneration = 0;
    const draftSyncs = new Map<string, DraftSyncEntry>();
    const draftRequestChains = new Map<string, Promise<void>>();
    const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const readRequestChains = new Map<string, Promise<void>>();
    let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
    let chatSearchGeneration = 0;

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
          .catch(() => undefined);
      }, 600);
    };

    const clearDraftSyncTimers = (entry: DraftSyncEntry) => {
      if (entry.timer) globalThis.clearTimeout(entry.timer);
      if (entry.ackTimer) globalThis.clearTimeout(entry.ackTimer);
      entry.timer = undefined;
      entry.ackTimer = undefined;
    };

    const settleDraftWithoutServerUpdate = (chatId: string, generation: number) => {
      const entry = draftSyncs.get(chatId);
      if (!entry || entry.generation !== generation) return;
      draftSyncs.delete(chatId);
      const drafts = new Map(get().drafts);
      const current = drafts.get(chatId);
      if (!entry.draft) {
        drafts.delete(chatId);
      } else if (draftSignature(current) === draftSignature(entry.draft)) {
        drafts.set(chatId, { ...entry.draft, pending: false });
      }
      set({ drafts });
      scheduleCacheWrite();
    };

    const performDraftSync = (chatId: string, generation: number): Promise<void> => {
      const entry = draftSyncs.get(chatId);
      if (!entry || entry.generation !== generation || entry.sent) return Promise.resolve();
      if (entry.timer) globalThis.clearTimeout(entry.timer);
      entry.timer = undefined;
      if (get().authorization.kind !== "ready") return Promise.resolve();

      const previous = draftRequestChains.get(chatId) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          const current = draftSyncs.get(chatId);
          if (!current || current.generation !== generation || current.sent) return;
          try {
            await transport.setChatDraft({
              chatId,
              text: current.draft?.text ?? "",
              replyToMessageId: current.draft?.replyToMessageId,
            });
          } catch (error) {
            const latest = draftSyncs.get(chatId);
            if (!latest || latest.generation !== generation) return;
            const retryDelay = DRAFT_RETRY_DELAYS_MS[latest.attempts];
            latest.attempts += 1;
            if (retryDelay !== undefined) {
              latest.timer = globalThis.setTimeout(
                () => void performDraftSync(chatId, generation),
                retryDelay,
              );
            }
            set({ error: error instanceof Error ? error.message : "草稿同步失败" });
            return;
          }

          const latest = draftSyncs.get(chatId);
          if (!latest || latest.generation !== generation) return;
          latest.sent = true;
          latest.attempts = 0;
          latest.ackTimer = globalThis.setTimeout(
            () => settleDraftWithoutServerUpdate(chatId, generation),
            DRAFT_ACK_TIMEOUT_MS,
          );
        });
      const tracked = operation.finally(() => {
        if (draftRequestChains.get(chatId) === tracked) draftRequestChains.delete(chatId);
      });
      draftRequestChains.set(chatId, tracked);
      return tracked;
    };

    const expectDraftSync = (
      chatId: string,
      draft: ChatDraft | undefined,
      delayMs?: number,
    ) => {
      const previous = draftSyncs.get(chatId);
      if (previous) clearDraftSyncTimers(previous);
      const entry: DraftSyncEntry = {
        generation: ++draftGeneration,
        draft: draftForSync(draft),
        attempts: 0,
        sent: false,
      };
      draftSyncs.set(chatId, entry);
      if (delayMs !== undefined) {
        entry.timer = globalThis.setTimeout(
          () => void performDraftSync(chatId, entry.generation),
          delayMs,
        );
      }
      return entry;
    };

    const resumePendingDrafts = () => {
      if (get().authorization.kind !== "ready") return;
      for (const draft of get().drafts.values()) {
        if (!draft.pending) continue;
        const entry = expectDraftSync(draft.chatId, draftForSync(draft), 0);
        void performDraftSync(draft.chatId, entry.generation);
      }
    };

    const flushDraft = async (chatId: string) => {
      let entry = draftSyncs.get(chatId);
      const cached = get().drafts.get(chatId);
      if (!entry && cached?.pending) {
        entry = expectDraftSync(chatId, draftForSync(cached));
      }
      if (!entry || entry.sent) return;
      await performDraftSync(chatId, entry.generation);
    };

    const flushPendingDrafts = async () => {
      await Promise.all([...get().drafts.values()]
        .filter((draft) => draft.pending)
        .map((draft) => flushDraft(draft.chatId)));
    };

    const clearCachedData = (clearSnapshot = true) => {
      if (cacheTimer) globalThis.clearTimeout(cacheTimer);
      cacheTimer = undefined;
      cachedMessageIds.clear();
      for (const entry of draftSyncs.values()) clearDraftSyncTimers(entry);
      draftSyncs.clear();
      draftRequestChains.clear();
      for (const timer of readTimers.values()) globalThis.clearTimeout(timer);
      readTimers.clear();
      readRequestChains.clear();
      if (chatSearchTimer) globalThis.clearTimeout(chatSearchTimer);
      chatSearchTimer = undefined;
      chatSearchGeneration += 1;
      set({
        currentUserId: undefined,
        users: new Map(),
        folders: [],
        chats: new Map(),
        chatListReady: false,
        chatLists: new Map(),
        messages: new Map(),
        drafts: new Map(),
        histories: new Map(),
        activeChatId: undefined,
        chatFilter: "main",
      });
      if (clearSnapshot) void transport.clearCachedSnapshot().catch(() => undefined);
    };

    const applyAccountState = (accountState: TelegramAccountState) => {
      set({
        accounts: accountState.accounts,
        activeAccountId: accountState.activeAccountId,
        accountPending: false,
        accountError: undefined,
      });
    };

    const registerCurrentAccount = () => {
      const state = get();
      if (accountTransition) return Promise.resolve();
      const user = state.currentUserId ? state.users.get(state.currentUserId) : undefined;
      if (!user || state.authorization.kind !== "ready") return Promise.resolve();
      const accountId = state.activeAccountId;
      const key = `${state.activeAccountId}:${user.id}:${user.displayName}:${user.avatar.label}:${user.avatar.color}`;
      if (registeredAccountKey === key) return accountRegistration;
      registeredAccountKey = key;
      const registration = transport.registerCurrentAccount({
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar,
      }).then((accountState) => {
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
      accountRegistration = registration;
      return registration;
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
      }
    };

    const hydrateCachedSnapshot = (snapshot?: CachedTelegramSnapshot) => {
      if (!snapshot || snapshot.version !== CACHE_VERSION || !snapshot.currentUserId) return;
      const current = get();
      const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
      const users = new Map(snapshot.users.map((user) => [user.id, user]));
      const messages = messageMapFrom(snapshot.messages);
      const drafts = new Map((snapshot.drafts ?? []).map((draft) => [draft.chatId, draft]));
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
        activeChatId: current.activeChatId ?? cachedActiveChatId,
        chatFilter: current.chatFilter !== "main" ? current.chatFilter : chatFilter,
      });
    };

    const loadHistory = async (chatId: string) => {
      if (get().authorization.kind !== "ready") return;
      const current = get().histories.get(chatId);
      if (current?.loading || current?.hasMore === false) return;

      const histories = new Map(get().histories);
      histories.set(chatId, { loading: true, hasMore: current?.hasMore ?? true });
      set({ histories });
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
        set({ histories: nextHistories, error: undefined });
        scheduleCacheWrite();
      } catch (error) {
        const nextHistories = new Map(get().histories);
        nextHistories.set(chatId, { loading: false, hasMore: true });
        set({
          histories: nextHistories,
          error: error instanceof Error ? error.message : "无法加载历史消息",
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
        const page = await transport.loadMoreChats(chatListId, 100);
        const nextChatLists = new Map(get().chatLists);
        nextChatLists.set(chatListId, { loading: false, hasMore: page.hasMore });
        set({ chatLists: nextChatLists, error: undefined });
        scheduleCacheWrite();
      } catch (error) {
        const nextChatLists = new Map(get().chatLists);
        nextChatLists.set(chatListId, { loading: false, hasMore: true });
        set({
          chatLists: nextChatLists,
          error: error instanceof Error ? error.message : "无法加载更多会话",
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
          set({ error: error instanceof Error ? error.message : "无法更新已读状态" });
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
          resumePendingDrafts();
          const activeChatId = get().activeChatId;
          if (activeChatId) {
            void loadHistory(activeChatId).then(() => markChatRead(activeChatId));
          }
        } else if (event.state.kind !== "preparing") {
          clearCachedData(!accountTransition);
        }
        return;
      }

      if (event.type === "currentUser.changed") {
        set({ currentUserId: event.userId });
        scheduleCacheWrite();
        void registerCurrentAccount();
        return;
      }

      if (event.type === "sync.error") {
        set({ phase: "error", error: event.message });
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
        for (const chat of incomingChats) chats.set(chat.id, chat);
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

      if (event.type === "chat.draftChanged") {
        const incoming = draftForSync(event.draft);
        const expected = draftSyncs.get(event.chatId);
        if (expected && draftSignature(incoming) !== draftSignature(expected.draft)) {
          return;
        }
        if (expected) {
          clearDraftSyncTimers(expected);
          draftSyncs.delete(event.chatId);
        }
        const drafts = new Map(get().drafts);
        if (incoming) drafts.set(event.chatId, { ...incoming, pending: false });
        else drafts.delete(event.chatId);
        set({ drafts });
        scheduleCacheWrite();
        return;
      }

      if (event.type === "drafts.replaced") {
        const incoming = new Map(event.drafts.map((draft) => [draft.chatId, draft]));
        const drafts = new Map(get().drafts);
        for (const chatId of event.chatIds) {
          if (drafts.get(chatId)?.pending) continue;
          const draft = incoming.get(chatId);
          if (draft) drafts.set(chatId, { ...draft, pending: false });
          else drafts.delete(chatId);
        }
        set({ drafts });
        scheduleCacheWrite();
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
      const discardPreviousAccount = previousAccountId !== accountId
        && !current.accounts.some((account) => account.id === previousAccountId);
      let disconnected = false;
      accountTransition = true;
      registeredAccountKey = undefined;
      set({ accountPending: true, accountError: undefined, error: undefined });
      try {
        await accountRegistration;
        await flushPendingDrafts();
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

    return {
      phase: "idle",
      transportKind: transport.kind,
      transportLabel: transport.label,
      authorization: { kind: "preparing" },
      authorizationPending: false,
      accounts: [],
      activeAccountId: "default",
      accountPending: false,
      proxyPending: false,
      storagePending: false,
      users: new Map(),
      folders: [],
      chats: new Map(),
      chatListReady: false,
      chatLists: new Map(),
      messages: new Map(),
      drafts: new Map(),
      histories: new Map(),
      searchQuery: "",
      chatFilter: "main",

      initialize: async () => {
        if (get().phase !== "idle") return;
        set({ phase: "loading", error: undefined });
        try {
          applyAccountState(await transport.getAccountState());
          let connectionSnapshot: Awaited<ReturnType<TelegramTransport["connect"]>> | undefined;
          let connectionError: unknown;
          const cacheLoad = transport
            .loadCachedSnapshot()
            .then(hydrateCachedSnapshot)
            .catch(() => undefined);
          const connection = transport.connect(applyEvent)
            .then((snapshot) => { connectionSnapshot = snapshot; })
            .catch((error) => { connectionError = error; });
          await cacheLoad;
          await connection;
          if (connectionError) throw connectionError;
          if (!connectionSnapshot) throw new Error("Telegram runtime 未返回启动快照");
          const snapshot = connectionSnapshot;
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
          if (authorization.kind === "ready") resumePendingDrafts();
          scheduleCacheWrite();
        } catch (error) {
          set({
            phase: "error",
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
        set({ accountPending: true, accountError: undefined, error: undefined });
        try {
          await accountRegistration;
          await flushPendingDrafts();
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
        if (previousChatId && previousChatId !== chatId) void flushDraft(previousChatId);
        set({ activeChatId: chatId });
        scheduleCacheWrite();
        if (get().authorization.kind !== "ready") return;
        await loadHistory(chatId);
        await markChatRead(chatId);
      },

      loadMoreChats: loadChats,
      loadMoreHistory: loadHistory,
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
          set({ messages, error: undefined });
          return permissions;
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "无法读取消息操作权限",
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
          set({ error: undefined });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "无法搜索聊天消息" });
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
        set({ messages, error: undefined });
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
          set({ error: error instanceof Error ? error.message : "无法更新表情回应" });
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
            set({ error: error instanceof Error ? error.message : "无法搜索会话" });
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
        expectDraftSync(chatId, draftForSync(next), DRAFT_SYNC_DELAY_MS);
        scheduleCacheWrite();
      },

      sendMessage: async (text, replyToMessageId) => {
        const chatId = get().activeChatId;
        const normalizedText = text.trim();
        if (!chatId || !normalizedText) return false;
        const previousDraft = get().drafts.get(chatId);
        await flushDraft(chatId);
        const clearExpectation = expectDraftSync(chatId, undefined);
        try {
          await transport.sendMessage({ chatId, text: normalizedText, replyToMessageId });
          const pendingClear = draftSyncs.get(chatId);
          if (pendingClear?.generation === clearExpectation.generation) {
            pendingClear.sent = true;
            pendingClear.ackTimer = globalThis.setTimeout(
              () => settleDraftWithoutServerUpdate(chatId, clearExpectation.generation),
              DRAFT_ACK_TIMEOUT_MS,
            );
          }
          const drafts = new Map(get().drafts);
          drafts.delete(chatId);
          set({ drafts, error: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          const pendingClear = draftSyncs.get(chatId);
          if (pendingClear?.generation === clearExpectation.generation) {
            clearDraftSyncTimers(pendingClear);
            draftSyncs.delete(chatId);
          }
          if (previousDraft) {
            const restored = { ...previousDraft, pending: true };
            const drafts = new Map(get().drafts);
            drafts.set(chatId, restored);
            set({ drafts });
            expectDraftSync(chatId, draftForSync(restored), 0);
          }
          set({ error: error instanceof Error ? error.message : "消息发送失败" });
          return false;
        }
      },

      editMessage: async (messageId, text) => {
        const chatId = get().activeChatId;
        const normalizedText = text.trim();
        if (!chatId || !normalizedText) return false;
        try {
          await transport.editMessage({ chatId, messageId, text: normalizedText });
          set({ error: undefined });
          return true;
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "消息编辑失败" });
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
          set({ messages, error: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "消息删除失败" });
          return false;
        }
      },

      forwardMessages: async (fromChatId, messageIds, toChatId) => {
        if (!get().chats.has(fromChatId) || !get().chats.has(toChatId)) return undefined;
        const uniqueMessageIds = [...new Set(messageIds)];
        if (uniqueMessageIds.length === 0) return undefined;
        if (uniqueMessageIds.length > 100) {
          set({ error: "单次最多转发 100 条消息" });
          return undefined;
        }
        try {
          const result = await transport.forwardMessages({ fromChatId, toChatId, messageIds: uniqueMessageIds });
          set({
            error: result.failedMessageIds.length > 0
              ? `${result.forwardedCount} 条消息已转发，${result.failedMessageIds.length} 条失败`
              : undefined,
          });
          scheduleCacheWrite();
          return result;
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "消息转发失败" });
          return undefined;
        }
      },

      downloadFile: async (fileId, fileName) => {
        try {
          await transport.downloadFile(fileId, fileName);
          set({ error: undefined });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "文件下载失败" });
        }
      },

      retryMessage: async (messageId) => {
        const chatId = get().activeChatId;
        if (!chatId) return;
        try {
          await transport.retryMessage(chatId, messageId);
          set({ error: undefined });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "消息重试失败" });
        }
      },

      sendFile: async (file) => {
        const chatId = get().activeChatId;
        if (!chatId) return false;
        try {
          const sent = await transport.sendFile({ chatId, file });
          if (sent) set({ error: undefined });
          return sent;
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "文件发送失败" });
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
          set({ messages, error: undefined });
          scheduleCacheWrite();
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "取消上传失败" });
        }
      },

      clearError: () => set({ error: undefined }),
    };
  });

export const telegramStore = createTelegramStore(createTelegramTransport());

export const useTelegramStore = <T,>(selector: (state: TelegramState) => T) =>
  useStore(telegramStore, selector);

export const filterAndSortChats = (
  chats: Iterable<Chat>,
  folderId: ChatFilter,
  searchQuery: string,
) => {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  return [...chats]
    .filter((chat) => {
      return normalizedQuery || chat.folderIds.includes(folderId);
    })
    .filter((chat) => {
      if (!normalizedQuery) return true;
      return `${chat.title} ${chat.preview}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .sort(
      compareChats,
    );
};

export const selectVisibleChats = (state: TelegramState) =>
  filterAndSortChats(state.chats.values(), state.chatFilter, state.searchQuery);
