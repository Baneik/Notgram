import {
  FileText,
  Image,
  Link,
  LoaderCircle,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GlobalSearchState } from "../store/globalSearchState";
import { messageContentText } from "../telegram/messageContent";
import type { Chat, GlobalSearchFilter, Message } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { Avatar } from "./Avatar";

interface GlobalSearchViewProps {
  state: GlobalSearchState;
  knownChats: Map<string, Chat>;
  onSearch: (query: string, filter: GlobalSearchFilter) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onCancel: () => void;
  onClear: () => void;
  onOpenChat: (chatId: string) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onClose: () => void;
}

const filters: Array<{ id: GlobalSearchFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "message", label: "消息" },
  { id: "media", label: "媒体" },
  { id: "file", label: "文件" },
  { id: "link", label: "链接" },
];

export function GlobalSearchView({
  state,
  knownChats,
  onSearch,
  onLoadMore,
  onCancel,
  onClear,
  onOpenChat,
  onOpenMessage,
  onClose,
}: GlobalSearchViewProps) {
  const [query, setQuery] = useState(state.query);
  const [filter, setFilter] = useState<GlobalSearchFilter>(state.filter);
  const normalizedQuery = query.trim();
  const current = state.query === normalizedQuery && state.filter === filter;
  const chats = current ? state.chats : [];
  const messages = current ? state.messages : [];
  const matchingChats = filter === "all"
    ? chats.filter((chat) =>
      `${chat.title} ${chat.preview}`.toLocaleLowerCase().includes(
        normalizedQuery.toLocaleLowerCase(),
      )
    )
    : [];
  const chatById = useMemo(() => new Map([
    ...knownChats,
    ...chats.map((chat) => [chat.id, chat] as const),
  ]), [chats, knownChats]);

  useEffect(() => {
    if (!normalizedQuery) {
      onClear();
      return;
    }
    const timer = globalThis.setTimeout(() => {
      void onSearch(normalizedQuery, filter);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [filter, normalizedQuery, onClear, onSearch]);

  useEffect(() => () => onCancel(), [onCancel]);

  const updateQuery = (value: string) => {
    onCancel();
    setQuery(value);
  };
  const updateFilter = (value: GlobalSearchFilter) => {
    if (value === filter) return;
    onCancel();
    setFilter(value);
  };

  return (
    <section
      className="global-search-view"
      aria-labelledby="global-search-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="global-search-header">
        <h1 id="global-search-title">搜索</h1>
        <button className="icon-button" type="button" aria-label="关闭全局搜索" title="关闭" onClick={onClose}>
          <X size={19} />
        </button>
      </header>
      <div className="global-search-controls">
        <label className="global-search-field">
          <Search size={18} strokeWidth={1.8} />
          <span className="sr-only">搜索聊天和消息</span>
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="搜索聊天和消息"
            onChange={(event) => updateQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="清除全局搜索" title="清除" onClick={() => updateQuery("")}>
              <X size={16} />
            </button>
          )}
        </label>
        <div className="global-search-filters" role="tablist" aria-label="搜索类型">
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              className={filter === option.id ? "is-active" : ""}
              onClick={() => updateFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="global-search-results" aria-live="polite">
        {current && matchingChats.length > 0 && (
          <section className="global-result-section" aria-labelledby="global-chat-results">
            <h2 id="global-chat-results">聊天</h2>
            <div className="global-chat-results">
              {matchingChats.map((chat) => (
                <button className="global-chat-result" type="button" key={chat.id} onClick={() => onOpenChat(chat.id)}>
                  <Avatar avatar={chat.avatar} />
                  <span>
                    <strong>{chat.title}</strong>
                    <small>{chat.preview}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {current && messages.length > 0 && (
          <section className="global-result-section" aria-labelledby="global-message-results">
            <h2 id="global-message-results">
              消息
              <span>{state.totalCount > messages.length ? state.totalCount : messages.length}</span>
            </h2>
            <div className="global-message-results">
              {messages.map((message) => (
                <MessageSearchResult
                  key={`${message.chatId}:${message.id}`}
                  message={message}
                  chat={chatById.get(message.chatId)}
                  onOpen={() => onOpenMessage(message.chatId, message.id)}
                />
              ))}
            </div>
          </section>
        )}
        {current && state.error && (
          <div className="global-search-state is-error" role="alert">
            <span>{state.error}</span>
            <button className="dialog-secondary" type="button" onClick={() => void onSearch(normalizedQuery, filter)}>重试</button>
          </div>
        )}
        {current && state.loading && messages.length === 0 && matchingChats.length === 0 && (
          <div className="global-search-state" role="status" aria-label="正在搜索">
            <LoaderCircle className="spin" size={21} />
          </div>
        )}
        {current && !state.loading && !state.error && normalizedQuery && matchingChats.length === 0 && messages.length === 0 && (
          <div className="global-search-state"><span>没有搜索结果</span></div>
        )}
        {current && state.nextOffset && (
          <button
            className="global-search-more"
            type="button"
            disabled={state.loading}
            onClick={() => void onLoadMore()}
          >
            {state.loading && <LoaderCircle className="spin" size={16} />}
            <span>加载更多</span>
          </button>
        )}
      </div>
    </section>
  );
}

function MessageSearchResult({
  message,
  chat,
  onOpen,
}: {
  message: Message;
  chat?: Chat;
  onOpen: () => void;
}) {
  const content = message.content;
  const Icon = content.kind === "file"
    ? FileText
    : content.kind === "media"
      ? Image
      : content.kind === "text" && (
        content.entities?.some((entity) => entity.kind === "url" || entity.kind === "textUrl") ||
        /https?:\/\//i.test(content.text)
      )
        ? Link
        : MessageSquare;
  return (
    <button
      className="global-message-result"
      type="button"
      data-search-message-id={message.id}
      onClick={onOpen}
    >
      <span className="global-message-result-icon"><Icon size={18} strokeWidth={1.8} /></span>
      <span className="global-message-result-copy">
        <span>
          <strong>{chat?.title ?? "Telegram 聊天"}</strong>
          <time dateTime={message.sentAt}>{formatChatTime(message.sentAt)}</time>
        </span>
        <small>{messageContentText(content)}</small>
      </span>
    </button>
  );
}
