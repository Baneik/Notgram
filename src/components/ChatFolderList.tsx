import { translate } from "../i18n";
import { useTranslation } from "react-i18next";
import { Archive, LoaderCircle, Pin, Search } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { Chat, ChatDraft, User } from "../telegram/types";
import { hasChatDraftContent } from "../telegram/chatDraft";
import { isChatPinnedInFolder } from "../store/telegramStore.selectors";
import type { UnreadBadgePosition } from "../store/preferencesStore";
import { formatChatTime, formatUnreadCount } from "../utils/formatters";
import { useFlipListMotion } from "../hooks/useFlipListMotion";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { Avatar } from "./Avatar";

const listDraft = (draft?: ChatDraft) => hasChatDraftContent(draft) ? draft : undefined;

interface ChatFolderListProps {
  chats: Chat[];
  allChats: Map<string, Chat>;
  users: Map<string, User>;
  folderId: string;
  active: boolean;
  activeChatId?: string;
  unreadBadgePosition: UnreadBadgePosition;
  localBlockedUserIds: Set<string>;
  initialScrollTop?: number;
  onScrollPosition: (folderId: string, top: number) => void;
  onSelect: (chatId: string) => void;
  onOpenLatest?: (chatId: string) => void;
  onOpenContextMenu: (chatId: string, point: ContextMenuPoint, anchor: HTMLButtonElement, keyboard?: boolean) => void;
  onLoadMore: (folderId: string) => Promise<void>;
  onReorderPinned: (folderId: string, chatIds: string[]) => void;
}

