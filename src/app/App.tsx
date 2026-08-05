import { CircleAlert, LoaderCircle, X } from "lucide-react";
import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ChatSidebar } from "../components/ChatSidebar";
import { Conversation } from "../components/Conversation";
import { NavigationRail } from "../components/NavigationRail";
import { AuthorizationScreen } from "../components/AuthorizationScreen";
import { SettingsDialog } from "../components/SettingsDialog";
import { ProfileDrawer } from "../components/ProfileDrawer";
import { FolderManagerDialog } from "../components/FolderManagerDialog";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { filterAndSortChats, telegramStore, useTelegramStore } from "../store/telegramStore";
import { usePreferencesStore } from "../store/preferencesStore";
import { messageContentText } from "../telegram/messageContent";
import { connectionPresentation } from "../telegram/connectionState";
import {
  listenForDesktopNotificationOpen,
  showDesktopNotification,
  type DesktopNotificationRoute,
} from "../notifications/desktopNotifications";
import {
  notificationPresentation,
  shouldNotifyMessage,
} from "../notifications/messageNotificationPolicy";
import {
  clearPendingNotificationRoute,
  readPendingNotificationRoute,
  savePendingNotificationRoute,
} from "../notifications/notificationRouting";
import { mediaPlaybackCoordinator } from "../media/mediaPlayback";
import { hasConversationScrollMemory } from "../hooks/useConversationScroll";
import {
  beginConversationSwitch,
  isConversationSwitchActive,
  logPerformance,
  markConversationSwitch,
} from "../utils/performanceMonitor";
import { openSettingsWindow } from "../windows/settingsWindow";
import {
  captureConversationSwitchSnapshot,
  removeConversationSwitchSnapshot,
} from "../utils/conversationSwitchSnapshot";

const DEFAULT_SIDEBAR_WIDTH = 360;
const SIDEBAR_WIDTH_STORAGE_KEY = "notgram.sidebar-width";
const CONVERSATION_SNAPSHOT_MAX_MS = 240;

type PendingConfirmation =
  | { kind: "leaveGroup"; chatId: string; title: string }
  | { kind: "deleteFolder"; folderId: string; title: string };

const readSidebarWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 250 ? stored : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
};

