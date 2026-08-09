import {
  Calendar,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from "react";
import type {
  Chat,
  ChatMessageSearchFilter,
  ForumTopic,
  Message,
  User,
} from "../telegram/types";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { ConversationSearchScope } from "../hooks/useConversationSearch";
import { messageContentText } from "../telegram/messageContent";
import { formatMessageTime } from "../utils/formatters";
import { Avatar } from "./Avatar";

const filterOptions: Array<{ id: ChatMessageSearchFilter; label: string }> = [
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
  { id: "chatPhoto", label: "群头像变更" },
  { id: "mention", label: "提及我" },
  { id: "unreadMention", label: "未读提及" },
  { id: "unreadReaction", label: "未读回应" },
  { id: "unreadPollVote", label: "未读投票" },
  { id: "failedToSend", label: "发送失败" },
  { id: "pinned", label: "置顶消息" },
];

interface SenderOption {
  id: string;
  label: string;
  avatar?: User["avatar"];
}

interface ConversationSearchPanelProps {
  query: string;
  filter: ChatMessageSearchFilter;
  senderId?: string;
  date: string;
  scope: ConversationSearchScope;
  isForum: boolean;
  senderOptions: SenderOption[];
  users: Map<string, User>;
  chats: Map<string, Chat>;
  topics: ForumTopic[];
  searchState: ChatMessageSearchState;
  results: Message[];
  activeResultId?: string;
  onQueryChange: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLInputElement | null>;
  onFilterChange: (filter: ChatMessageSearchFilter) => void;
  onSenderChange: (senderId: string | undefined) => void;
  onDateChange: (date: string) => void;
  onScopeChange: (scope: ConversationSearchScope) => void;
  onNavigate: (direction: "older" | "newer") => void;
  onOpenResult: (message: Message) => void;
  onLoadMore: () => void;
  onClose: () => void;
}

const senderNameFor = (message: Message, users: Map<string, User>, chats: Map<string, Chat>) => {
  if (message.senderId === "self") return "我";
  if (message.senderId.startsWith("chat:")) return chats.get(message.senderId.slice(5))?.title ?? "群组账号";
  return users.get(message.senderId)?.displayName ?? "Telegram 用户";
};

const topicNameFor = (message: Message, topics: ForumTopic[]) =>
  message.topicId ? topics.find((topic) => topic.id === message.topicId)?.name ?? `话题 ${message.topicId}` : undefined;

const highlightSnippet = (text: string, query: string) => {
  const normalized = query.trim();
  if (!normalized) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = normalized.toLocaleLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerQuery, cursor);
    if (index < 0) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (index > cursor) parts.push({ text: text.slice(cursor, index), hit: false });
    parts.push({ text: text.slice(index, index + normalized.length), hit: true });
    cursor = index + normalized.length;
  }
  return parts.map((part, index) => part.hit
    ? <mark key={`${part.text}:${index}`}>{part.text}</mark>
    : <span key={`${part.text}:${index}`}>{part.text}</span>);
};

