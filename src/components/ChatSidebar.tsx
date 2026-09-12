import { translate } from "../i18n";
import { Plus, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { GlobalSearchState } from "../store/globalSearchState";
import type { Chat, ChatFolder, GlobalSearchFilter, User } from "../telegram/types";
import type { ChatMessageSearchState } from "../store/chatMessageSearchState";
import type { SidebarSearchScope } from "../hooks/useSidebarSearch";
import { groupChatsByFolder } from "../store/telegramStore.selectors";
import { Avatar } from "./Avatar";
import { ChatSearchResults, GlobalSearchResults, type SidebarSearchSenderOption } from "./GlobalSearchView";
import { ChatContextMenu } from "./SidebarContextMenus";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { usePreferencesStore } from "../store/preferencesStore";
import { useLocalUserBlocks } from "../store/localUserBlocks";
import { useFolderListWarmup } from "../hooks/useFolderListWarmup";
import { ChatFolderList } from "./ChatFolderList";

interface ChatSidebarProps {
  allChats: Map<string, Chat>;
  users: Map<string, User>;
  accountId: string;
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
  onOpenLatest?: (chatId: string) => void;
  onLoadMore: (folderId: string) => Promise<void>;
  onReorderPinned: (folderId: string, chatIds: string[]) => void;
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

export function ChatSidebar({
  allChats,
  users,
  accountId,
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
  onOpenLatest,
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
  const localBlockedUsers = useLocalUserBlocks((state) => state.users);
  const localBlockedUserIds = useMemo(() => new Set(
    localBlockedUsers
      .filter((user) => user.accountId === accountId)
      .map((user) => user.userId),
  ), [accountId, localBlockedUsers]);
  const sidebarRef = useRef<HTMLElement>(null);
  const chatListScrollTopByFolderRef = useRef(new Map<string, number>());
  const resizeStartRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const pendingResizeWidthRef = useRef(width);
  const [resizing, setResizing] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    folderId: string;
    chatId: string;
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
    keyboardNavigation: boolean;
  }>();

  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const openContextMenu = useCallback((
    chatId: string,
    point: ContextMenuPoint,
    anchor: HTMLButtonElement,
    keyboardNavigation = false,
  ) => {
    setContextMenu({ folderId, chatId, point, anchor, keyboardNavigation });
  }, [folderId]);

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

  useLayoutEffect(() => {
    setContextMenu(undefined);
  }, [folderId, searchQuery, searchScope.type, mobileViewport, mobileChatOpen]);

  useLayoutEffect(() => {
    const ids = new Set(folders.map((folder) => folder.id));
    for (const id of chatListScrollTopByFolderRef.current.keys()) {
      if (!ids.has(id)) chatListScrollTopByFolderRef.current.delete(id);
    }
  }, [folders]);

  const chatsByFolder = useMemo(() => groupChatsByFolder(allChats.values(), folders), [allChats, folders]);
  useFolderListWarmup(accountId, folders);
  const saveScrollPosition = useCallback((id: string, top: number) => {
    chatListScrollTopByFolderRef.current.set(id, top);
  }, []);
  const contextChat = contextMenu ? allChats.get(contextMenu.chatId) : undefined;
  const scopedChat = searchScope.type === "chat" ? allChats.get(searchScope.chatId) : undefined;
  const scopedSearch = Boolean(scopedChat);

  return (
    <>
    <aside
      ref={sidebarRef}
      className={`chat-sidebar ${scopedSearch ? "has-scoped-search" : ""} ${resizing ? "is-resizing" : ""}`}
      aria-label={translate("会话列表")}
      aria-hidden={mobileViewport && mobileChatOpen ? true : undefined}
      inert={mobileViewport && mobileChatOpen ? true : undefined}
    >
      <div className="sidebar-heading">
        <div>
          <h1>{folderTitle}</h1>
        </div>
        <button className="icon-button" type="button" aria-label={translate("新建群组或频道")} title={translate("新建群组或频道")} onClick={onCreateChat}>
          <Plus size={20} strokeWidth={1.9} />
        </button>
      </div>

      <label className="search-field">
        <Search size={17} strokeWidth={1.8} />
        <span className="sr-only">{translate("搜索会话和消息")}</span>
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (scopedSearch) onExitSearchScope(false);
            else onSearchChange("");
          }}
          placeholder={translate("搜索会话和消息")}
          type="search"
        />
        {searchQuery && (
          <button
            type="button"
            className="clear-search"
            aria-label={translate("清除搜索")}
            title={translate("清除搜索")}
            onClick={() => onSearchChange("")}
          >
            ×
          </button>
        )}
      </label>

      {scopedChat && (
        <div className="sidebar-search-scope" role="group" aria-label={translate("搜索范围：{{value0}}", { value0: scopedChat.title })}>
          <Avatar avatar={scopedChat.avatar} size="small" />
          <span>{translate("此会话：")}{scopedChat.title}</span>
          <button type="button" className="icon-button" aria-label={translate("移除会话搜索范围")} title={translate("移除会话搜索范围")} onClick={() => onExitSearchScope(true)}>
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>
      )}

      <div className="sidebar-list-stack">
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
      ) : null}
      {folders.filter((folder) => folder.id !== "main" || (folderId === "main" && !scopedSearch && !searchQuery.trim())).map((folder) => (
        <ChatFolderList
          key={folder.id}
          chats={chatsByFolder.get(folder.id)!}
          allChats={allChats}
          users={users}
          folderId={folder.id}
          active={folder.id === folderId && !scopedSearch && !searchQuery.trim() && !(mobileViewport && mobileChatOpen)}
          activeChatId={activeChatId}
          unreadBadgePosition={unreadBadgePosition}
          localBlockedUserIds={localBlockedUserIds}
          initialScrollTop={chatListScrollTopByFolderRef.current.get(folder.id)}
          onScrollPosition={saveScrollPosition}
          onSelect={onSelect}
          onOpenLatest={onOpenLatest}
          onOpenContextMenu={openContextMenu}
          onLoadMore={onLoadMore}
          onReorderPinned={onReorderPinned}
        />
      ))}
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label={translate("调整会话列表宽度")}
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={maximumWidth()}
        aria-valuenow={Math.round(Math.min(maximumWidth(), Math.max(
          MIN_SIDEBAR_WIDTH,
          sidebarRef.current?.getBoundingClientRect().width ?? width,
        )))}
        tabIndex={0}
        title={translate("拖动调整会话列表宽度")}
        onDoubleClick={() => commitWidth(344)}
        onKeyDown={handleResizeKey}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      />
    </aside>
    {contextMenu && contextMenu.folderId === folderId && contextChat && contextChat.folderIds.includes(folderId) && !searchQuery.trim() && !scopedSearch && !(mobileViewport && mobileChatOpen) && (
      <ChatContextMenu
        chat={contextChat}
        chatListId={folderId}
        folders={folders}
        point={contextMenu.point}
        keyboardNavigation={contextMenu.keyboardNavigation}
        chatPending={chatManagementPending.has(contextChat.id)}
        folderPending={folderManagementPending}
        restoreFocus={() => {
          if (contextMenu.anchor.closest('.chat-list[data-active="true"]')) contextMenu.anchor.focus({ preventScroll: true });
        }}
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
