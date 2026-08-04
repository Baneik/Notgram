import { Archive, CheckCheck, LoaderCircle, Pin, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
} from "react";
import type { GlobalSearchState } from "../store/globalSearchState";
import type { Chat, ChatDraft, ChatFolder, GlobalSearchFilter, User } from "../telegram/types";
import { formatChatTime } from "../utils/formatters";
import { isChatPinnedInFolder } from "../store/telegramStore.selectors";
import { Avatar } from "./Avatar";
import { GlobalSearchResults } from "./GlobalSearchView";
import { ChatContextMenu } from "./SidebarContextMenus";
import type { ContextMenuPoint } from "./ContextMenuSurface";

interface ChatSidebarProps {
  chats: Chat[];
  allChats: Map<string, Chat>;
  drafts: Map<string, ChatDraft>;
  users: Map<string, User>;
  folders: ChatFolder[];
  activeChatId?: string;
  folderId: string;
  folderTitle: string;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  globalSearch: GlobalSearchState;
  onSearchMessages: (query: string, filter: GlobalSearchFilter) => Promise<void>;
  onLoadMoreSearchMessages: () => Promise<void>;
  onCancelMessageSearch: () => void;
  onOpenSearchMessage: (chatId: string, messageId: string) => void;
  onSelect: (chatId: string) => void;
  onOpenLatest: (chatId: string) => void;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  onReorderPinned: (chatIds: string[]) => void;
  chatManagementPending: Set<string>;
  folderManagementPending: boolean;
  onSetPinned: (chatListId: string, chatId: string, pinned: boolean) => Promise<boolean>;
  onSetFolderMembership: (
    folderId: string,
    chatId: string,
    included: boolean,
  ) => Promise<boolean>;
  onRequestLeaveGroup: (chat: Chat) => void;
  width: number;
  onWidthPreview: (width: number) => void;
  onWidthChange: (width: number) => void;
}

const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_CONVERSATION_WIDTH = 340;