export const ChatFolderList = memo(function ChatFolderList({
  chats, allChats, users, folderId, active, activeChatId, unreadBadgePosition,
  localBlockedUserIds, initialScrollTop = 0, onScrollPosition, onSelect,
  onOpenLatest, onOpenContextMenu, onLoadMore, onReorderPinned,
}: ChatFolderListProps) {
  const loadingMore = useTelegramStore((state) => state.chatLists.get(folderId)?.loading ?? false);
  const hasMore = useTelegramStore((state) => state.chatLists.get(folderId)?.hasMore ?? true);
  const chatListRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const initialScrollTopRef = useRef(initialScrollTop);
  const [preloadCount, setPreloadCount] = useState(0);
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
  const onOpenLatestRef = useRef(onOpenLatest);
  const chatsRef = useRef(chats);
  const folderIdRef = useRef(folderId);
  const onReorderPinnedRef = useRef(onReorderPinned);
  onSelectRef.current = onSelect;
  onOpenLatestRef.current = onOpenLatest;
  chatsRef.current = chats;
  folderIdRef.current = folderId;
  onReorderPinnedRef.current = onReorderPinned;
  const stableSelectChat = useCallback((chatId: string) => {
    if (activeRef.current) onSelectRef.current(chatId);
  }, []);
  const stableOpenLatest = useCallback((chatId: string) => {
    if (activeRef.current) onOpenLatestRef.current?.(chatId);
  }, []);

  const selectChatFromClick = useCallback((chatId: string) => {
    if (activeRef.current && !suppressNextChatClickRef.current) stableSelectChat(chatId);
  }, [stableSelectChat]);
  const contextMenuRef = useRef(onOpenContextMenu);
  contextMenuRef.current = onOpenContextMenu;
  const openContextMenu = useCallback((...parameters: Parameters<typeof onOpenContextMenu>) => {
    if (activeRef.current) contextMenuRef.current(...parameters);
  }, []);
  const pinnedReorderEnabled = active;

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
    if (!activeRef.current || !drag || drag.pointerId !== event.pointerId) return;
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
      !chatListRef.current?.contains(row) ||
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
      if (!cancelled && activeRef.current && target) {
        const pinnedIds = chatsRef.current
          .filter((chat) => isChatPinnedInFolder(chat, folderIdRef.current))
          .map((chat) => chat.id);
        const reordered = pinnedIds.filter((id) => id !== drag.chatId);
        const targetIndex = reordered.indexOf(target.chatId);
        if (targetIndex >= 0) {
          reordered.splice(targetIndex + (target.edge === "after" ? 1 : 0), 0, drag.chatId);
          onReorderPinnedRef.current(folderIdRef.current, reordered);
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


  useLayoutEffect(() => {
    const list = chatListRef.current;
    if (!list) return;
    list.scrollTop = initialScrollTopRef.current;
    // Capture the last offset even if an unmount precedes the browser's scroll event.
    return () => onScrollPosition(folderId, list.scrollTop);
  }, [folderId, onScrollPosition]);

  useLayoutEffect(() => {
    const list = chatListRef.current;
    if (!list || folderId === "main") return;
    const measure = () => {
      const minimumRowHeight = parseFloat(getComputedStyle(list).getPropertyValue("--chat-row-min-height")) || 60;
      setPreloadCount(Math.ceil(list.clientHeight / minimumRowHeight) + 3);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    if (list.firstElementChild) observer.observe(list.firstElementChild);
    return () => observer.disconnect();
  }, [chats.length, folderId]);

  useLayoutEffect(() => {
    if (active) return;
    const drag = pinnedDragRef.current;
    pinnedDragRef.current = undefined;
    if (drag?.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
    setDraggedPinnedChatId(undefined);
    setDropTarget(undefined);
  }, [active, setDropTarget]);

  useEffect(() => {
    if (!active || !draggedPinnedChatId) return;
    document.documentElement.classList.add("is-reordering-pinned");
    return () => document.documentElement.classList.remove("is-reordering-pinned");
  }, [active, draggedPinnedChatId]);

  useEffect(() => {
    const list = chatListRef.current;
    if (!active || !list || loadingMore || !hasMore || list.scrollHeight > list.clientHeight + 1) return;
    const attempt = String(chats.length);
    if (autoFillAttemptRef.current === attempt) return;
    autoFillAttemptRef.current = attempt;
    void onLoadMore(folderId);
  }, [active, chats.length, folderId, hasMore, loadingMore, onLoadMore]);

  useFlipListMotion({
    containerRef: chatListRef,
    itemSelector: ".chat-row[data-motion-key]",
    dependencies: [chats],
    enabled: active,
  });

  return (
    <>
    <div
      className="chat-list"
      data-folder-id={folderId}
      data-active={active}
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
      ref={chatListRef}
      onScroll={(event) => {
        if (!activeRef.current) return;
        const list = event.currentTarget;
        onScrollPosition(folderId, list.scrollTop);
        if (list.scrollHeight - list.clientHeight - list.scrollTop <= 96 && hasMore && !loadingMore) {
          void onLoadMore(folderId);
        }
      }}
    >
      {chats.length === 0 ? (
        <div className="list-empty">
          <Search size={22} strokeWidth={1.6} />
          <span>{translate("没有匹配的会话")}</span>
        </div>
      ) : (
        chats.map((chat, index) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            avatarActive={active}
            preloadAvatar={folderId !== "main" && index < preloadCount}
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
            previewConcealed={Boolean(
              (chat.previewSenderId && localBlockedUserIds.has(chat.previewSenderId)) ||
              (chat.kind === "direct" && chat.peerId && localBlockedUserIds.has(chat.peerId)),
            )}
            folderId={folderId}
            active={activeChatId === chat.id}
            onOpenContextMenu={openContextMenu}
            pinnedDraggable={pinnedReorderEnabled && isChatPinnedInFolder(chat, folderId)}
            dragging={draggedPinnedChatId === chat.id}
            dropEdge={pinnedDropTarget?.chatId === chat.id
              ? pinnedDropTarget.edge
              : undefined}
            onSelectChat={selectChatFromClick}
            onOpenLatest={stableOpenLatest}
            onPointerDown={beginPinnedDrag}
            onPointerMove={movePinnedDrag}
            onPointerUp={finishPinnedDrag}
            onPointerCancel={cancelPinnedDrag}
            onLostPointerCapture={cancelPinnedDrag}
          />
        ))
      )}

    </div>
    {active && loadingMore && (
      <div className="chat-list-loading" role="status" aria-label={translate("正在加载更多会话")}>
        <LoaderCircle className="spin" size={17} />
      </div>
    )}
    </>
  );
});

const ChatRow = memo(function ChatRow({
  chat,
  avatarActive,
  preloadAvatar,
  unreadBadgePosition,
  previewSenderName,
  previewConcealed,
  folderId,
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
  avatarActive: boolean;
  preloadAvatar: boolean;
  unreadBadgePosition: UnreadBadgePosition;
  previewSenderName?: string;
  previewConcealed?: boolean;
  folderId: string;
  active: boolean;
  onSelectChat: (chatId: string) => void;
  onOpenLatest?: (chatId: string) => void;
  onOpenContextMenu: (
    chatId: string,
    point: ContextMenuPoint,
    anchor: HTMLButtonElement,
    keyboardNavigation?: boolean,
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
  useTranslation();
  const firstClickWasActiveRef = useRef(active);
  const draft = useTelegramStore((state) => state.drafts.get(chat.id));
  const localAttachmentDraft = useTelegramStore((state) => state.localAttachmentDrafts.get(chat.id));
  const visibleDraft = active ? undefined : listDraft(draft);
  const visibleAttachmentDraft = active ? undefined : localAttachmentDraft;
  const draftPreview = visibleDraft?.text || (visibleDraft?.replyToMessageId ? translate("回复消息") : undefined) ||
    (visibleAttachmentDraft
      ? translate("{{value0}} 个附件", { value0: visibleAttachmentDraft.attachments.length })
      : undefined);
  const hasUnreadAttention = chat.unreadMentionCount > 0;
  const hasUnreadReaction = (chat.unreadReactionCount ?? 0) > 0;
  const displayUnreadCount = chat.unreadCount > 0 ? chat.unreadCount : (chat.unreadReactionCount ?? 0);
  const unreadBadgeClassName = `unread-count ${chat.muted ? "is-muted" : ""} ${hasUnreadAttention ? "has-attention" : ""} ${!hasUnreadAttention && hasUnreadReaction ? "has-reaction" : ""}`;
  const unreadBadgeLabel = hasUnreadAttention
    ? translate("{{value0}} 条未读消息，其中包含提及或回复", { value0: displayUnreadCount })
    : hasUnreadReaction
      ? translate("{{value0}} 条未读消息，其中包含回应", { value0: displayUnreadCount })
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
      onClick={(event) => {
        // A double click still receives two click events. Keep the first one
        // for immediate conversation selection, but let the double-click
        // handler own the explicit latest-message intent.
        if (event.detail <= 1) {
          firstClickWasActiveRef.current = active;
          onSelectChat(chat.id);
        }
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        if (!firstClickWasActiveRef.current) onOpenLatest?.(chat.id);
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
          true,
        );
      }}
      onPointerDown={(event) => pinnedDraggable && onPointerDown(event, chat.id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <span className="chat-avatar-wrap">
        <Avatar avatar={chat.avatar} active={avatarActive} preload={preloadAvatar} />
        {unreadBadgePosition === "avatar" && displayUnreadCount > 0 && (
          <span
            className={`${unreadBadgeClassName} unread-count-avatar`}
            aria-label={unreadBadgeLabel}
            title={hasUnreadAttention ? translate("包含未读的提及或回复") : hasUnreadReaction ? translate("包含未读的回应") : undefined}
          >
            {formatUnreadCount(displayUnreadCount)}
          </span>
        )}
      </span>
      <span className="chat-row-body">
        <span className="chat-row-topline">
          <strong>{chat.title}</strong>
          <time dateTime={chat.updatedAt}>{formatChatTime(chat.updatedAt)}</time>
        </span>
        <span className="chat-row-bottomline">
          <span className={`chat-preview ${draftPreview ? "is-draft" : ""} ${previewConcealed ? "is-local-block-concealed" : ""}`}>
            {draftPreview ? (
              <span className="chat-preview-message">{translate("草稿：")}{draftPreview}</span>
            ) : (
              <>
                <span className="chat-preview-message">
                  {!previewConcealed && previewSenderName && chat.kind === "group" && (
                    <span className="chat-preview-sender">{`${previewSenderName}: `}</span>
                  )}
                  {previewConcealed ? translate("消息已屏蔽") : chat.preview}
                </span>
              </>
            )}
          </span>
          <span className="chat-row-meta">
            {isChatPinnedInFolder(chat, folderId) && <Pin size={13} strokeWidth={2} />}
            {chat.folderIds.includes("archive") && <Archive size={13} strokeWidth={2} />}
            {unreadBadgePosition === "right" && displayUnreadCount > 0 && (
              <span
                className={unreadBadgeClassName}
                aria-label={unreadBadgeLabel}
                title={hasUnreadAttention ? translate("包含未读的提及或回复") : hasUnreadReaction ? translate("包含未读的回应") : undefined}
              >
                {formatUnreadCount(displayUnreadCount)}
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
});
