import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createTelegramTransport } from "../telegram/createTransport";
import type { TelegramTransport } from "../telegram/transport";
import type {
  AuthorizationAction,
  AuthorizationState,
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

export const createTelegramStore = (transport: TelegramTransport) =>
  createStore<TelegramState>((set, get) => {
    const loadHistory = async (chatId: string) => {
      const current = get().histories.get(chatId);
      if (current?.loading || current?.hasMore === false) return;

      const histories = new Map(get().histories);
      histories.set(chatId, { loading: true, hasMore: current?.hasMore ?? true });
      set({ histories });
      try {
        const page = await transport.loadChatHistory(chatId, 30);
        const nextHistories = new Map(get().histories);
        nextHistories.set(chatId, { loading: false, hasMore: page.hasMore });
        set({ histories: nextHistories, error: undefined });
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
        return;
      }

      if (event.type === "currentUser.changed") {
        set({ currentUserId: event.userId });
        return;
      }

      if (event.type === "sync.error") {
        set({ phase: "error", error: event.message });
        return;
      }

      if (event.type === "folders.replaced") {
        const activeFolderExists = event.folders.some(
          (folder) => folder.id === get().chatFilter,
        );
        set({
          folders: event.folders,
          chatFilter: activeFolderExists
            ? get().chatFilter
            : (event.folders[0]?.id ?? "main"),
        });
        return;
      }

      if (event.type === "chat.upsert") {
        const chats = new Map(get().chats);
        chats.set(event.chat.id, event.chat);
        const firstChat = get().activeChatId ? undefined : event.chat.id;
        set({ chats, activeChatId: get().activeChatId ?? firstChat });
        if (firstChat) void loadHistory(firstChat);
        return;
      }

      if (event.type === "user.upsert") {
        const users = new Map(get().users);
        users.set(event.user.id, event.user);
        set({ users });
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
        return;
      }

      const messages = new Map(get().messages);
      messages.set(
        event.message.chatId,
        upsertMessage(messages.get(event.message.chatId) ?? [], event.message),
      );
      set({ messages });
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
      messages: new Map(),
      histories: new Map(),
      searchQuery: "",
      chatFilter: "main",

      initialize: async () => {
        if (get().phase !== "idle") return;
        set({ phase: "loading", error: undefined });
        try {
          const snapshot = await transport.connect(applyEvent);
          const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
          const users = new Map(snapshot.users.map((user) => [user.id, user]));
          const folders = snapshot.folders;
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
          set({
            phase: current.phase === "error" ? "error" : "ready",
            currentUserId:
              current.currentUserId && current.currentUserId !== "self"
                ? current.currentUserId
                : snapshot.currentUserId,
            authorization:
              current.authorization.kind === "preparing"
                ? snapshot.authorization
                : current.authorization,
            chats,
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
          if (!current.activeChatId && firstChat) {
            await loadHistory(firstChat.id);
          }
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
        await loadHistory(chatId);
        try {
          await transport.markChatRead(chatId);
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "无法更新已读状态" });
        }
      },

      loadMoreHistory: loadHistory,

      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setChatFilter: (chatFilter) => set({ chatFilter }),

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
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
};

export const selectVisibleChats = (state: TelegramState) =>
  filterAndSortChats(state.chats.values(), state.chatFilter, state.searchQuery);
