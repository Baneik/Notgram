import { translate } from "../i18n";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Search,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { GlobalSearchState } from "../store/globalSearchState";
import { messageContentText } from "../telegram/messageContent";
import type { Chat, GlobalSearchFilter, Message, User } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { Avatar } from "./Avatar";
import { MotionPresence } from "./MotionPresence";
import { messageSearchSender, messageSearchSource } from "./searchMessagePresentation";
import { useTelegramStore } from "../store/telegramStore";
import { useLocalHiddenUserIds } from "../store/localUserBlocks";
import { isLocalHiddenMessage } from "../utils/localBlockedMessages";

interface GlobalSearchResultsProps {
  query: string;
  state: GlobalSearchState;
  knownChats: Map<string, Chat>;
  knownUsers: Map<string, User>;
  onSearch: (query: string, filter: GlobalSearchFilter) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onCancel: () => void;
  onOpenChat: (chatId: string) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

const filters: Array<{ id: GlobalSearchFilter; label: string }> = [
  { id: "all", get label() { return translate("全部"); } },
  { id: "message", get label() { return translate("消息"); } },
  { id: "media", get label() { return translate("媒体"); } },
  { id: "file", get label() { return translate("文件"); } },
  { id: "link", get label() { return translate("链接"); } },
];

export interface SidebarSearchSenderOption {
  id: string;
  label: string;
}

function SearchPagination({
  nextCursor,
  loading,
  error,
  onLoadMore,
}: {
  nextCursor?: string;
  loading: boolean;
  error?: string;
  onLoadMore: () => Promise<void>;
}) {
  const [sentinelRef, nearEnd] = useElementVisibility<HTMLDivElement>("0px 0px 96px 0px", ".global-search-results");
  const sentinelElement = useRef<HTMLDivElement | null>(null);
  const paginationRef = useCallback((element: HTMLDivElement | null) => {
    sentinelElement.current = element;
    return sentinelRef(element);
  }, [sentinelRef]);
  const requestedCursor = useRef<string | undefined>(undefined);
  const showLoading = useStableVisibility(loading, { minimumVisible: 220 });

  useEffect(() => {
    if (!nearEnd || !nextCursor || loading || error || requestedCursor.current === nextCursor) return;
    const list = sentinelElement.current?.closest(".global-search-results");
    // Intersection callbacks can lag behind appended rows; check the current scroll geometry.
    if (!list || list.scrollHeight - list.clientHeight - list.scrollTop > 96) return;
    // A repeated cursor must not create an automatic request loop; failures use explicit retry.
    requestedCursor.current = nextCursor;
    void onLoadMore();
  }, [error, loading, nearEnd, nextCursor, onLoadMore]);

  const showError = Boolean(error && nextCursor);
  return (
    <div ref={paginationRef} className="global-search-pagination">
      <MotionPresence present={showLoading || showError} variant="status">
        {showError ? (
          <div className="global-search-pagination-error" role="alert">
            <span>{error}</span>
            <button className="dialog-secondary" type="button" onClick={() => void onLoadMore()}>{translate("重试")}</button>
          </div>
        ) : showLoading ? (
          <div className="global-search-pagination-loading" role="status" aria-label={translate("正在加载")}>
            <LoaderCircle className="spin" size={18} />
          </div>
        ) : null}
      </MotionPresence>
    </div>
  );
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
    senderId ? translate("已选成员") : translate("所有成员")
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
          aria-label={translate("成员筛选：{{value0}}", { value0: selectedLabel })}
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
            aria-label={translate("清除成员筛选")}
            title={translate("清除成员筛选")}
            onClick={() => selectSender(undefined)}
          >
            <X size={15} />
          </button>
        )}
      </div>
      <MotionPresence present={open} variant="popover">
        {open ? <div id={popupId} className="chat-search-member-popup" role="dialog" aria-label={translate("选择成员")}>
          <label className="chat-search-member-field">
            <Search size={14} strokeWidth={1.8} />
            <span className="sr-only">{translate("搜索成员")}</span>
            <input
              ref={searchRef}
              type="search"
              value={memberQuery}
              placeholder={translate("搜索成员")}
              aria-label={translate("搜索成员")}
              onChange={(event) => setMemberQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                focusFirstMenuButton(optionsRef.current);
              }}
            />
            {memberQuery && (
              <button type="button" aria-label={translate("清除成员搜索")} title={translate("清除成员搜索")} onClick={() => setMemberQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
          <div
            ref={optionsRef}
            className="chat-search-member-options"
            aria-label={translate("成员列表")}
            onKeyDown={(event) => handleMenuKeyboard(event, () => closePicker(true))}
          >
            {!normalizedMemberQuery && (
              <button type="button" aria-pressed={!senderId} onClick={() => selectSender(undefined)}>
                <span>{translate("所有成员")}</span>
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
              <div className="chat-search-member-empty" role="status">{translate("没有匹配的成员")}</div>
            )}
          </div>
        </div> : null}
      </MotionPresence>
    </div>
  );
}

