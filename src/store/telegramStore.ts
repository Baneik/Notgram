import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createTelegramTransport } from "../telegram/createTransport";
import type { TelegramTransport } from "../telegram/transport";
import type {
  AuthorizationAction,
  AuthorizationState,
  CachedTelegramSnapshot,
  Chat,
  ChatFolder,
  Message,
  ProxySettings,
  StorageSettings,
  TelegramEvent,
  User,
} from "../telegram/types";

export type ChatFilter = string;
type RuntimePhase = "idle" | "loading" | "ready" | "error";

export interface HistoryState {
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
  users: Map<string, User>;
  folders: ChatFolder[];
  chats: Map<string, Chat>;
  chatListReady: boolean;
  messages: Map<string, Message[]>;
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
  selectChat: (chatId: string) => Promise<void>;
  loadMoreHistory: (chatId: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: ChatFilter) => void;
  sendMessage: (text: string) => Promise<boolean>;
  downloadFile: (fileId: number, fileName: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  sendFile: (file: File) => Promise<void>;
  clearError: () => void;
}

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

const compareChats = (left: Chat, right: Chat) =>
  Number(right.pinned) - Number(left.pinned) ||
  new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
  (left.id === right.id ? 0 : left.id < right.id ? -1 : 1);

const CACHE_VERSION = 1 as const;
const MAX_CACHED_MESSAGES_PER_CHAT = 60;
const MAX_CACHED_MESSAGES = 5_000;
const CACHE_CONTINUITY_WINDOW = 30;

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
      if (
        message.content.kind !== "media" ||
        !message.content.previewDataUrl ||
        message.content.previewDataUrl.length <= 32_768
      ) {
        return message;
      }
      return {
        ...message,
        content: { ...message.content, previewDataUrl: undefined },
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
  activeChatId: state.activeChatId,
  chatFilter: state.chatFilter,
});

export const createTelegramStore = (transport: TelegramTransport) =>
  createStore<TelegramState>((set, get) => {
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    let cacheWrite = Promise.resolve();
    const cachedMessageIds = new Map<string, Set<string>>();

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

    const clearCachedData = () => {
      if (cacheTimer) globalThis.clearTimeout(cacheTimer);
      cacheTimer = undefined;
      cachedMessageIds.clear();
      set({
        currentUserId: undefined,
        users: new Map(),
        folders: [],
        chats: new Map(),
        chatListReady: false,
        messages: new Map(),
        histories: new Map(),
        activeChatId: undefined,
        chatFilter: "main",
      });
      void transport.clearCachedSnapshot().catch(() => undefined);
    };

    const hydrateCachedSnapshot = (snapshot?: CachedTelegramSnapshot) => {
      if (!snapshot || snapshot.version !== CACHE_VERSION || !snapshot.currentUserId) return;
      const current = get();
      const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
      const users = new Map(snapshot.users.map((user) => [user.id, user]));
      const messages = messageMapFrom(snapshot.messages);
      cachedMessageIds.clear();
      for (const message of snapshot.messages) {
        const ids = cachedMessageIds.get(message.chatId) ?? new Set<string>();
        ids.add(message.id);
        cachedMessageIds.set(message.chatId, ids);
      }
      for (const [id, chat] of current.chats) chats.set(id, chat);
      for (const [id, user] of current.users) users.set(id, user);
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

          const confirmedCachedCount = [...pendingCachedIds].filter(
            (messageId) => confirmedIds.has(messageId),
          ).length;
          const continuityConfirmed =
            confirmedIds.size >= CACHE_CONTINUITY_WINDOW ||
            (!page.hasMore && confirmedCachedCount === pendingCachedIds.size);
          if (continuityConfirmed) {
            const currentMessages = get().messages.get(chatId) ?? [];
            const contiguousMessages = currentMessages.filter(
              (message) => !pendingCachedIds.has(message.id) || confirmedIds.has(message.id),
            );
            if (contiguousMessages.length !== currentMessages.length) {
              const nextMessages = new Map(get().messages);
              nextMessages.set(chatId, contiguousMessages);
              set({ messages: nextMessages });
            }
            cachedMessageIds.delete(chatId);
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

    const applyEvent = (event: TelegramEvent) => {
      if (event.type === "authorization.changed") {
        set({
          authorization: event.state,
          authorizationPending: false,
          authorizationError: undefined,
        });
        if (event.state.kind === "ready") {
          scheduleCacheWrite();
          const activeChatId = get().activeChatId;
          if (activeChatId) void loadHistory(activeChatId);
        } else if (event.state.kind !== "preparing") {
          clearCachedData();
        }
        return;
      }

      if (event.type === "currentUser.changed") {
        set({ currentUserId: event.userId });
        scheduleCacheWrite();
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
        if (firstChat) void loadHistory(firstChat);
        return;
      }

      if (event.type === "user.upsert") {
        const users = new Map(get().users);
        users.set(event.user.id, event.user);
        set({ users });
        scheduleCacheWrite();
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

      const messages = new Map(get().messages);
      messages.set(
        event.message.chatId,
        upsertMessage(messages.get(event.message.chatId) ?? [], event.message),
      );
      set({ messages });
      scheduleCacheWrite();
    };

    return {
      phase: "idle",
      transportKind: transport.kind,
      transportLabel: transport.label,
      authorization: { kind: "preparing" },
      authorizationPending: false,
      proxyPending: false,
      storagePending: false,
      users: new Map(),
      folders: [],
      chats: new Map(),
      chatListReady: false,
      messages: new Map(),
      histories: new Map(),
      searchQuery: "",
      chatFilter: "main",

      initialize: async () => {
        if (get().phase !== "idle") return;
        set({ phase: "loading", error: undefined });
        try {
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
            activeChatId: current.activeChatId ?? firstChat?.id,
            chatFilter:
              (current.folders.length > 0 ? current.folders : folders).some(
                (folder) => folder.id === current.chatFilter,
              )
                ? current.chatFilter
                : (folders[0]?.id ?? "main"),
          });
          const refreshChatId = get().activeChatId ?? firstChat?.id;
          if (authorization.kind === "ready" && refreshChatId) {
            await loadHistory(refreshChatId);
          }
          scheduleCacheWrite();
        } catch (error) {
          set({
            phase: "error",
            error: error instanceof Error ? error.message : "无法启动 Telegram runtime",
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

      selectChat: async (chatId) => {
        set({ activeChatId: chatId });
        scheduleCacheWrite();
        if (get().authorization.kind !== "ready") return;
        await loadHistory(chatId);
        try {
          await transport.markChatRead(chatId);
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "无法更新已读状态" });
        }
      },

      loadMoreHistory: loadHistory,

      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setChatFilter: (chatFilter) => {
        set({ chatFilter });
        scheduleCacheWrite();
      },

      sendMessage: async (text) => {
        const chatId = get().activeChatId;
        const normalizedText = text.trim();
        if (!chatId || !normalizedText) return false;
        try {
          await transport.sendMessage({ chatId, text: normalizedText });
          set({ error: undefined });
          return true;
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "消息发送失败" });
          return false;
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
        if (!chatId) return;
        try {
          await transport.sendFile({ chatId, file });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "文件发送失败" });
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
      return chat.folderIds.includes(folderId);
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
