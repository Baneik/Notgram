import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChatSidebar } from "../components/ChatSidebar";
import { Conversation } from "../components/Conversation";
import { NavigationRail } from "../components/NavigationRail";
import { AuthorizationScreen } from "../components/AuthorizationScreen";
import { SettingsDialog } from "../components/SettingsDialog";
import { filterAndSortChats, useTelegramStore } from "../store/telegramStore";
import { usePreferencesStore } from "../store/preferencesStore";
import { messageContentText } from "../telegram/messageContent";
import { connectionPresentation } from "../telegram/connectionState";

const DEFAULT_SIDEBAR_WIDTH = 360;
const SIDEBAR_WIDTH_STORAGE_KEY = "notgram.sidebar-width";

const readSidebarWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 300 ? stored : DEFAULT_SIDEBAR_WIDTH;
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
  const drafts = useTelegramStore((state) => state.drafts);
  const outbox = useTelegramStore((state) => state.outbox);
  const histories = useTelegramStore((state) => state.histories);
  const transportLabel = useTelegramStore((state) => state.transportLabel);
  const transportKind = useTelegramStore((state) => state.transportKind);
  const connectionStatus = useTelegramStore((state) => state.connectionStatus);
  const authorization = useTelegramStore((state) => state.authorization);
  const authorizationPending = useTelegramStore((state) => state.authorizationPending);
  const authorizationError = useTelegramStore((state) => state.authorizationError);
  const initialize = useTelegramStore((state) => state.initialize);
  const selectChat = useTelegramStore((state) => state.selectChat);
  const loadMoreChats = useTelegramStore((state) => state.loadMoreChats);
  const reorderPinnedChats = useTelegramStore((state) => state.reorderPinnedChats);
  const markActiveChatRead = useTelegramStore((state) => state.markActiveChatRead);
  const setSearchQuery = useTelegramStore((state) => state.setSearchQuery);
  const setChatFilter = useTelegramStore((state) => state.setChatFilter);
  const sendMessage = useTelegramStore((state) => state.sendMessage);
  const editMessage = useTelegramStore((state) => state.editMessage);
  const deleteMessage = useTelegramStore((state) => state.deleteMessage);
  const updateChatDraft = useTelegramStore((state) => state.updateChatDraft);
  const forwardMessages = useTelegramStore((state) => state.forwardMessages);
  const loadMessageProperties = useTelegramStore((state) => state.loadMessageProperties);
  const setMessageReaction = useTelegramStore((state) => state.setMessageReaction);
  const searchChatMessages = useTelegramStore((state) => state.searchChatMessages);
  const downloadFile = useTelegramStore((state) => state.downloadFile);
  const streamFile = useTelegramStore((state) => state.streamFile);
  const retryMessage = useTelegramStore((state) => state.retryMessage);
  const sendFile = useTelegramStore((state) => state.sendFile);
  const cancelFileUpload = useTelegramStore((state) => state.cancelFileUpload);
  const loadMoreHistory = useTelegramStore((state) => state.loadMoreHistory);
  const clearError = useTelegramStore((state) => state.clearError);
  const clearOperationError = useTelegramStore((state) => state.clearOperationError);
  const authenticate = useTelegramStore((state) => state.authenticate);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [latestScrollRequest, setLatestScrollRequest] = useState<{
    chatId: string;
    requestId: number;
  }>();
  const latestScrollRequestIdRef = useRef(0);
  const notificationsEnabled = usePreferencesStore((state) => state.notificationsEnabled);
  const notificationSound = usePreferencesStore((state) => state.notificationSound);
  const knownLatestMessagesRef = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    void initialize();
  }, [initialize]);

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
      if (
        message.outgoing ||
        !notificationsEnabled ||
        (message.chatId === activeChatId && document.visibilityState === "visible")
      ) {
        continue;
      }
      const chat = chats.get(message.chatId);
      const body = messageContentText(message.content);
      if ("Notification" in globalThis && Notification.permission === "granted") {
        try {
          new Notification(chat?.title ?? "Notgram", { body });
        } catch {
          // The native WebView may deny notifications despite a browser permission result.
        }
      }
      if (notificationSound) {
        try {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = 660;
          gain.gain.setValueAtTime(0.035, context.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start();
          oscillator.stop(context.currentTime + 0.12);
          oscillator.addEventListener("ended", () => void context.close(), { once: true });
        } catch {
          // Audio can be blocked until the user has interacted with the window.
        }
      }
    }
  }, [activeChatId, chats, messages, notificationSound, notificationsEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // A blocked preference store should not affect the messaging UI.
    }
  }, [sidebarWidth]);

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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </>
    );
  }

  const activeChat = activeChatId ? chats.get(activeChatId) : undefined;
  const activeMessages = activeChatId ? messages.get(activeChatId) ?? [] : [];
  const activeHistory = activeChatId
    ? histories.get(activeChatId) ?? { loading: false, hasMore: true }
    : { loading: false, hasMore: false };
  const activeChatList = chatLists.get(chatFilter) ?? { loading: false, hasMore: true };

  return (
    <>
      <main
        className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}
        style={{ "--chat-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <NavigationRail folders={folders} filter={chatFilter} onFilterChange={setChatFilter} transportLabel={transportLabel} connectionStatus={connectionStatus} onOpenSettings={() => setSettingsOpen(true)} />
        <ChatSidebar
          chats={visibleChats}
          drafts={drafts}
          activeChatId={activeChatId}
          folderId={chatFilter}
          folderTitle={folders.find((folder) => folder.id === chatFilter)?.title ?? "聊天"}
          connectionStatus={connectionStatus}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelect={(chatId) => { void selectChat(chatId); setMobileChatOpen(true); }}
          onOpenLatest={(chatId) => {
            setMobileChatOpen(true);
            void selectChat(chatId).finally(() => {
              latestScrollRequestIdRef.current += 1;
              setLatestScrollRequest({
                chatId,
                requestId: latestScrollRequestIdRef.current,
              });
            });
          }}
          loadingMore={activeChatList.loading}
          hasMore={activeChatList.hasMore}
          onLoadMore={() => loadMoreChats(chatFilter)}
          onReorderPinned={(chatIds) => { void reorderPinnedChats(chatFilter, chatIds); }}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
        />
        <Conversation
          chat={activeChat}
          scrollScope={activeAccountId}
          latestScrollRequest={latestScrollRequest}
          messages={activeMessages}
          chatDraft={activeChatId ? drafts.get(activeChatId) : undefined}
          forwardTargets={forwardTargets}
          users={users}
          historyLoading={activeHistory.loading}
          hasOlderMessages={activeHistory.hasMore}
          transportKind={transportKind}
          connectionStatus={connectionStatus}
          queuedMessageCount={activeOutbox.filter((item) => item.status === "queued").length}
          failedQueuedMessageCount={activeOutbox.filter((item) => item.status === "failed").length}
          onSendMessage={sendMessage}
          onEditMessage={editMessage}
          onDeleteMessage={deleteMessage}
          onDraftChange={updateChatDraft}
          onForwardMessages={forwardMessages}
          onLoadMessageProperties={loadMessageProperties}
          onSetMessageReaction={setMessageReaction}
          onSearchMessages={searchChatMessages}
          onDownloadFile={downloadFile}
          onStreamFile={streamFile}
          onRetryMessage={retryMessage}
          onSendFile={sendFile}
          onCancelFileUpload={cancelFileUpload}
          onLoadOlder={() => activeChatId ? loadMoreHistory(activeChatId) : Promise.resolve()}
          onBack={() => setMobileChatOpen(false)}
        />
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
    </>
  );
}
