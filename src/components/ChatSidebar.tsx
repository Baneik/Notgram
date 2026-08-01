import { Archive, CheckCheck, Pin, Search, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
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
  width: number;
  onWidthChange: (width: number) => void;
}

const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_CONVERSATION_WIDTH = 340;

export function ChatSidebar({
  chats,
  activeChatId,
  folderTitle,
  searchQuery,
  onSearchChange,
  onSelect,
  width,
  onWidthChange,
}: ChatSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const [resizing, setResizing] = useState(false);

  const maximumWidth = () => {
    const left = sidebarRef.current?.getBoundingClientRect().left ?? 86;
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - left - MIN_CONVERSATION_WIDTH),
    );
  };

  const updateWidth = (nextWidth: number) => {
    onWidthChange(Math.round(Math.min(maximumWidth(), Math.max(MIN_SIDEBAR_WIDTH, nextWidth))));
  };

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.matchMedia("(max-width: 720px)").matches) return;
    event.preventDefault();
    resizeStartRef.current = {
      x: event.clientX,
      width: sidebarRef.current?.getBoundingClientRect().width ?? width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    updateWidth(start.width + event.clientX - start.x);
  };

  const endResize = () => {
    resizeStartRef.current = undefined;
    setResizing(false);
  };

  const handleResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") nextWidth = width - 16;
    if (event.key === "ArrowRight") nextWidth = width + 16;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = maximumWidth();
    if (nextWidth === undefined) return;
    event.preventDefault();
    updateWidth(nextWidth);
  };

  useEffect(() => {
    document.documentElement.classList.toggle("is-resizing-sidebar", resizing);
    return () => document.documentElement.classList.remove("is-resizing-sidebar");
  }, [resizing]);

  return (
    <aside ref={sidebarRef} className={`chat-sidebar ${resizing ? "is-resizing" : ""}`} aria-label="会话列表">
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
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="调整会话列表宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={maximumWidth()}
        aria-valuenow={Math.round(Math.min(maximumWidth(), Math.max(
          MIN_SIDEBAR_WIDTH,
          sidebarRef.current?.getBoundingClientRect().width ?? width,
        )))}
        tabIndex={0}
        title="拖动调整会话列表宽度"
        onDoubleClick={() => updateWidth(360)}
        onKeyDown={handleResizeKey}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      />
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
