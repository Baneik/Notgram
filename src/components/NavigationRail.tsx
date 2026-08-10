import { Archive, ArrowLeft, ArrowRight, Bell, Bot, Folder, FolderCog, MessageCircle, Radio, UserRound, Users } from "lucide-react";
import { useCallback, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ChatFilter } from "../store/telegramStore";
import type { Chat, ChatFolder, User } from "../telegram/types";
import { Avatar } from "./Avatar";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { FolderContextMenu } from "./SidebarContextMenus";
import {
  useConversationNavigationState,
  type ConversationNavigation,
} from "../hooks/useConversationNavigation";

interface NavigationRailProps {
  filter: ChatFilter;
  folders: ChatFolder[];
  chats: Chat[];
  account?: User;
  folderManagementPending: boolean;
  onFilterChange: (filter: ChatFilter) => void;
  onManageFolders: () => void;
  onEditFolder: (folderId: string) => void;
  onMarkFolderRead: (folderId: string) => Promise<boolean>;
  onRequestDeleteFolder: (folder: ChatFolder) => void;
  onOpenSettings: () => void;
  conversationNavigation: ConversationNavigation;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}

export function NavigationRail({
  folders,
  chats,
  account,
  filter,
  folderManagementPending,
  onFilterChange,
  onManageFolders,
  onEditFolder,
  onMarkFolderRead,
  onRequestDeleteFolder,
  onOpenSettings,
  conversationNavigation,
  onNavigateBack,
  onNavigateForward,
}: NavigationRailProps) {
  const { canGoBack, canGoForward } = useConversationNavigationState(conversationNavigation);
  const [contextMenu, setContextMenu] = useState<{
    folderId: string;
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
  }>();
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const contextFolder = contextMenu
    ? folders.find((folder) => folder.id === contextMenu.folderId)
    : undefined;
  const accountName = account?.displayName ?? "Telegram";
  const accountAvatar = account?.avatar ?? { label: "T", color: "#3390ec" };

  const openContextMenu = (
    folderId: string,
    point: ContextMenuPoint,
    anchor: HTMLButtonElement,
  ) => setContextMenu({ folderId, point, anchor });

  const openFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    folderId: string,
  ) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    openContextMenu(
      folderId,
      { x: bounds.right - 4, y: bounds.top + bounds.height / 2 },
      event.currentTarget,
    );
  };

  return (
    <>
    <nav className="navigation-rail" aria-label="聊天文件夹">
      <button
        className="rail-account"
        type="button"
        aria-label="设置"
        title={`当前账号：${accountName}`}
        onClick={onOpenSettings}
      >
        <Avatar avatar={accountAvatar} size="small" />
        <span>{accountName}</span>
      </button>
      <div className="rail-navigation" aria-label="会话导航">
        <button
          className="rail-navigation-button"
          type="button"
          aria-label="后退"
          title="后退"
          disabled={!canGoBack}
          onClick={onNavigateBack}
        >
          <ArrowLeft size={18} strokeWidth={1.9} />
        </button>
        <button
          className="rail-navigation-button"
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!canGoForward}
          onClick={onNavigateForward}
        >
          <ArrowRight size={18} strokeWidth={1.9} />
        </button>
      </div>
      <div className="rail-actions">
        {folders.filter((folder) => folder.id !== "archive").map((folder) => (
          <button className={`rail-button ${filter === folder.id ? "is-active" : ""}`} key={folder.id}
            type="button" aria-label={folder.title} aria-pressed={filter === folder.id} title={folder.title}
            onClick={() => onFilterChange(folder.id)}
            onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              openContextMenu(folder.id, { x: event.clientX, y: event.clientY }, event.currentTarget);
            }}
            onKeyDown={(event) => openFromKeyboard(event, folder.id)}>
            <span className="rail-icon"><FolderIcon name={folder.iconName} /></span><span>{folder.title}</span>
          </button>
        ))}
        <button className="rail-button" type="button" aria-label="管理文件夹" title="管理文件夹" onClick={onManageFolders}>
          <span className="rail-icon"><FolderCog size={23} strokeWidth={1.8} /></span><span>管理</span>
        </button>
      </div>
    </nav>
    {contextMenu && contextFolder && (
      <FolderContextMenu
        folder={contextFolder}
        point={contextMenu.point}
        unreadCount={chats
          .filter((chat) => chat.folderIds.includes(contextFolder.id))
          .reduce((count, chat) => count + chat.unreadCount, 0)}
        pending={folderManagementPending}
        restoreFocus={() => contextMenu.anchor.focus()}
        onEdit={() => onEditFolder(contextFolder.id)}
        onMarkRead={() => onMarkFolderRead(contextFolder.id)}
        onRequestDelete={() => onRequestDeleteFolder(contextFolder)}
        onClose={closeContextMenu}
      />
    )}
    </>
  );
}

function FolderIcon({ name }: { name: string }) {
  const props = { size: 23, strokeWidth: 1.8 };
  switch (name) {
    case "All": return <MessageCircle {...props} />;
    case "Archive": return <Archive {...props} />;
    case "Unread": return <Bell {...props} />;
    case "Bots": return <Bot {...props} />;
    case "Channels": return <Radio {...props} />;
    case "Groups": return <Users {...props} />;
    case "Private": return <UserRound {...props} />;
    default: return <Folder {...props} />;
  }
}