export function ChatSidebar({
  chats,
  allChats,
  drafts,
  users,
  folders,
  activeChatId,
  folderId,
  folderTitle,
  searchQuery,
  searchInputRef,
  onSearchChange,
  globalSearch,
  onSearchMessages,
  onLoadMoreSearchMessages,
  onCancelMessageSearch,
  onOpenSearchMessage,
  onSelect,
  onOpenLatest,
  loadingMore,
  hasMore,
  onLoadMore,
  onReorderPinned,
  chatManagementPending,
  folderManagementPending,
  onSetPinned,
  onSetFolderMembership,
  onRequestLeaveGroup,
  width,
  onWidthPreview,
  onWidthChange,
}: ChatSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const resizeStartRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const pendingResizeWidthRef = useRef(width);
  const [resizing, setResizing] = useState(false);
  const [draggedPinnedChatId, setDraggedPinnedChatId] = useState<string>();
  const [pinnedDropTarget, setPinnedDropTarget] = useState<{
    chatId: string;
    edge: "before" | "after";
  }>();
  const pinnedDragRef = useRef<{
    pointerId: number;
    chatId: string;
    startX: number;
    startY: number;
    moved: boolean;
    element: HTMLButtonElement;
  } | undefined>(undefined);
  const pinnedDropTargetRef = useRef<typeof pinnedDropTarget>(undefined);
  const suppressNextChatClickRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{
    chatId: string;
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
  }>();

  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const selectChatFromClick = useCallback((chatId: string) => {
    if (suppressNextChatClickRef.current) return;
    onSelect(chatId);
  }, [onSelect]);
  const openContextMenu = useCallback((
    chatId: string,
    point: ContextMenuPoint,
    anchor: HTMLButtonElement,
  ) => {
    setContextMenu({ chatId, point, anchor });
  }, []);

  const pinnedReorderEnabled = searchQuery.trim().length === 0;

  const setDropTarget = (target: typeof pinnedDropTarget) => {
    const current = pinnedDropTargetRef.current;
    if (current?.chatId === target?.chatId && current?.edge === target?.edge) return;
    pinnedDropTargetRef.current = target;
    setPinnedDropTarget(target);
  };

  const beginPinnedDrag = (event: PointerEvent<HTMLButtonElement>, chatId: string) => {
    if (event.button !== 0 || !pinnedReorderEnabled) return;
    pinnedDragRef.current = {
      pointerId: event.pointerId,
      chatId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePinnedDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = pinnedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 6) return;
      drag.moved = true;
      setDraggedPinnedChatId(drag.chatId);
    }
    event.preventDefault();

    const row = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLButtonElement>(".chat-row[data-chat-id]");
    const chatId = row?.dataset.chatId;
    if (
      !row ||
      !chatId ||
      chatId === drag.chatId ||
      row.dataset.pinned !== "true"
    ) {
      setDropTarget(undefined);
      return;
    }
    const bounds = row.getBoundingClientRect();
    setDropTarget({
      chatId,
      edge: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  };

  const finishPinnedDrag = (
    event: PointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const drag = pinnedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = pinnedDropTargetRef.current;
    pinnedDragRef.current = undefined;

    if (drag.moved) {
      event.preventDefault();
      suppressNextChatClickRef.current = true;
      globalThis.setTimeout(() => { suppressNextChatClickRef.current = false; }, 0);
      if (!cancelled && target) {
        const pinnedIds = chats
          .filter((chat) => isChatPinnedInFolder(chat, folderId))
          .map((chat) => chat.id);
        const reordered = pinnedIds.filter((id) => id !== drag.chatId);
        const targetIndex = reordered.indexOf(target.chatId);
        if (targetIndex >= 0) {
          reordered.splice(targetIndex + (target.edge === "after" ? 1 : 0), 0, drag.chatId);
          onReorderPinned(reordered);
        }
      }
    }

    if (drag.element.hasPointerCapture(event.pointerId)) {
      drag.element.releasePointerCapture(event.pointerId);
    }
    setDraggedPinnedChatId(undefined);
    setDropTarget(undefined);
  };

  const maximumWidth = () => {
    const left = sidebarRef.current?.getBoundingClientRect().left ?? 86;
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - left - MIN_CONVERSATION_WIDTH),
    );
  };

  const boundedWidth = (nextWidth: number) =>
    Math.round(Math.min(maximumWidth(), Math.max(MIN_SIDEBAR_WIDTH, nextWidth)));

  const commitWidth = (nextWidth: number) => {
    const bounded = boundedWidth(nextWidth);
    pendingResizeWidthRef.current = bounded;
    onWidthPreview(bounded);
    onWidthChange(bounded);
  };

  const previewWidth = (nextWidth: number) => {
    pendingResizeWidthRef.current = boundedWidth(nextWidth);
    if (resizeFrameRef.current !== undefined) return;
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      onWidthPreview(pendingResizeWidthRef.current);
    });
  };

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.matchMedia("(max-width: 720px)").matches) return;
    event.preventDefault();
    resizeStartRef.current = {
      x: event.clientX,
      width: sidebarRef.current?.getBoundingClientRect().width ?? width,
    };
    pendingResizeWidthRef.current = resizeStartRef.current.width;
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    previewWidth(start.width + event.clientX - start.x);
  };

  const endResize = () => {
    if (!resizeStartRef.current) return;
    if (resizeFrameRef.current !== undefined) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = undefined;
    }
    commitWidth(pendingResizeWidthRef.current);
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
    commitWidth(nextWidth);
  };

  useEffect(() => () => {
    if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("is-resizing-sidebar", resizing);
    return () => document.documentElement.classList.remove("is-resizing-sidebar");
  }, [resizing]);

  useEffect(() => {
    document.documentElement.classList.toggle("is-reordering-pinned", Boolean(draggedPinnedChatId));
    return () => document.documentElement.classList.remove("is-reordering-pinned");
  }, [draggedPinnedChatId]);

  useEffect(() => {
    const list = chatListRef.current;
    if (
      searchQuery.trim() ||
      !list ||
      loadingMore ||
      !hasMore ||
      list.scrollHeight > list.clientHeight + 1
    ) return;
    const attempt = `${searchQuery}:${chats.length}`;
    if (autoFillAttemptRef.current === attempt) return;
    autoFillAttemptRef.current = attempt;
    void onLoadMore();
  }, [chats.length, hasMore, loadingMore, onLoadMore, searchQuery]);

  const contextChat = contextMenu
    ? chats.find((chat) => chat.id === contextMenu.chatId)
    : undefined;

  return (
    <>
    <aside ref={sidebarRef} className={`chat-sidebar ${resizing ? "is-resizing" : ""}`} aria-label="会话列表">
      <div className="sidebar-heading">
        <div>
          <h1>{folderTitle}</h1>
        </div>
      </div>

      <label className="search-field">
        <Search size={17} strokeWidth={1.8} />
        <span className="sr-only">搜索会话和消息</span>
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onSearchChange("");
          }}
          placeholder="搜索会话和消息"
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

      {searchQuery.trim() ? (
        <GlobalSearchResults
          query={searchQuery}
          state={globalSearch}
          knownChats={new Map(chats.map((chat) => [chat.id, chat]))}
          onSearch={onSearchMessages}
          onLoadMore={onLoadMoreSearchMessages}
          onCancel={onCancelMessageSearch}
          onOpenChat={onSelect}
          onOpenMessage={onOpenSearchMessage}
        />
      ) : (
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
                previewSenderName={chat.previewSenderId
                  ? users.get(chat.previewSenderId)?.displayName ?? (
                      chat.previewSenderId.startsWith("chat:")
                        ? allChats.get(chat.previewSenderId.slice(5))?.title
                        : chat.kind === "direct" && chat.previewSenderId === chat.peerId
                          ? chat.title
                          : undefined
                    )
                  : undefined}
                folderId={folderId}
                draft={drafts.get(chat.id)}
                active={activeChatId === chat.id}
                onOpenLatest={onOpenLatest}
                onOpenContextMenu={openContextMenu}
                pinnedDraggable={pinnedReorderEnabled && isChatPinnedInFolder(chat, folderId)}
                dragging={draggedPinnedChatId === chat.id}
                dropEdge={pinnedDropTarget?.chatId === chat.id
                  ? pinnedDropTarget.edge
                  : undefined}
                onSelectChat={selectChatFromClick}
                onPointerDown={beginPinnedDrag}
                onPointerMove={movePinnedDrag}
                onPointerUp={finishPinnedDrag}
                onPointerCancel={(event) => finishPinnedDrag(event, true)}
                onLostPointerCapture={(event) => finishPinnedDrag(event, true)}
              />
            ))
          )}
          {loadingMore && (
            <div className="chat-list-loading" role="status" aria-label="正在加载更多会话">
              <LoaderCircle className="spin" size={17} />
            </div>
          )}
        </div>
      )}
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
        onDoubleClick={() => commitWidth(360)}
        onKeyDown={handleResizeKey}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      />
    </aside>
    {contextMenu && contextChat && (
      <ChatContextMenu
        chat={contextChat}
        chatListId={folderId}
        folders={folders}
        point={contextMenu.point}
        chatPending={chatManagementPending.has(contextChat.id)}
        folderPending={folderManagementPending}
        restoreFocus={() => contextMenu.anchor.focus()}
        onSetPinned={(pinned) => onSetPinned(folderId, contextChat.id, pinned)}
        onSetFolderMembership={(targetFolderId, included) =>
          onSetFolderMembership(targetFolderId, contextChat.id, included)}
        onRequestLeave={() => onRequestLeaveGroup(contextChat)}
        onClose={closeContextMenu}
      />
    )}
    </>
  );
}

