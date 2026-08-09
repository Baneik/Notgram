import {
  Calendar,
  FileText,
  Image,
  Link,
  LoaderCircle,
  MessageSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatMessageSearchFilter } from "../telegram/types";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { GlobalSearchState } from "../store/globalSearchState";
import { messageContentText } from "../telegram/messageContent";
import { chatMessageSearchFilterDisallowsQueryOrSender } from "../telegram/messageSearch";
import type { Chat, GlobalSearchFilter, Message } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { Avatar } from "./Avatar";

interface GlobalSearchResultsProps {
  query: string;
  state: GlobalSearchState;
  knownChats: Map<string, Chat>;
  onSearch: (query: string, filter: GlobalSearchFilter) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onCancel: () => void;
  onOpenChat: (chatId: string) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

const filters: Array<{ id: GlobalSearchFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "message", label: "消息" },
  { id: "media", label: "媒体" },
  { id: "file", label: "文件" },
  { id: "link", label: "链接" },
];

export interface SidebarSearchSenderOption {
  id: string;
  label: string;
}

const chatMessageFilters: Array<{ id: ChatMessageSearchFilter; label: string }> = [
  { id: "all", label: "全部类型" },
  { id: "photoAndVideo", label: "照片和视频" },
  { id: "photo", label: "照片" },
  { id: "video", label: "视频" },
  { id: "animation", label: "GIF" },
  { id: "audio", label: "音频" },
  { id: "voiceNote", label: "语音消息" },
  { id: "videoNote", label: "视频消息" },
  { id: "voiceAndVideoNote", label: "语音和视频消息" },
  { id: "document", label: "文件" },
  { id: "url", label: "链接" },
  { id: "poll", label: "投票" },
  { id: "mention", label: "提及我" },
  { id: "unreadMention", label: "未读提及" },
  { id: "unreadReaction", label: "未读回应" },
  { id: "unreadPollVote", label: "未读投票" },
  { id: "failedToSend", label: "发送失败" },
  { id: "pinned", label: "置顶消息" },
];

export interface ChatSearchResultsProps {
  chat: Chat;
  query: string;
  filter: ChatMessageSearchFilter;
  senderId?: string;
  date: string;
  senderOptions: SidebarSearchSenderOption[];
  state: ChatMessageSearchState;
  stateMatchesInput: boolean;
  onFilterChange: (filter: ChatMessageSearchFilter) => void;
  onSenderChange: (senderId: string | undefined) => void;
  onDateChange: (date: string) => void;
  onLoadMore: () => Promise<void>;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

export function ChatSearchResults({
  chat,
  query,
  filter,
  senderId,
  date,
  senderOptions,
  state,
  stateMatchesInput,
  onFilterChange,
  onSenderChange,
  onDateChange,
  onLoadMore,
  onOpenMessage,
}: ChatSearchResultsProps) {
  const filterDisablesText = chatMessageSearchFilterDisallowsQueryOrSender(filter);
  const total = state.totalCount ?? state.messages.length;
  return (
    <section className="global-search-results-panel chat-search-results-panel" aria-label={`搜索${chat.title}中的消息`}>
      <div className="global-search-controls chat-search-controls">
        <div className="message-search-options chat-search-options">
          <label>
            <span className="sr-only">消息类型</span>
            <select aria-label="消息类型" value={filter} onChange={(event) => onFilterChange(event.target.value as ChatMessageSearchFilter)}>
              {chatMessageFilters.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">消息发送者</span>
            <select aria-label="消息发送者" value={senderId ?? ""} onChange={(event) => onSenderChange(event.target.value || undefined)} disabled={filterDisablesText}>
              <option value="">所有成员</option>
              {senderOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="message-search-date">
            <Calendar size={14} strokeWidth={1.8} />
            <span className="sr-only">消息日期</span>
            <input aria-label="消息日期" type="date" value={date} onChange={(event) => onDateChange(event.target.value)} />
          </label>
          {senderId && (
            <button className="message-search-sender-clear" type="button" aria-label="清除成员筛选" title="清除成员筛选" onClick={() => onSenderChange(undefined)}>
              <X size={14} />
              <span>{senderOptions.find((option) => option.id === senderId)?.label ?? "成员"}</span>
            </button>
          )}
        </div>
      </div>
      <div className="global-search-results" aria-live="polite">
        {stateMatchesInput && state.messages.length > 0 && (
          <section className="global-result-section" aria-labelledby="chat-message-results">
            <h2 id="chat-message-results">{chat.title}中的消息<span>{total}</span></h2>
            <div className="global-message-results">
              {state.messages.map((message) => (
                <MessageSearchResult
                  key={`${message.chatId}:${message.id}`}
                  message={message}
                  chat={chat}
                  onOpen={() => onOpenMessage(message.chatId, message.id)}
                />
              ))}
            </div>
          </section>
        )}
        {state.error && stateMatchesInput && (
          <div className="global-search-state is-error" role="alert">{state.error}</div>
        )}
        {(!stateMatchesInput || (state.loading && state.messages.length === 0)) && (
          <div className="global-search-state" role="status" aria-label="正在搜索"><LoaderCircle className="spin" size={21} /></div>
        )}
        {stateMatchesInput && !state.loading && !state.error && query.trim() === "" && filter === "all" && !senderId && !date && (
          <div className="global-search-state"><span>输入关键词搜索此会话</span></div>
        )}
        {stateMatchesInput && !state.loading && !state.error && state.messages.length === 0 && (query.trim() || filter !== "all" || senderId || date) && (
          <div className="global-search-state"><span>没有搜索结果</span></div>
        )}
        {stateMatchesInput && state.nextFromMessageId && (
          <button className="global-search-more" type="button" disabled={state.loadingMore} onClick={() => void onLoadMore()}>
            {state.loadingMore && <LoaderCircle className="spin" size={16} />}
            <span>加载更多</span>
          </button>
        )}
      </div>
    </section>
  );
}

export function GlobalSearchResults({
  query,
  state,
  knownChats,
  onSearch,
  onLoadMore,
  onCancel,
  onOpenChat,
  onOpenMessage,
}: GlobalSearchResultsProps) {
  const [filter, setFilter] = useState<GlobalSearchFilter>(state.filter);
  const normalizedQuery = query.trim();
  const current = state.query === normalizedQuery && state.filter === filter;
  const chats = current ? state.chats : [];
  const messages = current ? state.messages : [];
  const matchingChats = filter === "all"
    ? [...new Map([
        ...knownChats,
        ...chats.map((chat) => [chat.id, chat] as const),
      ]).values()].filter((chat) =>
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
    if (!normalizedQuery) return;
    const timer = globalThis.setTimeout(() => {
      void onSearch(normalizedQuery, filter);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [filter, normalizedQuery, onSearch]);

  useEffect(() => () => onCancel(), [onCancel]);

  const updateFilter = (value: GlobalSearchFilter) => {
    if (value === filter) return;
    onCancel();
    setFilter(value);
  };

  return (
    <section
      className="global-search-results-panel"
      aria-label="搜索结果"
    >
      <div className="global-search-controls">
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
        {!current && (
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