export function App() {
  const phase = useTelegramStore((state) => state.phase);
  const error = useTelegramStore((state) => state.error);
  const operationError = useTelegramStore((state) => state.operationError);
  const chatFilter = useTelegramStore((state) => state.chatFilter);
  const searchQuery = useTelegramStore((state) => state.searchQuery);
  const activeChatId = useTelegramStore((state) => state.activeChatId);
  const activeAccountId = useTelegramStore((state) => state.activeAccountId);
  const chats = useTelegramStore((state) => state.chats);
  const chatListReady = useTelegramStore((state) => state.chatListReady);
  const chatLists = useTelegramStore((state) => state.chatLists);
  const folders = useTelegramStore((state) => state.folders);
  const users = useTelegramStore((state) => state.users);
  const messages = useTelegramStore((state) => state.messages);
  const typingUserIds = useTelegramStore((state) => state.typingUserIds);
  const outbox = useTelegramStore((state) => state.outbox);
  const histories = useTelegramStore((state) => state.histories);
  const globalSearch = useTelegramStore((state) => state.globalSearch);
  const profile = useTelegramStore((state) => state.profile);
  const currentUserId = useTelegramStore((state) => state.currentUserId);
  const chatManagementPending = useTelegramStore((state) => state.chatManagementPending);
  const folderManagementPending = useTelegramStore((state) => state.folderManagementPending);
  const transportKind = useTelegramStore((state) => state.transportKind);
  const connectionStatus = useTelegramStore((state) => state.connectionStatus);
  const authorization = useTelegramStore((state) => state.authorization);
  const authorizationPending = useTelegramStore((state) => state.authorizationPending);
  const authorizationError = useTelegramStore((state) => state.authorizationError);
  const initialize = useTelegramStore((state) => state.initialize);
  const selectChat = useTelegramStore((state) => state.selectChat);
  const loadMessage = useTelegramStore((state) => state.loadMessage);
  const loadChatProfile = useTelegramStore((state) => state.loadChatProfile);
  const loadUserProfile = useTelegramStore((state) => state.loadUserProfile);
  const loadCurrentUserProfile = useTelegramStore((state) => state.loadCurrentUserProfile);
  const clearProfile = useTelegramStore((state) => state.clearProfile);
  const startPrivateChat = useTelegramStore((state) => state.startPrivateChat);
  const loadMoreChats = useTelegramStore((state) => state.loadMoreChats);
  const reorderPinnedChats = useTelegramStore((state) => state.reorderPinnedChats);
  const setChatPinned = useTelegramStore((state) => state.setChatPinned);
  const setChatMuted = useTelegramStore((state) => state.setChatMuted);
  const setChatArchived = useTelegramStore((state) => state.setChatArchived);
  const leaveGroup = useTelegramStore((state) => state.leaveGroup);
  const createChatFolder = useTelegramStore((state) => state.createChatFolder);
  const renameChatFolder = useTelegramStore((state) => state.renameChatFolder);
  const deleteChatFolder = useTelegramStore((state) => state.deleteChatFolder);
  const setChatFolderMembership = useTelegramStore((state) => state.setChatFolderMembership);
  const markChatFolderRead = useTelegramStore((state) => state.markChatFolderRead);
  const markActiveChatRead = useTelegramStore((state) => state.markActiveChatRead);
  const setSearchQuery = useTelegramStore((state) => state.setSearchQuery);
  const setChatFilter = useTelegramStore((state) => state.setChatFilter);
  const sendMessage = useTelegramStore((state) => state.sendMessage);
  const editMessage = useTelegramStore((state) => state.editMessage);
  const deleteMessage = useTelegramStore((state) => state.deleteMessage);
  const updateChatDraft = useTelegramStore((state) => state.updateChatDraft);
  const setChatTyping = useTelegramStore((state) => state.setChatTyping);
  const forwardMessages = useTelegramStore((state) => state.forwardMessages);
  const loadMessageProperties = useTelegramStore((state) => state.loadMessageProperties);
  const loadRawMessage = useTelegramStore((state) => state.loadRawMessage);
  const setMessageReaction = useTelegramStore((state) => state.setMessageReaction);
  const searchChatMessages = useTelegramStore((state) => state.searchChatMessages);
  const searchGlobal = useTelegramStore((state) => state.searchGlobal);
  const loadMoreGlobalSearch = useTelegramStore((state) => state.loadMoreGlobalSearch);
  const cancelGlobalSearch = useTelegramStore((state) => state.cancelGlobalSearch);
  const clearGlobalSearch = useTelegramStore((state) => state.clearGlobalSearch);
  const downloadFile = useTelegramStore((state) => state.downloadFile);
  const cancelFileDownload = useTelegramStore((state) => state.cancelFileDownload);
  const openFile = useTelegramStore((state) => state.openFile);
  const saveFileAs = useTelegramStore((state) => state.saveFileAs);
  const openDownloadDirectory = useTelegramStore((state) => state.openDownloadDirectory);
  const streamFile = useTelegramStore((state) => state.streamFile);
  const suspendFileStream = useTelegramStore((state) => state.suspendFileStream);
  const retryMessage = useTelegramStore((state) => state.retryMessage);
  const sendFile = useTelegramStore((state) => state.sendFile);
  const sendFiles = useTelegramStore((state) => state.sendFiles);
  const cancelFileUpload = useTelegramStore((state) => state.cancelFileUpload);
  const loadMoreHistory = useTelegramStore((state) => state.loadMoreHistory);
  const clearError = useTelegramStore((state) => state.clearError);
  const clearOperationError = useTelegramStore((state) => state.clearOperationError);
  const authenticate = useTelegramStore((state) => state.authenticate);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderManagerOpen, setFolderManagerOpen] = useState(false);
  const [folderManagerInitialId, setFolderManagerInitialId] = useState<string>();
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [latestScrollRequest, setLatestScrollRequest] = useState<{
    chatId: string;
    requestId: number;
    performanceTraceId?: number;
  }>();
  const latestScrollRequestIdRef = useRef(0);
  const [entryScrollRequest, setEntryScrollRequest] = useState<{
    chatId: string;
    serverMessageId?: string;
    requestId: number;
    performanceTraceId?: number;
  }>();
  const entryScrollRequestIdRef = useRef(0);
  const chatOpenGenerationRef = useRef(0);
  const [messageScrollRequest, setMessageScrollRequest] = useState<{
    chatId: string;
    messageId: string;
    requestId: number;
    performanceTraceId?: number;
  }>();
  const messageScrollRequestIdRef = useRef(0);
  const latestConversationIntentChatIdRef = useRef<string | undefined>(undefined);
  const conversationSnapshotRef = useRef<HTMLElement | undefined>(undefined);
  const conversationSnapshotTargetRef = useRef<string | undefined>(undefined);
  const conversationSnapshotTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const discardConversationSnapshot = useCallback(() => {
    if (conversationSnapshotTimerRef.current !== undefined) {
      globalThis.clearTimeout(conversationSnapshotTimerRef.current);
      conversationSnapshotTimerRef.current = undefined;
    }
    removeConversationSwitchSnapshot(conversationSnapshotRef.current);
    conversationSnapshotRef.current = undefined;
    conversationSnapshotTargetRef.current = undefined;
  }, []);
  const beginConversationSnapshot = useCallback((chatId: string) => {
    if (telegramStore.getState().activeChatId === chatId) return;
    if (conversationSnapshotRef.current && !conversationSnapshotRef.current.isConnected) {
      discardConversationSnapshot();
    }
    if (!conversationSnapshotRef.current) {
      conversationSnapshotRef.current = captureConversationSwitchSnapshot();
    }
    if (conversationSnapshotRef.current) {
      conversationSnapshotTargetRef.current = chatId;
      if (conversationSnapshotTimerRef.current !== undefined) {
        globalThis.clearTimeout(conversationSnapshotTimerRef.current);
      }
      conversationSnapshotTimerRef.current = globalThis.setTimeout(() => {
        if (conversationSnapshotTargetRef.current === chatId) {
          discardConversationSnapshot();
        }
      }, CONVERSATION_SNAPSHOT_MAX_MS);
    }
  }, [discardConversationSnapshot]);
  const finishConversationSnapshot = useCallback((chatId: string) => {
    if (
      conversationSnapshotTargetRef.current !== chatId ||
      telegramStore.getState().activeChatId !== chatId
    ) return;
    discardConversationSnapshot();
  }, [discardConversationSnapshot]);
  useEffect(() => {
    globalThis.addEventListener("resize", discardConversationSnapshot, { passive: true });
    return () => {
      globalThis.removeEventListener("resize", discardConversationSnapshot);
      discardConversationSnapshot();
    };
  }, [discardConversationSnapshot]);
  const notificationsEnabled = usePreferencesStore((state) => state.notificationsEnabled);
  const notificationSound = usePreferencesStore((state) => state.notificationSound);
  const notificationPreview = usePreferencesStore((state) => state.notificationPreview);
  const knownLatestMessagesRef = useRef<Set<string> | undefined>(undefined);
  const openSettings = useCallback(() => {
    void openSettingsWindow()
      .then((opened) => { if (!opened) setSettingsOpen(true); })
      .catch(() => setSettingsOpen(true));
  }, []);

  const closeSearch = useCallback((restoreFocus = false) => {
    cancelGlobalSearch();
    clearGlobalSearch();
    setSearchQuery("");
    if (restoreFocus) {
      globalThis.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [cancelGlobalSearch, clearGlobalSearch, setSearchQuery]);

  const updateSearchQuery = useCallback((value: string) => {
    if (!value.trim()) {
      cancelGlobalSearch();
      clearGlobalSearch();
    }
    setSearchQuery(value);
  }, [cancelGlobalSearch, clearGlobalSearch, setSearchQuery]);

  const openFolderManager = useCallback((folderId?: string) => {
    setFolderManagerInitialId(folderId);
    setFolderManagerOpen(true);
  }, []);

  const closeFolderManager = useCallback(() => {
    setFolderManagerOpen(false);
    setFolderManagerInitialId(undefined);
  }, []);

  const openGlobalSearchChat = useCallback(async (chatId: string) => {
    const state = telegramStore.getState();
    const targetMessages = state.messages.get(chatId) ?? [];
    const performanceTraceId = beginConversationSwitch({
      cached: targetMessages.length > 0,
      messageCount: targetMessages.length,
      viewTransition: false,
      navigationKind: 3,
    });
    markConversationSwitch(performanceTraceId, "transitionStarted");
    markConversationSwitch(performanceTraceId, "selectionCommitted");
    beginConversationSnapshot(chatId);
    await selectChat(chatId);
    closeSearch();
    setMobileChatOpen(true);
    latestScrollRequestIdRef.current += 1;
    setLatestScrollRequest({
      chatId,
      requestId: latestScrollRequestIdRef.current,
      performanceTraceId,
    });
    requestAnimationFrame(() => {
      markConversationSwitch(performanceTraceId, "transitionFinished");
    });
  }, [beginConversationSnapshot, closeSearch, selectChat]);

  const openGlobalSearchMessage = useCallback(async (chatId: string, messageId: string) => {
    const state = telegramStore.getState();
    const targetMessages = state.messages.get(chatId) ?? [];
    const performanceTraceId = beginConversationSwitch({
      cached: targetMessages.some((message) => message.id === messageId),
      messageCount: targetMessages.length,
      viewTransition: false,
      navigationKind: 3,
    });
    markConversationSwitch(performanceTraceId, "transitionStarted");
    markConversationSwitch(performanceTraceId, "selectionCommitted");
    beginConversationSnapshot(chatId);
    await selectChat(chatId);
    await loadMessage(chatId, messageId);
    closeSearch();
    setMobileChatOpen(true);
    messageScrollRequestIdRef.current += 1;
    setMessageScrollRequest({
      chatId,
      messageId,
      requestId: messageScrollRequestIdRef.current,
      performanceTraceId,
    });
    requestAnimationFrame(() => {
      markConversationSwitch(performanceTraceId, "transitionFinished");
    });
  }, [beginConversationSnapshot, closeSearch, loadMessage, selectChat]);

  const openProfileMessage = useCallback((chatId: string, messageId: string) => {
    clearProfile();
    void openGlobalSearchMessage(chatId, messageId);
  }, [clearProfile, openGlobalSearchMessage]);

  const openProfilePrivateChat = useCallback(async (userId: string) => {
    const chatId = await startPrivateChat(userId);
    if (!chatId) return;
    clearProfile();
    beginConversationSnapshot(chatId);
    await selectChat(chatId);
    setMobileChatOpen(true);
  }, [beginConversationSnapshot, clearProfile, selectChat, startPrivateChat]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const routeMediaSpacebar = (event: globalThis.KeyboardEvent) => {
      if (
        (event.code !== "Space" && event.key !== " ") ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat
      ) {
        return;
      }
      const target = event.target;
      const isTextEntry = target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && [
          "text", "search", "email", "url", "tel", "password", "number",
        ].includes(target.type)) ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isTextEntry || !mediaPlaybackCoordinator.toggleKeyboardTarget()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    window.addEventListener("keydown", routeMediaSpacebar, { capture: true });
    return () => window.removeEventListener("keydown", routeMediaSpacebar, { capture: true });
  }, []);

  useEffect(() => {
    const openSearch = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSettingsOpen(false);
        setMobileChatOpen(false);
        clearProfile();
        globalThis.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [clearProfile]);

  const openNotificationRoute = useCallback(async (route: DesktopNotificationRoute) => {
    const state = telegramStore.getState();
    if (route.accountId !== state.activeAccountId) {
      savePendingNotificationRoute(route);
      if (!await state.switchAccount(route.accountId)) clearPendingNotificationRoute();
      return;
    }

    state.clearGlobalSearch();
    state.setSearchQuery("");
    state.clearProfile();
    beginConversationSnapshot(route.chatId);
    await state.selectChat(route.chatId);
    await telegramStore.getState().loadMessage(route.chatId, route.messageId);
    clearPendingNotificationRoute();
    setMobileChatOpen(true);
    messageScrollRequestIdRef.current += 1;
    setMessageScrollRequest({
      chatId: route.chatId,
      messageId: route.messageId,
      requestId: messageScrollRequestIdRef.current,
    });
  }, [beginConversationSnapshot]);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void listenForDesktopNotificationOpen((route) => {
      if (!disposed) void openNotificationRoute(route);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [openNotificationRoute]);

  useEffect(() => {
    if (!chatListReady || authorization.kind !== "ready") return;
    const pendingRoute = readPendingNotificationRoute();
    if (pendingRoute?.accountId === activeAccountId) {
      void openNotificationRoute(pendingRoute);
    }
  }, [activeAccountId, authorization.kind, chatListReady, openNotificationRoute]);

  useEffect(() => {
    const markWhenVisible = () => {
      if (document.visibilityState === "visible") void markActiveChatRead();
    };
    document.addEventListener("visibilitychange", markWhenVisible);
    window.addEventListener("focus", markWhenVisible);
    return () => {
      document.removeEventListener("visibilitychange", markWhenVisible);
      window.removeEventListener("focus", markWhenVisible);
    };
  }, [markActiveChatRead]);

  useEffect(() => {
    const latestMessages = [...messages.values()]
      .map((chatMessages) => chatMessages.at(-1))
      .filter((message) => message !== undefined);
    if (!knownLatestMessagesRef.current) {
      knownLatestMessagesRef.current = new Set(
        latestMessages.map((message) => `${message.chatId}:${message.id}`),
      );
      return;
    }

    for (const message of latestMessages) {
      const key = `${message.chatId}:${message.id}`;
      if (knownLatestMessagesRef.current.has(key)) continue;
      knownLatestMessagesRef.current.add(key);
      const chat = chats.get(message.chatId);
      if (!shouldNotifyMessage({
        outgoing: message.outgoing,
        notificationsEnabled,
        muted: chat?.muted ?? false,
        activeChat: message.chatId === activeChatId,
        appVisible: document.visibilityState === "visible",
      })) continue;
      const presentation = notificationPresentation({
        showPreview: notificationPreview,
        chatTitle: chat?.title,
        messageText: messageContentText(message.content),
      });
      void showDesktopNotification({
        ...presentation,
        sound: notificationSound,
        route: {
          accountId: activeAccountId,
          chatId: message.chatId,
          messageId: message.id,
        },
      });
    }
  }, [
    activeChatId,
    chats,
    messages,
    notificationPreview,
    notificationSound,
    notificationsEnabled,
  ]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // A blocked preference store should not affect the messaging UI.
    }
  }, [sidebarWidth]);

  const previewSidebarWidth = useCallback((width: number) => {
    document.documentElement.style.setProperty("--chat-sidebar-width", `${width}px`);
  }, []);

  useLayoutEffect(() => {
    previewSidebarWidth(sidebarWidth);
  }, [previewSidebarWidth, sidebarWidth]);

  const visibleChats = useMemo(
    () => filterAndSortChats(chats.values(), chatFilter, searchQuery),
    [chatFilter, chats, searchQuery],
  );
  const forwardTargets = useMemo(
    () => [...chats.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    ),
    [chats],
  );
  const activeOutbox = activeChatId
    ? outbox.filter((item) => item.chatId === activeChatId)
    : [];

  if (!chatListReady && (authorization.kind === "preparing" || authorization.kind === "ready")) {
    return phase === "error" ? (
      <div className="startup-screen startup-error" role="alert">
        <CircleAlert size={19} />
        <span>{error ?? "无法载入会话"}</span>
      </div>
    ) : (
      <div className="startup-screen" role="status">
        <LoaderCircle className="spin" size={19} />
        <span>{connectionPresentation(connectionStatus).label}</span>
      </div>
    );
  }

  if (authorization.kind !== "ready" && authorization.kind !== "preparing") {
    return (
      <>
      <AuthorizationScreen
        state={authorization}
        pending={authorizationPending}
        error={authorizationError}
        connectionStatus={connectionStatus}
        onSubmit={authenticate}
        onOpenSettings={openSettings}
      />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </>
    );
  }

  const activeChat = activeChatId ? chats.get(activeChatId) : undefined;
  const activeMessages = activeChatId ? messages.get(activeChatId) ?? [] : [];
  const activeHistory = activeChatId
    ? histories.get(activeChatId) ?? { loading: false, hasMore: true, initialized: false }
    : { loading: false, hasMore: false, initialized: false };
  const activeChatList = chatLists.get(chatFilter) ?? { loading: false, hasMore: true };

  return (
    <>
      <main
        inert={settingsOpen || folderManagerOpen || Boolean(pendingConfirmation)}
        aria-hidden={settingsOpen || folderManagerOpen || Boolean(pendingConfirmation) || undefined}
        className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}
      >
        <NavigationRail
          folders={folders}
          chats={[...chats.values()]}
          account={currentUserId ? users.get(currentUserId) : undefined}
          filter={chatFilter}
          folderManagementPending={folderManagementPending}
          onFilterChange={(filter) => {
            closeSearch();
            setChatFilter(filter);
          }}
          onManageFolders={() => openFolderManager()}
          onEditFolder={openFolderManager}
          onMarkFolderRead={markChatFolderRead}
          onRequestDeleteFolder={(folder) => setPendingConfirmation({
            kind: "deleteFolder",
            folderId: folder.id,
            title: folder.title,
          })}
          onOpenSettings={openSettings}
        />
        <ChatSidebar
          chats={visibleChats}
          allChats={chats}
          users={users}
          folders={folders}
          activeChatId={activeChatId}
          folderId={chatFilter}
          folderTitle={folders.find((folder) => folder.id === chatFilter)?.title ?? "聊天"}
          searchQuery={searchQuery}
          searchInputRef={searchInputRef}
          onSearchChange={updateSearchQuery}
          globalSearch={globalSearch}
          onSearchMessages={searchGlobal}
          onLoadMoreSearchMessages={loadMoreGlobalSearch}
          onCancelMessageSearch={cancelGlobalSearch}
          onOpenSearchMessage={(chatId, messageId) => {
            void openGlobalSearchMessage(chatId, messageId);
          }}
          onSelect={(chatId) => {
            if (searchQuery.trim()) void openGlobalSearchChat(chatId);
            else {
              setMobileChatOpen(true);
              const state = telegramStore.getState();
              if (state.activeChatId === chatId) return;
              latestConversationIntentChatIdRef.current = undefined;
              beginConversationSnapshot(chatId);
              const generation = chatOpenGenerationRef.current + 1;
              chatOpenGenerationRef.current = generation;
              const targetChat = state.chats.get(chatId);
              const serverMessageId = targetChat && targetChat.unreadCount > 0
                ? targetChat.lastReadInboxMessageId
                : undefined;
              const serverMessageLoaded = Boolean(
                serverMessageId &&
                (state.messages.get(chatId) ?? []).some(
                  (message) => message.id === serverMessageId,
                ),
              );
              const restoreLocally = hasConversationScrollMemory(activeAccountId, chatId);
              const targetMessages = state.messages.get(chatId) ?? [];
              const performanceTraceId = beginConversationSwitch({
                cached: targetMessages.length > 0,
                messageCount: targetMessages.length,
                viewTransition: false,
                navigationKind: 1,
              });
              entryScrollRequestIdRef.current += 1;
              markConversationSwitch(performanceTraceId, "transitionStarted");
              markConversationSwitch(performanceTraceId, "selectionCommitted");
              flushSync(() => {
                if (latestConversationIntentChatIdRef.current !== chatId) {
                  setLatestScrollRequest(undefined);
                }
                setEntryScrollRequest({
                  chatId,
                  serverMessageId,
                  requestId: entryScrollRequestIdRef.current,
                  performanceTraceId,
                });
                void state.selectChat(chatId);
              });
              requestAnimationFrame(() => {
                markConversationSwitch(performanceTraceId, "transitionFinished");
              });
              if (serverMessageId && !serverMessageLoaded && !restoreLocally) {
                void (async () => {
                  const loaded = await telegramStore.getState().loadMessage(
                    chatId,
                    serverMessageId,
                  );
                  if (loaded || chatOpenGenerationRef.current !== generation) return;
                  entryScrollRequestIdRef.current += 1;
                  flushSync(() => {
                    setEntryScrollRequest({
                      chatId,
                      requestId: entryScrollRequestIdRef.current,
                      performanceTraceId,
                    });
                  });
                })();
              }
            }
          }}
          onOpenLatest={(chatId) => {
            chatOpenGenerationRef.current += 1;
            latestConversationIntentChatIdRef.current = chatId;
            beginConversationSnapshot(chatId);
            setMobileChatOpen(true);
            const state = telegramStore.getState();
            const targetMessages = state.messages.get(chatId) ?? [];
            const performanceTraceId = beginConversationSwitch({
              cached: targetMessages.length > 0,
              messageCount: targetMessages.length,
              viewTransition: false,
              navigationKind: 2,
            });
            markConversationSwitch(performanceTraceId, "transitionStarted");
            markConversationSwitch(performanceTraceId, "selectionCommitted");
            flushSync(() => {
              setEntryScrollRequest(undefined);
              latestScrollRequestIdRef.current += 1;
              setLatestScrollRequest({
                chatId,
                requestId: latestScrollRequestIdRef.current,
                performanceTraceId,
              });
            });
            requestAnimationFrame(() => {
              markConversationSwitch(performanceTraceId, "transitionFinished");
            });
            if (state.activeChatId !== chatId) {
              void state.selectChat(chatId);
            }
          }}
          loadingMore={activeChatList.loading}
          hasMore={activeChatList.hasMore}
          onLoadMore={() => loadMoreChats(chatFilter)}
          onReorderPinned={(chatIds) => { void reorderPinnedChats(chatFilter, chatIds); }}
          chatManagementPending={chatManagementPending}
          folderManagementPending={folderManagementPending}
          onSetPinned={setChatPinned}
          onSetFolderMembership={setChatFolderMembership}
          onRequestLeaveGroup={(chat) => setPendingConfirmation({
            kind: "leaveGroup",
            chatId: chat.id,
            title: chat.title,
          })}
          width={sidebarWidth}
          onWidthPreview={previewSidebarWidth}
          onWidthChange={setSidebarWidth}
        />
          <Profiler
            id="conversation"
            onRender={(_id, phase, actualDuration, baseDuration, startTime) => {
              const performanceTraceId = messageScrollRequest?.chatId === activeChatId
                ? messageScrollRequest?.performanceTraceId
                : latestScrollRequest?.chatId === activeChatId
                  ? latestScrollRequest?.performanceTraceId
                  : entryScrollRequest?.chatId === activeChatId
                    ? entryScrollRequest?.performanceTraceId
                    : undefined;
              queueMicrotask(() => {
                const tracing = isConversationSwitchActive(performanceTraceId);
                markConversationSwitch(performanceTraceId, "reactCommitted", {
                  durationMs: actualDuration,
                });
                if (actualDuration >= 4) {
                  logPerformance("ui_react_commit", {
                    startTimeMs: startTime,
                    durationMs: actualDuration,
                    baseDurationMs: baseDuration,
                    phaseKind: phase === "mount" ? 1 : 2,
                    componentKind: 1,
                    traceId: tracing ? performanceTraceId : undefined,
                    duringConversationSwitch: tracing,
                  });
                }
              });
            }}
          >
            <Conversation
          chat={activeChat}
          scrollScope={activeAccountId}
          entryScrollRequest={entryScrollRequest}
          latestScrollRequest={latestScrollRequest}
          messageScrollRequest={messageScrollRequest}
          messages={activeMessages}
          forwardTargets={forwardTargets}
          users={users}
          historyLoading={activeHistory.loading}
          historyInitialized={activeHistory.initialized === true}
          hasOlderMessages={activeHistory.hasMore}
          transportKind={transportKind}
          connectionStatus={connectionStatus}
          queuedMessageCount={activeOutbox.filter((item) => item.status === "queued").length}
          failedQueuedMessageCount={activeOutbox.filter((item) => item.status === "failed").length}
          typingUserIds={activeChatId ? typingUserIds.get(activeChatId) ?? [] : []}
          chatListId={activeChat?.folderIds.includes(chatFilter)
            ? chatFilter
            : activeChat?.folderIds.includes("archive") ? "archive" : "main"}
          chatManagementPending={activeChatId
            ? chatManagementPending.has(activeChatId)
            : false}
          onSendMessage={sendMessage}
          onEditMessage={editMessage}
          onDeleteMessage={deleteMessage}
          onDraftChange={updateChatDraft}
          onTypingChange={setChatTyping}
          onForwardMessages={forwardMessages}
          onLoadMessageProperties={loadMessageProperties}
          onLoadRawMessage={loadRawMessage}
          onSetMessageReaction={setMessageReaction}
          onSearchMessages={searchChatMessages}
          onDownloadFile={downloadFile}
          onCancelFileDownload={cancelFileDownload}
          onOpenFile={openFile}
          onSaveFileAs={saveFileAs}
          onOpenDownloadDirectory={openDownloadDirectory}
          onStreamFile={streamFile}
          onSuspendFileStream={suspendFileStream}
          onRetryMessage={retryMessage}
          onSendFile={sendFile}
          onSendFiles={sendFiles}
          onCancelFileUpload={cancelFileUpload}
          onLoadOlder={() => activeChatId ? loadMoreHistory(activeChatId) : Promise.resolve()}
          onOpenProfile={() => { if (activeChatId) void loadChatProfile(activeChatId); }}
          onPositioned={finishConversationSnapshot}
          onOpenMessage={(chatId, messageId) => { void openGlobalSearchMessage(chatId, messageId); }}
          onOpenSenderProfile={(senderId) => {
            if (senderId.startsWith("chat:")) void loadChatProfile(senderId.slice("chat:".length));
            else void loadUserProfile(senderId);
          }}
          onSetChatPinned={(pinned) => activeChatId
            ? setChatPinned(
                activeChat?.folderIds.includes(chatFilter)
                  ? chatFilter
                  : activeChat?.folderIds.includes("archive") ? "archive" : "main",
                activeChatId,
                pinned,
              )
            : Promise.resolve(false)}
          onSetChatMuted={(muted) => activeChatId
            ? setChatMuted(activeChatId, muted)
            : Promise.resolve(false)}
          onSetChatArchived={(archived) => activeChatId
            ? setChatArchived(activeChatId, archived)
            : Promise.resolve(false)}
          onBack={() => setMobileChatOpen(false)}
            />
          </Profiler>
      </main>
      {error && (
        <div className="runtime-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭" onClick={clearError}><X size={16} /></button>
        </div>
      )}
      {operationError && (
        <div className="operation-error" role="alert">
          <CircleAlert size={17} />
          <span>{operationError}</span>
          <button type="button" aria-label="关闭操作提示" title="关闭" onClick={clearOperationError}><X size={16} /></button>
        </div>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {folderManagerOpen && (
        <FolderManagerDialog
          folders={folders}
          chats={[...chats.values()]}
          initialFolderId={folderManagerInitialId}
          pending={folderManagementPending}
          onCreate={createChatFolder}
          onRename={renameChatFolder}
          onDelete={deleteChatFolder}
          onSetMembership={setChatFolderMembership}
          onClose={closeFolderManager}
        />
      )}
      {pendingConfirmation && (
        <ConfirmActionDialog
          title={pendingConfirmation.kind === "leaveGroup"
            ? `退出“${pendingConfirmation.title}”？`
            : `删除“${pendingConfirmation.title}”？`}
          description={pendingConfirmation.kind === "leaveGroup"
            ? "退出后，您将无法继续在这个群组中收发消息。"
            : "只会删除文件夹，不会删除其中的聊天。"}
          confirmLabel={pendingConfirmation.kind === "leaveGroup" ? "退出群组" : "删除"}
          onConfirm={() => pendingConfirmation.kind === "leaveGroup"
            ? leaveGroup(pendingConfirmation.chatId)
            : deleteChatFolder(pendingConfirmation.folderId)}
          onClose={() => setPendingConfirmation(undefined)}
        />
      )}
      {profile.target && (
        <ProfileDrawer
          state={profile}
          messages={profile.value?.chatId ? messages.get(profile.value.chatId) ?? [] : []}
          currentUserId={currentUserId}
          onClose={clearProfile}
          onRetry={() => {
            if (profile.target?.kind === "current") void loadCurrentUserProfile();
            else if (profile.target?.kind === "chat") void loadChatProfile(profile.target.chatId);
            else if (profile.target?.kind === "user") void loadUserProfile(profile.target.userId);
          }}
          onOpenMessage={openProfileMessage}
          onStartPrivateChat={openProfilePrivateChat}
          onOpenUserProfile={(userId) => { void loadUserProfile(userId); }}
        />
      )}
    </>
  );
}