export function ConversationSearchPanel({
  query,
  filter,
  senderId,
  date,
  scope,
  isForum,
  senderOptions,
  users,
  chats,
  topics,
  searchState,
  results,
  activeResultId,
  onQueryChange,
  inputRef,
  onFilterChange,
  onSenderChange,
  onDateChange,
  onScopeChange,
  onNavigate,
  onOpenResult,
  onLoadMore,
  onClose,
}: ConversationSearchPanelProps) {
  const activeIndex = activeResultId ? results.findIndex((message) => message.id === activeResultId) : -1;
  const total = searchState.totalCount ?? results.length;
  const filterDisablesText = ["unreadMention", "unreadReaction", "unreadPollVote"].includes(filter);
  const handleQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onNavigate(event.shiftKey ? "newer" : "older");
  };

  return (
    <section
      className="conversation-search-panel"
      aria-label="搜索当前对话"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="message-search-row">
        <Search size={16} strokeWidth={1.8} />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleQueryKeyDown}
          placeholder={filterDisablesText ? "此筛选不使用关键词" : "搜索当前对话"}
          type="search"
          disabled={filterDisablesText}
        />
        <span className="message-search-count" aria-live="polite">
          {total === 0 ? "0 / 0" : `${activeIndex < 0 ? 0 : activeIndex + 1} / ${total}`}
        </span>
        <button className="icon-button" type="button" aria-label="上一个搜索结果" title="上一个搜索结果" disabled={activeIndex <= 0} onClick={() => onNavigate("newer")}>
          <ChevronUp size={17} strokeWidth={1.9} />
        </button>
        <button className="icon-button" type="button" aria-label="下一个搜索结果" title="下一个搜索结果" disabled={results.length === 0 || (activeIndex >= results.length - 1 && !searchState.nextFromMessageId)} onClick={() => onNavigate("older")}>
          {searchState.loadingMore ? <LoaderCircle className="spin" size={17} /> : <ChevronDown size={17} strokeWidth={1.9} />}
        </button>
        <button className="icon-button" type="button" aria-label="关闭消息搜索" title="关闭消息搜索" onClick={onClose}>
          <X size={17} strokeWidth={1.8} />
        </button>
      </div>
      <div className="message-search-options">
        <label>
          <span className="sr-only">消息类型</span>
          <select aria-label="消息类型" value={filter} onChange={(event) => onFilterChange(event.target.value as ChatMessageSearchFilter)}>
            {filterOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">消息发送者</span>
          <select aria-label="消息发送者" value={senderId ?? ""} onChange={(event) => onSenderChange(event.target.value || undefined)} disabled={filterDisablesText}>
            <option value="">所有成员</option>
            {senderOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        {isForum && (
          <div className="message-search-scope" role="group" aria-label="搜索范围">
            <button type="button" aria-pressed={scope === "topic"} className={scope === "topic" ? "is-active" : ""} onClick={() => onScopeChange("topic")}>当前话题</button>
            <button type="button" aria-pressed={scope === "chat"} className={scope === "chat" ? "is-active" : ""} onClick={() => onScopeChange("chat")}>整个群组</button>
          </div>
        )}
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
      <div className="message-search-results" aria-live="polite">
        {searchState.error && (
          <div className="message-search-state is-error" role="alert">{searchState.error}</div>
        )}
        {(searchState.loading || !searchState.input) && results.length === 0 && !searchState.error && (
          <div className="message-search-state" role="status">
            {searchState.loading ? <LoaderCircle className="spin" size={18} /> : "输入关键词或选择筛选条件"}
          </div>
        )}
        {!searchState.loading && !searchState.error && searchState.input && results.length === 0 && (
          <div className="message-search-state">没有搜索结果</div>
        )}
        {results.map((message) => {
          const content = messageContentText(message.content);
          const topicName = topicNameFor(message, topics);
          return (
            <button
              className={`message-search-result ${activeResultId === message.id ? "is-active" : ""}`}
              type="button"
              key={message.id}
              data-conversation-search-message-id={message.id}
              onClick={() => onOpenResult(message)}
            >
              <Avatar avatar={message.senderId === "self" ? { label: "我", color: "#73828c" } : users.get(message.senderId)?.avatar ?? chats.get(message.senderId.slice(5))?.avatar ?? { label: "T", color: "#73828c" }} size="small" />
              <span className="message-search-result-copy">
                <span><strong>{senderNameFor(message, users, chats)}</strong><time dateTime={message.sentAt}>{formatMessageTime(message.sentAt)}</time></span>
                <small>{highlightSnippet(content, query)}</small>
                {topicName && <em>{topicName}</em>}
              </span>
            </button>
          );
        })}
        {searchState.nextFromMessageId && (
          <button className="message-search-more" type="button" disabled={searchState.loadingMore} onClick={onLoadMore}>
            {searchState.loadingMore ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={15} />}
            <span>加载更早结果</span>
          </button>
        )}
      </div>
    </section>
  );
}