export interface ChatSearchResultsProps {
  chat: Chat;
  query: string;
  senderId?: string;
  senderOptions: SidebarSearchSenderOption[];
  knownChats: Map<string, Chat>;
  knownUsers: Map<string, User>;
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
  knownChats,
  knownUsers,
  state,
  stateMatchesInput,
  onSenderChange,
  onLoadMore,
  onOpenMessage,
}: ChatSearchResultsProps) {
  const accountId = useTelegramStore(state => state.activeAccountId);
  const hiddenUserIds = useLocalHiddenUserIds(accountId);
  const messages = state.messages.filter(message => !isLocalHiddenMessage(message, hiddenUserIds));
  const total = hiddenUserIds.size > 0 ? messages.length : state.totalCount ?? messages.length;
  const primaryLoading = !stateMatchesInput || (state.loading && state.messages.length === 0);
  const showLoading = useStableVisibility(primaryLoading);
  const prompt = stateMatchesInput && !state.loading && !state.error && query.trim() === "" && !senderId;
  const empty = stateMatchesInput && !state.loading && !state.error && messages.length === 0 && Boolean(query.trim() || senderId);
  const statusKind = showLoading ? "loading" : state.error && stateMatchesInput && !state.nextFromMessageId
    ? "error"
    : prompt ? "prompt" : empty ? "empty" : undefined;
  return (
    <section className="global-search-results-panel chat-search-results-panel" aria-label={translate("搜索{{value0}}中的消息", { value0: chat.title })}>
      <div className="global-search-controls chat-search-controls">
        <ChatSearchSenderPicker senderId={senderId} options={senderOptions} onChange={onSenderChange} />
      </div>
      <div className="global-search-results" aria-live="polite" aria-busy={primaryLoading || state.loadingMore} data-search-state={primaryLoading ? "updating" : "settled"}>
        {stateMatchesInput && !showLoading && messages.length > 0 && (
          <section className="global-result-section" aria-labelledby="chat-message-results">
            <h2 id="chat-message-results">{translate("{{value0}} 中的消息", { value0: chat.title })}<span>{total}</span></h2>
            <div className="global-message-results">
              {messages.map((message) => (
                <MessageSearchResult
                  key={`${message.chatId}:${message.id}`}
                  message={message}
                  chat={chat}
                  knownChats={knownChats}
                  knownUsers={knownUsers}
                  scope="chat"
                  onOpen={() => onOpenMessage(message.chatId, message.id)}
                />
              ))}
            </div>
          </section>
        )}
        <MotionPresence present={Boolean(statusKind)} variant="status">
          {statusKind ? (
            <div key={statusKind} className={`global-search-state ${statusKind === "error" ? "is-error" : ""}`.trim()} role={statusKind === "error" ? "alert" : "status"} aria-label={statusKind === "loading" ? translate("正在搜索") : undefined}>
              {statusKind === "loading" ? <LoaderCircle className="spin" size={21} />
                : statusKind === "error" ? state.error
                  : <span>{statusKind === "prompt" ? translate("输入关键词搜索此会话") : translate("没有搜索结果")}</span>}
            </div>
          ) : null}
        </MotionPresence>
        {stateMatchesInput && !showLoading && state.nextFromMessageId && (
          <SearchPagination
            key={JSON.stringify([accountId, chat.id, query.trim(), senderId])}
            nextCursor={state.nextFromMessageId}
            loading={state.loadingMore}
            error={state.error}
            onLoadMore={onLoadMore}
          />
        )}
      </div>
    </section>
  );
}

