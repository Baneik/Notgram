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
  ChatMessageSearchFilter,
  Message,
  User,
} from "../telegram/types";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { ConversationSearchScope } from "../hooks/useConversationSearch";

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
  searchState: ChatMessageSearchState;
  stateMatchesInput: boolean;
  results: Message[];
  activeResultId?: string;
  onQueryChange: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLInputElement | null>;
  onFilterChange: (filter: ChatMessageSearchFilter) => void;
  onSenderChange: (senderId: string | undefined) => void;
  onDateChange: (date: string) => void;
  onScopeChange: (scope: ConversationSearchScope) => void;
  onNavigate: (direction: "older" | "newer") => void;
  onClose: () => void;
}

export function ConversationSearchPanel({
  query,
  filter,
  senderId,
  date,
  scope,
  isForum,
  senderOptions,
  searchState,
  stateMatchesInput,
  results,
  activeResultId,
  onQueryChange,
  inputRef,
  onFilterChange,
  onSenderChange,
  onDateChange,
  onScopeChange,
  onNavigate,
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
          {!stateMatchesInput || searchState.loading
            ? "搜索中"
            : total === 0 ? "0 / 0" : `${activeIndex < 0 ? 0 : activeIndex + 1} / ${total}`}
        </span>
        <button className="icon-button" type="button" aria-label="上一个搜索结果" title="上一个搜索结果" disabled={!stateMatchesInput || activeIndex <= 0} onClick={() => onNavigate("newer")}>
          <ChevronUp size={17} strokeWidth={1.9} />
        </button>
        <button className="icon-button" type="button" aria-label="下一个搜索结果" title="下一个搜索结果" disabled={!stateMatchesInput || results.length === 0 || (activeIndex >= results.length - 1 && !searchState.nextFromMessageId)} onClick={() => onNavigate("older")}>
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
    </section>
  );
}
