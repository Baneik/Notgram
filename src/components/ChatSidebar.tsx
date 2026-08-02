import { Archive, CheckCheck, LoaderCircle, Pin, Search } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { Chat, ChatDraft } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { isChatPinnedInFolder } from "../store/telegramStore.selectors";
import { Avatar } from "./Avatar";

interface ChatSidebarProps {
  chats: Chat[];
  drafts: Map<string, ChatDraft>;
  activeChatId?: string;
  folderId: string;
  folderTitle: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelect: (chatId: string) => void;
  onOpenLatest: (chatId: string) => void;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  onReorderPinned: (chatIds: string[]) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_CONVERSATION_WIDTH = 340;

export function ChatSidebar({
  chats,
  drafts,
  activeChatId,
  folderId,
  folderTitle,
  searchQuery,
  onSearchChange,
  onSelect,
  onOpenLatest,
  loadingMore,
  hasMore,
  onLoadMore,
  onReorderPinned,
  width,
  onWidthChange,
}: ChatSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const resizeStartRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const [resizing, setResizing] = useState(false);
  const [draggedPinnedChatId, setDraggedPinnedChatId] = useState<string>();
  const [pinnedDropTarget, setPinnedDropTarget] = useState<{
    chatId: string;
    edge: "before" | "after";
  }>();

  const pinnedReorderEnabled = searchQuery.trim().length === 0;

  const beginPinnedDrag = (event: DragEvent<HTMLButtonElement>, chatId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", chatId);
    setDraggedPinnedChatId(chatId);
  };

  const updatePinnedDropTarget = (
    event: DragEvent<HTMLButtonElement>,
    chatId: string,
  ) => {
    if (!draggedPinnedChatId || draggedPinnedChatId === chatId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setPinnedDropTarget({ chatId, edge });
  };

  const dropPinnedChat = (event: DragEvent<HTMLButtonElement>, chatId: string) => {
    event.preventDefault();
    const sourceId = draggedPinnedChatId || event.dataTransfer.getData("text/plain");
    const edge = pinnedDropTarget?.chatId === chatId ? pinnedDropTarget.edge : "before";
    const pinnedIds = chats
      .filter((chat) => isChatPinnedInFolder(chat, folderId))
      .map((chat) => chat.id);
    const reordered = pinnedIds.filter((id) => id !== sourceId);
    const targetIndex = reordered.indexOf(chatId);
    if (sourceId && targetIndex >= 0) {
      reordered.splice(targetIndex + (edge === "after" ? 1 : 0), 0, sourceId);
      onReorderPinned(reordered);
    }
    setDraggedPinnedChatId(undefined);
    setPinnedDropTarget(undefined);
  };

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

  useEffect(() => {
    const list = chatListRef.current;
    if (!list || loadingMore || !hasMore || list.scrollHeight > list.clientHeight + 1) return;
    const attempt = `${searchQuery}:${chats.length}`;
    if (autoFillAttemptRef.current === attempt) return;
    autoFillAttemptRef.current = attempt;
    void onLoadMore();
  }, [chats.length, hasMore, loadingMore, onLoadMore, searchQuery]);

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

      <div
        className="chat-list"
        ref={chatListRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          if (
            list.scrollHeight - list.clientHeight - list.scrollTop <= 96 &&
            hasMore &&
            !loadingMore
          ) {
            void onLoadMore();
          }
        }}
      >
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
              folderId={folderId}
              draft={drafts.get(chat.id)}
              active={activeChatId === chat.id}
              onSelect={onSelect}
              onOpenLatest={onOpenLatest}
              pinnedDraggable={pinnedReorderEnabled && isChatPinnedInFolder(chat, folderId)}
              dragging={draggedPinnedChatId === chat.id}
              dropEdge={pinnedDropTarget?.chatId === chat.id
                ? pinnedDropTarget.edge
                : undefined}
              onDragStart={beginPinnedDrag}
              onDragOver={updatePinnedDropTarget}
              onDrop={dropPinnedChat}
              onDragEnd={() => {
                setDraggedPinnedChatId(undefined);
                setPinnedDropTarget(undefined);
              }}
            />
          ))
        )}
        {loadingMore && (
          <div className="chat-list-loading" role="status" aria-label="正在加载更多会话">
            <LoaderCircle className="spin" size={17} />
          </div>
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
  folderId,
  draft,
  active,
  onSelect,
  onOpenLatest,
  pinnedDraggable,
  dragging,
  dropEdge,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  chat: Chat;
  folderId: string;
  draft?: ChatDraft;
  active: boolean;
  onSelect: (chatId: string) => void;
  onOpenLatest: (chatId: string) => void;
  pinnedDraggable: boolean;
  dragging: boolean;
  dropEdge?: "before" | "after";
  onDragStart: (event: DragEvent<HTMLButtonElement>, chatId: string) => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>, chatId: string) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>, chatId: string) => void;
  onDragEnd: () => void;
}) {
  const visibleDraft = draft && (draft.text.length > 0 || draft.replyToMessageId)
    ? draft
    : undefined;
  return (
    <button
      type="button"
      className={`chat-row ${active ? "is-active" : ""} ${chat.muted ? "is-muted" : ""} ${pinnedDraggable ? "is-pinned-draggable" : ""} ${dragging ? "is-dragging" : ""} ${dropEdge ? `drop-${dropEdge}` : ""}`}
      draggable={pinnedDraggable}
      aria-grabbed={dragging}
      onClick={() => onSelect(chat.id)}
      onDoubleClick={() => onOpenLatest(chat.id)}
      onDragStart={(event) => onDragStart(event, chat.id)}
      onDragOver={(event) => onDragOver(event, chat.id)}
      onDrop={(event) => onDrop(event, chat.id)}
      onDragEnd={onDragEnd}
    >
      <Avatar avatar={chat.avatar} />
      <span className="chat-row-body">
        <span className="chat-row-topline">
          <strong>{chat.title}</strong>
          <time dateTime={chat.updatedAt}>{formatChatTime(chat.updatedAt)}</time>
        </span>
        <span className="chat-row-bottomline">
          <span className={`chat-preview ${visibleDraft ? "is-draft" : ""}`}>
            {visibleDraft ? (
              <>草稿：{visibleDraft.text || "回复消息"}</>
            ) : (
              <>{chat.kind === "saved" && <CheckCheck size={14} strokeWidth={2} />}{chat.preview}</>
            )}
          </span>
          <span className="chat-row-meta">
            {isChatPinnedInFolder(chat, folderId) && <Pin size={13} strokeWidth={2} />}
            {chat.folderIds.includes("archive") && <Archive size={13} strokeWidth={2} />}
            {chat.unreadCount > 0 && (
              <span className={`unread-count ${chat.muted ? "is-muted" : ""}`}>{chat.unreadCount}</span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
