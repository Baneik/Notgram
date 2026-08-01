import { CircleAlert, LoaderCircle } from "lucide-react";
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
  const users = useTelegramStore((state) => state.users);
  const messages = useTelegramStore((state) => state.messages);
  const transportLabel = useTelegramStore((state) => state.transportLabel);
  const authorization = useTelegramStore((state) => state.authorization);
  const authorizationPending = useTelegramStore((state) => state.authorizationPending);
  const authorizationError = useTelegramStore((state) => state.authorizationError);
  const initialize = useTelegramStore((state) => state.initialize);
  const selectChat = useTelegramStore((state) => state.selectChat);
  const setSearchQuery = useTelegramStore((state) => state.setSearchQuery);
  const setChatFilter = useTelegramStore((state) => state.setChatFilter);
  const sendMessage = useTelegramStore((state) => state.sendMessage);
  const sendFile = useTelegramStore((state) => state.sendFile);
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

  if (phase === "loading" || phase === "idle") {
    return <div className="startup-screen"><LoaderCircle className="spin" size={24} /><span>正在连接</span></div>;
  }

  if (phase === "error") {
    return <div className="startup-screen startup-error"><CircleAlert size={24} /><span>{error ?? "无法连接"}</span></div>;
  }

  if (authorization.kind !== "ready") {
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

  return (
    <>
      <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}>
        <NavigationRail filter={chatFilter} onFilterChange={setChatFilter} transportLabel={transportLabel} onOpenProxy={() => setProxyOpen(true)} />
        <ChatSidebar
          chats={visibleChats}
          activeChatId={activeChatId}
          filter={chatFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelect={(chatId) => { void selectChat(chatId); setMobileChatOpen(true); }}
        />
        <Conversation
          chat={activeChat}
          messages={activeMessages}
          users={users}
          onSendMessage={sendMessage}
          onSendFile={sendFile}
          onBack={() => setMobileChatOpen(false)}
        />
      </main>
      {proxyOpen && <ProxySettingsDialog onClose={() => setProxyOpen(false)} />}
    </>
  );
}
