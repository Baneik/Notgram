import { CircleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ChatSidebar } from "../components/ChatSidebar";
import { Conversation } from "../components/Conversation";
import { NavigationRail } from "../components/NavigationRail";
import { AuthorizationScreen } from "../components/AuthorizationScreen";
import { ProxySettingsDialog } from "../components/ProxySettingsDialog";
import { filterAndSortChats, useTelegramStore } from "../store/telegramStore";

export function App() {
  const phase = useTelegramStore((state) => state.phase);
  const error = useTelegramStore((state) => state.error);
  const chatFilter = useTelegramStore((state) => state.chatFilter);
  const searchQuery = useTelegramStore((state) => state.searchQuery);
  const activeChatId = useTelegramStore((state) => state.activeChatId);
  const chats = useTelegramStore((state) => state.chats);
  const folders = useTelegramStore((state) => state.folders);
  const users = useTelegramStore((state) => state.users);
  const messages = useTelegramStore((state) => state.messages);
  const histories = useTelegramStore((state) => state.histories);
  const transportLabel = useTelegramStore((state) => state.transportLabel);
  const authorization = useTelegramStore((state) => state.authorization);
  const authorizationPending = useTelegramStore((state) => state.authorizationPending);
  const authorizationError = useTelegramStore((state) => state.authorizationError);
  const initialize = useTelegramStore((state) => state.initialize);
  const selectChat = useTelegramStore((state) => state.selectChat);
  const setSearchQuery = useTelegramStore((state) => state.setSearchQuery);
  const setChatFilter = useTelegramStore((state) => state.setChatFilter);
  const sendMessage = useTelegramStore((state) => state.sendMessage);
  const downloadFile = useTelegramStore((state) => state.downloadFile);
  const retryMessage = useTelegramStore((state) => state.retryMessage);
  const sendFile = useTelegramStore((state) => state.sendFile);
  const loadMoreHistory = useTelegramStore((state) => state.loadMoreHistory);
  const clearError = useTelegramStore((state) => state.clearError);
  const authenticate = useTelegramStore((state) => state.authenticate);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const visibleChats = useMemo(
    () => filterAndSortChats(chats.values(), chatFilter, searchQuery),
    [chatFilter, chats, searchQuery],
  );

  if (authorization.kind !== "ready" && authorization.kind !== "preparing") {
    return (
      <>
      <AuthorizationScreen
        state={authorization}
        pending={authorizationPending}
        error={authorizationError}
        onSubmit={authenticate}
        onOpenProxy={() => setProxyOpen(true)}
      />
      {proxyOpen && <ProxySettingsDialog onClose={() => setProxyOpen(false)} />}
      </>
    );
  }

  const activeChat = activeChatId ? chats.get(activeChatId) : undefined;
  const activeMessages = activeChatId ? messages.get(activeChatId) ?? [] : [];
  const activeHistory = activeChatId
    ? histories.get(activeChatId) ?? { loading: false, hasMore: true }
    : { loading: false, hasMore: false };

  return (
    <>
      <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}>
        <NavigationRail folders={folders} filter={chatFilter} onFilterChange={setChatFilter} transportLabel={`${transportLabel}${phase === "idle" || phase === "loading" ? " · 同步中" : ""}`} onOpenProxy={() => setProxyOpen(true)} />
        <ChatSidebar
          chats={visibleChats}
          activeChatId={activeChatId}
          folderTitle={folders.find((folder) => folder.id === chatFilter)?.title ?? "聊天"}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelect={(chatId) => { void selectChat(chatId); setMobileChatOpen(true); }}
        />
        <Conversation
          chat={activeChat}
          messages={activeMessages}
          users={users}
          historyLoading={activeHistory.loading}
          hasOlderMessages={activeHistory.hasMore}
          onSendMessage={sendMessage}
          onDownloadFile={downloadFile}
          onRetryMessage={retryMessage}
          onSendFile={sendFile}
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
      {proxyOpen && <ProxySettingsDialog onClose={() => setProxyOpen(false)} />}
    </>
  );
}
