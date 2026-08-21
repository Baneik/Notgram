import { Archive, CheckCheck, LoaderCircle, Pin, Plus, Search, X } from "lucide-react";
import {
  memo,
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
import { useTelegramStore } from "../store/telegramStore";
import type { Chat, ChatDraft, ChatFolder, GlobalSearchFilter, User } from "../telegram/types";
import { hasChatDraftContent } from "../telegram/chatDraft";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { SidebarSearchScope } from "../hooks/useSidebarSearch";
import { formatChatTime } from "../utils/formatters";
import { isChatPinnedInFolder } from "../store/telegramStore.selectors";
import { Avatar } from "./Avatar";
import { ChatSearchResults, GlobalSearchResults, type SidebarSearchSenderOption } from "./GlobalSearchView";
import { ChatContextMenu } from "./SidebarContextMenus";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { usePreferencesStore, type UnreadBadgePosition } from "../store/preferencesStore";
import { useFlipListMotion } from "../hooks/useFlipListMotion";

interface ChatSidebarProps {
  chats: Chat[];
  allChats: Map<string, Chat>;
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
  searchScope: SidebarSearchScope;
  chatMessageSearch: ChatMessageSearchState;
  chatSearchSenderId?: string;
  chatSearchStateMatchesInput: boolean;
  chatSearchSenderOptions: SidebarSearchSenderOption[];
  onChatSearchSenderChange: (senderId: string | undefined) => void;
  onLoadMoreChatSearch: () => Promise<void>;
  onExitSearchScope: (preserveQuery: boolean) => void;
  onSelect: (chatId: string) => void;
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
  onCreateChat: () => void;
  width: number;
  onWidthPreview: (width: number) => void;
  onWidthChange: (width: number) => void;
  mobileViewport?: boolean;
  mobileChatOpen?: boolean;
}

const MIN_SIDEBAR_WIDTH = 250;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_CONVERSATION_WIDTH = 340;

const listDraft = (draft?: ChatDraft) => (
  hasChatDraftContent(draft) ? draft : undefined
);

export function ChatSidebar({
  chats,
  allChats,
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
  searchScope,
  chatMessageSearch,
  chatSearchSenderId,
  chatSearchStateMatchesInput,
  chatSearchSenderOptions,
  onChatSearchSenderChange,
  onLoadMoreChatSearch,
  onExitSearchScope,
  onSelect,
  loadingMore,
  hasMore,
  onLoadMore,
  onReorderPinned,
  chatManagementPending,
  folderManagementPending,
  onSetPinned,
  onSetFolderMembership,
  onRequestLeaveGroup,
  onCreateChat,
  width,
  onWidthPreview,
  onWidthChange,
  mobileViewport = false,
  mobileChatOpen = false,
}: ChatSidebarProps) {
  const unreadBadgePosition = usePreferencesStore((state) => state.unreadBadgePosition);
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
  const onSelectRef = useRef(onSelect);
  const chatsRef = useRef(chats);
  const folderIdRef = useRef(folderId);
  const onReorderPinnedRef = useRef(onReorderPinned);
  onSelectRef.current = onSelect;
  chatsRef.current = chats;
  folderIdRef.current = folderId;
  onReorderPinnedRef.current = onReorderPinned;
  const stableSelectChat = useCallback((chatId: string) => onSelectRef.current(chatId), []);
  const [contextMenu, setContextMenu] = useState<{
    chatId: string;
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
  }>();

  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const selectChatFromClick = useCallback((chatId: string) => {
    if (suppressNextChatClickRef.current) return;
    stableSelectChat(chatId);
  }, [stableSelectChat]);
  const openContextMenu = useCallback((
    chatId: string,
    point: ContextMenuPoint,
    anchor: HTMLButtonElement,
  ) => {
    setContextMenu({ chatId, point, anchor });
  }, []);

  const pinnedReorderEnabled = searchQuery.trim().length === 0;

  const setDropTarget = useCallback((target: typeof pinnedDropTarget) => {
    const current = pinnedDropTargetRef.current;
    if (current?.chatId === target?.chatId && current?.edge === target?.edge) return;
    pinnedDropTargetRef.current = target;
    setPinnedDropTarget(target);
  }, []);

  const beginPinnedDrag = useCallback((event: PointerEvent<HTMLButtonElement>, chatId: string) => {
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
  }, [pinnedReorderEnabled]);

  const movePinnedDrag = useCallback((event: PointerEvent<HTMLButtonElement>) => {
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
  }, [setDropTarget]);

  const finishPinnedDrag = useCallback((
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
        const pinnedIds = chatsRef.current
          .filter((chat) => isChatPinnedInFolder(chat, folderIdRef.current))
          .map((chat) => chat.id);
        const reordered = pinnedIds.filter((id) => id !== drag.chatId);
        const targetIndex = reordered.indexOf(target.chatId);
        if (targetIndex >= 0) {
          reordered.splice(targetIndex + (target.edge === "after" ? 1 : 0), 0, drag.chatId);
          onReorderPinnedRef.current(reordered);
        }
      }
    }

    if (drag.element.hasPointerCapture(event.pointerId)) {
      drag.element.releasePointerCapture(event.pointerId);
    }
    setDraggedPinnedChatId(undefined);
    setDropTarget(undefined);
  }, [setDropTarget]);
  const cancelPinnedDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => finishPinnedDrag(event, true),
    [finishPinnedDrag],
  );

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
  const scopedChat = searchScope.type === "chat" ? allChats.get(searchScope.chatId) : undefined;
  const scopedSearch = Boolean(scopedChat);

  useFlipListMotion({
    containerRef: chatListRef,
    itemSelector: ".chat-row[data-motion-key]",
    dependencies: [chats, folderId, searchQuery, searchScope.type],
  });

  return (
    <>
    <aside
      ref={sidebarRef}
      className={`chat-sidebar ${scopedSearch ? "has-scoped-search" : ""} ${resizing ? "is-resizing" : ""}`}
      aria-label="会话列表"
      aria-hidden={mobileViewport && mobileChatOpen ? true : undefined}
      inert={mobileViewport && mobileChatOpen ? true : undefined}
    >
      <div className="sidebar-heading">
        <div>
          <h1>{folderTitle}</h1>
        </div>
        <button className="icon-button" type="button" aria-label="新建群组或频道" title="新建群组或频道" onClick={onCreateChat}>
          <Plus size={20} strokeWidth={1.9} />
        </button>
      </div>

      <label className="search-field">
        <Search size={17} strokeWidth={1.8} />
        <span className="sr-only">搜索会话和消息</span>
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (scopedSearch) onExitSearchScope(false);
            else onSearchChange("");
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

      {scopedChat && (
        <div className="sidebar-search-scope" role="group" aria-label={`搜索范围：${scopedChat.title}`}>
          <Avatar avatar={scopedChat.avatar} size="small" />
          <span>此会话：{scopedChat.title}</span>
          <button type="button" className="icon-button" aria-label="移除会话搜索范围" title="移除会话搜索范围" onClick={() => onExitSearchScope(true)}>
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>
      )}

      {scopedChat ? (
        <ChatSearchResults
          chat={scopedChat}
          query={searchQuery}
          senderId={chatSearchSenderId}
          senderOptions={chatSearchSenderOptions}
          knownChats={allChats}
          knownUsers={users}
          state={chatMessageSearch}
          stateMatchesInput={chatSearchStateMatchesInput}
          onSenderChange={onChatSearchSenderChange}
          onLoadMore={onLoadMoreChatSearch}
          onOpenMessage={onOpenSearchMessage}
        />
      ) : searchQuery.trim() ? (
        <GlobalSearchResults
          query={searchQuery}
          state={globalSearch}
          knownChats={allChats}
          knownUsers={users}
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
                unreadBadgePosition={unreadBadgePosition}
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
                active={activeChatId === chat.id}
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
                onPointerCancel={cancelPinnedDrag}
                onLostPointerCapture={cancelPinnedDrag}
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
        restoreFocus={() => contextMenu.anchor.focus({ preventScroll: true })}
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

const ChatRow = memo(function ChatRow({
  chat,
  unreadBadgePosition,
  previewSenderName,
  folderId,
  active,
  onSelectChat,
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
  unreadBadgePosition: UnreadBadgePosition;
  previewSenderName?: string;
  folderId: string;
  active: boolean;
  onSelectChat: (chatId: string) => void;
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
  const draft = useTelegramStore((state) => state.drafts.get(chat.id));
  const visibleDraftRef = useRef<ChatDraft | undefined>(listDraft(draft));
  if (!active) visibleDraftRef.current = listDraft(draft);
  const visibleDraft = visibleDraftRef.current;
  const hasUnreadAttention = chat.unreadMentionCount > 0;
  const unreadBadgeClassName = `unread-count ${chat.muted ? "is-muted" : ""} ${hasUnreadAttention ? "has-attention" : ""}`;
  const unreadBadgeLabel = hasUnreadAttention
    ? `${chat.unreadCount} 条未读消息，其中包含提及或回复`
    : undefined;
  return (
    <button
      type="button"
      className={`chat-row ${active ? "is-active" : ""} ${chat.muted ? "is-muted" : ""} ${pinnedDraggable ? "is-pinned-draggable" : ""} ${dragging ? "is-dragging" : ""} ${dropEdge ? `drop-${dropEdge}` : ""}`}
      data-chat-id={chat.id}
      data-motion-key={chat.id}
      data-pinned={pinnedDraggable}
      aria-grabbed={dragging}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelectChat(chat.id)}
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
      <span className="chat-avatar-wrap">
        <Avatar avatar={chat.avatar} />
        {unreadBadgePosition === "avatar" && chat.unreadCount > 0 && (
          <span
            className={`${unreadBadgeClassName} unread-count-avatar`}
            aria-label={unreadBadgeLabel}
            title={hasUnreadAttention ? "包含未读的提及或回复" : undefined}
          >
            {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
          </span>
        )}
      </span>
      <span className="chat-row-body">
        <span className="chat-row-topline">
          <strong>{chat.title}</strong>
          <time dateTime={chat.updatedAt}>{formatChatTime(chat.updatedAt)}</time>
        </span>
        <span className="chat-row-bottomline">
          <span className={`chat-preview ${visibleDraft ? "is-draft" : ""}`}>
            {visibleDraft ? (
              <span className="chat-preview-message">草稿：{visibleDraft.text || "回复消息"}</span>
            ) : (
              <>
                {chat.kind === "saved" && <CheckCheck size={14} strokeWidth={2} />}
                <span className="chat-preview-message">
                  {previewSenderName && chat.kind === "group" && (
                    <span className="chat-preview-sender">{`${previewSenderName}: `}</span>
                  )}
                  {chat.preview}
                </span>
              </>
            )}
          </span>
          <span className="chat-row-meta">
            {isChatPinnedInFolder(chat, folderId) && <Pin size={13} strokeWidth={2} />}
            {chat.folderIds.includes("archive") && <Archive size={13} strokeWidth={2} />}
            {unreadBadgePosition === "right" && chat.unreadCount > 0 && (
              <span
                className={unreadBadgeClassName}
                aria-label={unreadBadgeLabel}
                title={hasUnreadAttention ? "包含未读的提及或回复" : undefined}
              >
                {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
});