export function GlobalSearchResults({
  query,
  state,
  knownChats,
  knownUsers,
  onSearch,
  onLoadMore,
  onCancel,
  onOpenChat,
  onOpenMessage,
}: GlobalSearchResultsProps) {
  const accountId = useTelegramStore(state => state.activeAccountId);
  const hiddenUserIds = useLocalHiddenUserIds(accountId);
  const [filter, setFilter] = useState<GlobalSearchFilter>(state.filter);
  const normalizedQuery = query.trim();
  const current = state.query === normalizedQuery && state.filter === filter;
  const chats = current ? state.chats : [];
  const messages = current ? state.messages.filter(message => !isLocalHiddenMessage(message, hiddenUserIds)) : [];
  const chatPreview = (chat: Chat) => chat.previewSenderId && hiddenUserIds.has(chat.previewSenderId)
    ? "" : chat.preview;
  const matchingChats = filter === "all"
    ? [...new Map([
        ...knownChats,
        ...chats.map((chat) => [chat.id, chat] as const),
      ]).values()].filter((chat) =>
      `${chat.title} ${chatPreview(chat)}`.toLocaleLowerCase().includes(
        normalizedQuery.toLocaleLowerCase(),
      )
    )
    : [];
  const chatById = useMemo(() => new Map([
    ...knownChats,
    ...chats.map((chat) => [chat.id, chat] as const),
  ]), [chats, knownChats]);
  const primaryLoading = (!current || (state.loading && !state.nextOffset)) && messages.length === 0 && matchingChats.length === 0;
  const showLoading = useStableVisibility(primaryLoading);
  const empty = current && !state.loading && !state.error && Boolean(normalizedQuery) && matchingChats.length === 0 && messages.length === 0;
  const statusKind = showLoading ? "loading" : current && state.error && !state.nextOffset ? "error" : empty ? "empty" : undefined;

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
      aria-label={translate("搜索结果")}
    >
      <div className="global-search-controls">
        <div className="global-search-filters" role="tablist" aria-label={translate("搜索类型")}>
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
      <div className="global-search-results" aria-live="polite" aria-busy={primaryLoading || (current && state.loading)} data-search-state={primaryLoading ? "updating" : "settled"}>
        {!showLoading && matchingChats.length > 0 && (
          <section className="global-result-section" aria-labelledby="global-chat-results">
            <h2 id="global-chat-results">{translate("聊天")}</h2>
            <div className="global-chat-results">
              {matchingChats.map((chat) => (
                <button className="global-chat-result" type="button" key={chat.id} onClick={() => onOpenChat(chat.id)}>
                  <Avatar avatar={chat.avatar} />
                  <span>
                    <strong>{chat.title}</strong>
                    <small>{chatPreview(chat)}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {current && !showLoading && messages.length > 0 && (
          <section className="global-result-section" aria-labelledby="global-message-results">
            <h2 id="global-message-results">{translate("消息")}<span>{hiddenUserIds.size === 0 && state.totalCount > messages.length ? state.totalCount : messages.length}</span>
            </h2>
            <div className="global-message-results">
              {messages.map((message) => (
                <MessageSearchResult
                  key={`${message.chatId}:${message.id}`}
                  message={message}
                  chat={chatById.get(message.chatId)}
                  knownChats={chatById}
                  knownUsers={knownUsers}
                  scope="global"
                  onOpen={() => onOpenMessage(message.chatId, message.id)}
                />
              ))}
            </div>
          </section>
        )}
        <MotionPresence present={Boolean(statusKind)} variant="status">
          {statusKind ? (
            <div key={statusKind} className={`global-search-state ${statusKind === "error" ? "is-error" : ""}`.trim()} role={statusKind === "error" ? "alert" : "status"} aria-label={statusKind === "loading" ? translate("正在搜索") : undefined}>
              {statusKind === "loading" ? <LoaderCircle className="spin" size={21} /> : statusKind === "error" ? (
                <><span>{state.error}</span><button className="dialog-secondary" type="button" onClick={() => void onSearch(normalizedQuery, filter)}>{translate("重试")}</button></>
              ) : <span>{translate("没有搜索结果")}</span>}
            </div>
          ) : null}
        </MotionPresence>
        {current && !showLoading && state.nextOffset && (
          <SearchPagination
            key={JSON.stringify([accountId, normalizedQuery, filter])}
            nextCursor={state.nextOffset}
            loading={state.loading}
            error={state.error}
            onLoadMore={onLoadMore}
          />
        )}
      </div>
    </section>
  );
}

function MessageSearchResult({
  message,
  chat,
  knownChats,
  knownUsers,
  scope,
  onOpen,
}: {
  message: Message;
  chat?: Chat;
  knownChats: Map<string, Chat>;
  knownUsers: Map<string, User>;
  scope: "chat" | "global";
  onOpen: () => void;
}) {
  const content = message.content;
  const sender = messageSearchSender(message, knownUsers, knownChats);
  const primary = scope === "chat" ? sender : messageSearchSource(chat, sender);
  return (
    <button
      className="global-message-result"
      type="button"
      data-search-message-id={message.id}
      onClick={onOpen}
    >
      <Avatar avatar={primary.avatar} size="small" />
      <span className="global-message-result-copy">
        <span>
          <strong>{primary.name}</strong>
          <time dateTime={message.sentAt}>{formatChatTime(message.sentAt)}</time>
        </span>
        <small>
          {scope === "global" && <span className="global-message-result-sender">{sender.name}：</span>}
          <span>{messageContentText(content)}</span>
        </small>
      </span>
    </button>
  );
}
