import { Archive, Bell, Bot, Folder, FolderCog, MessageCircle, Radio, UserRound, Users } from "lucide-react";
import { useCallback, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ChatFilter } from "../store/telegramStore";
import type { Chat, ChatFolder } from "../telegram/types";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { FolderContextMenu } from "./SidebarContextMenus";

interface NavigationRailProps {
  filter: ChatFilter;
  folders: ChatFolder[];
  chats: Chat[];
  folderManagementPending: boolean;
  onFilterChange: (filter: ChatFilter) => void;
  onManageFolders: () => void;
  onEditFolder: (folderId: string) => void;
  onMarkFolderRead: (folderId: string) => Promise<boolean>;
  onRequestDeleteFolder: (folder: ChatFolder) => void;
  onOpenSettings: () => void;
}

export function NavigationRail({
  folders,
  chats,
  filter,
  folderManagementPending,
  onFilterChange,
  onManageFolders,
  onEditFolder,
  onMarkFolderRead,
  onRequestDeleteFolder,
  onOpenSettings,
}: NavigationRailProps) {
  const [contextMenu, setContextMenu] = useState<{
    folderId: string;
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
  }>();
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const contextFolder = contextMenu
    ? folders.find((folder) => folder.id === contextMenu.folderId)
    : undefined;

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
        className="rail-brand"
        type="button"
        aria-label="设置"
        title="设置"
        onClick={onOpenSettings}
      >
        <span className="brand-mark">N</span><span>Notgram</span>
      </button>
      <div className="rail-actions">
        {folders.map((folder) => (
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
