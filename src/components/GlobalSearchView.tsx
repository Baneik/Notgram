import {
  Check,
  ChevronDown,
  FileText,
  Image,
  Link,
  LoaderCircle,
  MessageSquare,
  Search,
  Users,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { GlobalSearchState } from "../store/globalSearchState";
import { messageContentText } from "../telegram/messageContent";
import type { Chat, GlobalSearchFilter, Message } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";
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

function ChatSearchSenderPicker({
  senderId,
  options,
  onChange,
}: {
  senderId?: string;
  options: SidebarSearchSenderOption[];
  onChange: (senderId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const selectedLabel = options.find((option) => option.id === senderId)?.label ?? (
    senderId ? "已选成员" : "所有成员"
  );
  const normalizedMemberQuery = memberQuery.trim().toLocaleLowerCase();
  const visibleOptions = normalizedMemberQuery
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedMemberQuery))
    : options;

  useEffect(() => {
    if (!open) return;
    const focusTimer = globalThis.setTimeout(() => searchRef.current?.focus(), 0);
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && pickerRef.current?.contains(target)) return;
      setOpen(false);
      setMemberQuery("");
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setMemberQuery("");
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      globalThis.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [open]);

  const closePicker = (restoreFocus = false) => {
    setOpen(false);
    setMemberQuery("");
    if (restoreFocus) globalThis.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const selectSender = (nextSenderId?: string) => {
    closePicker();
    onChange(nextSenderId);
  };

  return (
    <div className="chat-search-member-picker" ref={pickerRef}>
      <div className="chat-search-member-control">
        <button
          ref={triggerRef}
          className="chat-search-member-trigger"
          type="button"
          aria-label={`成员筛选：${selectedLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popupId : undefined}
          onClick={() => {
            setOpen((current) => !current);
            if (open) setMemberQuery("");
          }}
        >
          <Users size={15} strokeWidth={1.8} />
          <span>{selectedLabel}</span>
          <ChevronDown size={14} strokeWidth={1.8} />
        </button>
        {senderId && (
          <button
            className="chat-search-member-clear"
            type="button"
            aria-label="清除成员筛选"
            title="清除成员筛选"
            onClick={() => selectSender(undefined)}
          >
            <X size={15} />
          </button>
        )}
      </div>
      {open && (
        <div id={popupId} className="chat-search-member-popup" role="dialog" aria-label="选择成员">
          <label className="chat-search-member-field">
            <Search size={14} strokeWidth={1.8} />
            <span className="sr-only">搜索成员</span>
            <input
              ref={searchRef}
              type="search"
              value={memberQuery}
              placeholder="搜索成员"
              aria-label="搜索成员"
              onChange={(event) => setMemberQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                focusFirstMenuButton(optionsRef.current);
              }}
            />
            {memberQuery && (
              <button type="button" aria-label="清除成员搜索" title="清除成员搜索" onClick={() => setMemberQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
          <div
            ref={optionsRef}
            className="chat-search-member-options"
            aria-label="成员列表"
            onKeyDown={(event) => handleMenuKeyboard(event, () => closePicker(true))}
          >
            {!normalizedMemberQuery && (
              <button type="button" aria-pressed={!senderId} onClick={() => selectSender(undefined)}>
                <span>所有成员</span>
                {!senderId && <Check size={14} />}
              </button>
            )}
            {visibleOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.id === senderId}
                onClick={() => selectSender(option.id)}
              >
                <span>{option.label}</span>
                {option.id === senderId && <Check size={14} />}
              </button>
            ))}
            {visibleOptions.length === 0 && (
              <div className="chat-search-member-empty" role="status">没有匹配的成员</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export interface ChatSearchResultsProps {
  chat: Chat;
  query: string;
  senderId?: string;
  senderOptions: SidebarSearchSenderOption[];
  state: ChatMessageSearchState;
  stateMatchesInput: boolean;
  onSenderChange: (senderId: string | undefined) => void;
  onLoadMore: () => Promise<void>;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

export function ChatSearchResults({
  chat,
  query,
  senderId,
  senderOptions,
  state,
  stateMatchesInput,
  onSenderChange,
  onLoadMore,
  onOpenMessage,
}: ChatSearchResultsProps) {
  const total = state.totalCount ?? state.messages.length;
  return (
    <section className="global-search-results-panel chat-search-results-panel" aria-label={`搜索${chat.title}中的消息`}>
      <div className="global-search-controls chat-search-controls">
        <ChatSearchSenderPicker senderId={senderId} options={senderOptions} onChange={onSenderChange} />
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
        {stateMatchesInput && !state.loading && !state.error && query.trim() === "" && !senderId && (
          <div className="global-search-state"><span>输入关键词搜索此会话</span></div>
        )}
        {stateMatchesInput && !state.loading && !state.error && state.messages.length === 0 && (query.trim() || senderId) && (
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
    if (!normalizedQuery || current) return;
    const timer = globalThis.setTimeout(() => {
      void onSearch(normalizedQuery, filter);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [current, filter, normalizedQuery, onSearch]);

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
