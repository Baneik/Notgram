import { Archive, CheckCheck, Pin, Search, VolumeX } from "lucide-react";
import type { Chat } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { Avatar } from "./Avatar";

interface ChatSidebarProps {
  chats: Chat[];
  activeChatId?: string;
  folderTitle: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelect: (chatId: string) => void;
}

export function ChatSidebar({
  chats,
  activeChatId,
  folderTitle,
  searchQuery,
  onSearchChange,
  onSelect,
}: ChatSidebarProps) {
  return (
    <aside className="chat-sidebar" aria-label="会话列表">
      <div className="sidebar-heading">
        <h1>{folderTitle}</h1>
      </div>

      <label className="search-field">
        <Search size={17} strokeWidth={1.8} />
        <span className="sr-only">搜索会话</span>
        <input
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索会话"
          type="search"
        />
        {searchQuery && (
          <button
            type="button"
            className="clear-search"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={() => onSearchChange("")}
          >
            ×
          </button>
        )}
      </label>

      <div className="chat-list">
        {chats.length === 0 ? (
          <div className="list-empty">
            <Search size={22} strokeWidth={1.6} />
            <span>没有匹配的会话</span>
          </div>
        ) : (
          chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={activeChatId === chat.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ChatRow({
  chat,
  active,
  onSelect,
}: {
  chat: Chat;
  active: boolean;
  onSelect: (chatId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`chat-row ${active ? "is-active" : ""}`}
      onClick={() => onSelect(chat.id)}
    >
      <Avatar avatar={chat.avatar} />
      <span className="chat-row-body">
        <span className="chat-row-topline">
          <strong>{chat.title}</strong>
          <time dateTime={chat.updatedAt}>{formatChatTime(chat.updatedAt)}</time>
        </span>
        <span className="chat-row-bottomline">
          <span className="chat-preview">
            {chat.kind === "saved" && <CheckCheck size={14} strokeWidth={2} />}
            {chat.preview}
          </span>
          <span className="chat-row-meta">
            {chat.pinned && <Pin size={13} strokeWidth={2} />}
            {chat.muted && <VolumeX size={13} strokeWidth={2} />}
            {chat.folderIds.includes("archive") && <Archive size={13} strokeWidth={2} />}
            {chat.unreadCount > 0 && <span className="unread-count">{chat.unreadCount}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}