function ChatRow({
  chat,
  previewSenderName,
  folderId,
  draft,
  active,
  onSelectChat,
  onOpenLatest,
  onOpenContextMenu,
  pinnedDraggable,
  dragging,
  dropEdge,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  chat: Chat;
  previewSenderName?: string;
  folderId: string;
  draft?: ChatDraft;
  active: boolean;
  onSelectChat: (chatId: string) => void;
  onOpenLatest: (chatId: string) => void;
  onOpenContextMenu: (
    chatId: string,
    point: ContextMenuPoint,
    anchor: HTMLButtonElement,
  ) => void;
  pinnedDraggable: boolean;
  dragging: boolean;
  dropEdge?: "before" | "after";
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, chatId: string) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const visibleDraft = draft && (draft.text.length > 0 || draft.replyToMessageId)
    ? draft
    : undefined;
  return (
    <button
      type="button"
      className={`chat-row ${active ? "is-active" : ""} ${chat.muted ? "is-muted" : ""} ${pinnedDraggable ? "is-pinned-draggable" : ""} ${dragging ? "is-dragging" : ""} ${dropEdge ? `drop-${dropEdge}` : ""}`}
      data-chat-id={chat.id}
      data-pinned={pinnedDraggable}
      aria-grabbed={dragging}
      aria-current={active ? "true" : undefined}
      onClick={(event) => {
        if (event.detail <= 1) onSelectChat(chat.id);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpenLatest(chat.id);
      }}
      onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onOpenContextMenu(
          chat.id,
          { x: event.clientX, y: event.clientY },
          event.currentTarget,
        );
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onOpenContextMenu(
          chat.id,
          { x: bounds.left + Math.min(72, bounds.width / 2), y: bounds.top + bounds.height / 2 },
          event.currentTarget,
        );
      }}
      onPointerDown={(event) => pinnedDraggable && onPointerDown(event, chat.id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
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
              <>
                {chat.kind === "saved" && <CheckCheck size={14} strokeWidth={2} />}
                {previewSenderName && chat.kind !== "saved" ? `${previewSenderName}: ${chat.preview}` : chat.preview}
              </>
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
