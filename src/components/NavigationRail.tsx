import { Archive, Bell, Bot, Folder, FolderCog, MessageCircle, Radio, UserRound, Users } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { ChatFilter } from "../store/telegramStore";
import type { Chat, ChatFolder, TelegramAccount, User } from "../telegram/types";
import { AccountSwitcherMenu } from "./AccountSwitcherMenu";
import { Avatar } from "./Avatar";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { FolderContextMenu } from "./SidebarContextMenus";

interface NavigationRailProps {
  filter: ChatFilter;
  folders: ChatFolder[];
  chats: Chat[];
  account?: User;
  accounts: TelegramAccount[];
  activeAccountId: string;
  accountPending: boolean;
  folderManagementPending: boolean;
  onFilterChange: (filter: ChatFilter) => void;
  onManageFolders: () => void;
  onEditFolder: (folderId: string) => void;
  onReorderFolders: (folderIds: string[]) => void;
  onMarkFolderRead: (folderId: string) => Promise<boolean>;
  onRequestDeleteFolder: (folder: ChatFolder) => void;
  onOpenSettings: () => void;
  onAddAccount: () => Promise<boolean>;
  onSwitchAccount: (accountId: string) => Promise<boolean>;
}

export function NavigationRail({
  folders,
  chats,
  account,
  accounts,
  activeAccountId,
  accountPending,
  filter,
  folderManagementPending,
  onFilterChange,
  onManageFolders,
  onEditFolder,
  onReorderFolders,
  onMarkFolderRead,
  onRequestDeleteFolder,
  onOpenSettings,
  onAddAccount,
  onSwitchAccount,
}: NavigationRailProps) {
  const [contextMenu, setContextMenu] = useState<{
    folderId: string;
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
  }>();
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const [accountMenu, setAccountMenu] = useState<{
    point: ContextMenuPoint;
    anchor: HTMLButtonElement;
  }>();
  const closeAccountMenu = useCallback(() => setAccountMenu(undefined), []);
  const [draggedFolderId, setDraggedFolderId] = useState<string>();
  const [folderDropTarget, setFolderDropTarget] = useState<{
    folderId: string;
    edge: "before" | "after";
  }>();
  const folderDragRef = useRef<{
    pointerId: number;
    folderId: string;
    startX: number;
    startY: number;
    moved: boolean;
    element: HTMLButtonElement;
  } | undefined>(undefined);
  const folderDropTargetRef = useRef<typeof folderDropTarget>(undefined);
  const suppressNextFolderClickRef = useRef(false);
  const reorderableFolders = folders.filter((folder) => folder.id !== "archive");
  const reorderableFoldersRef = useRef(reorderableFolders);
  const onReorderFoldersRef = useRef(onReorderFolders);
  reorderableFoldersRef.current = reorderableFolders;
  onReorderFoldersRef.current = onReorderFolders;
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

  const openAccountMenu = (anchor: HTMLButtonElement) => {
    const bounds = anchor.getBoundingClientRect();
    setContextMenu(undefined);
    setAccountMenu({
      point: { x: bounds.right + 4, y: bounds.top },
      anchor,
    });
  };

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

  const setDropTarget = useCallback((target: typeof folderDropTarget) => {
    const current = folderDropTargetRef.current;
    if (current?.folderId === target?.folderId && current?.edge === target?.edge) return;
    folderDropTargetRef.current = target;
    setFolderDropTarget(target);
  }, []);

  const beginFolderDrag = useCallback((
    event: PointerEvent<HTMLButtonElement>,
    folderId: string,
  ) => {
    if (event.button !== 0 || folderManagementPending || reorderableFoldersRef.current.length < 2) {
      return;
    }
    setContextMenu(undefined);
    folderDragRef.current = {
      pointerId: event.pointerId,
      folderId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [folderManagementPending]);

  const moveFolderDrag = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = folderDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 6) return;
      drag.moved = true;
      setDraggedFolderId(drag.folderId);
    }
    event.preventDefault();

    const button = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLButtonElement>(".rail-button[data-folder-id]");
    const folderId = button?.dataset.folderId;
    if (!button || !folderId || folderId === drag.folderId) {
      setDropTarget(undefined);
      return;
    }
    const bounds = button.getBoundingClientRect();
    const horizontal = window.matchMedia("(max-width: 720px)").matches;
    const pointerPosition = horizontal ? event.clientX : event.clientY;
    const midpoint = horizontal
      ? bounds.left + bounds.width / 2
      : bounds.top + bounds.height / 2;
    setDropTarget({ folderId, edge: pointerPosition < midpoint ? "before" : "after" });
  }, [setDropTarget]);

  const finishFolderDrag = useCallback((
    event: PointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const drag = folderDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = folderDropTargetRef.current;
    folderDragRef.current = undefined;

    if (drag.moved) {
      event.preventDefault();
      suppressNextFolderClickRef.current = true;
      globalThis.setTimeout(() => { suppressNextFolderClickRef.current = false; }, 0);
      if (!cancelled && target) {
        const reordered = reorderableFoldersRef.current
          .map((folder) => folder.id)
          .filter((folderId) => folderId !== drag.folderId);
        const targetIndex = reordered.indexOf(target.folderId);
        if (targetIndex >= 0) {
          reordered.splice(targetIndex + (target.edge === "after" ? 1 : 0), 0, drag.folderId);
          onReorderFoldersRef.current(reordered);
        }
      }
    }

    if (drag.element.hasPointerCapture(event.pointerId)) {
      drag.element.releasePointerCapture(event.pointerId);
    }
    setDraggedFolderId(undefined);
    setDropTarget(undefined);
  }, [setDropTarget]);

  const cancelFolderDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => finishFolderDrag(event, true),
    [finishFolderDrag],
  );

  useEffect(() => {
    document.documentElement.classList.toggle("is-reordering-folders", Boolean(draggedFolderId));
    return () => document.documentElement.classList.remove("is-reordering-folders");
  }, [draggedFolderId]);

  return (
    <>
    <nav className="navigation-rail" aria-label="聊天文件夹">
      <button
        className="rail-account"
        type="button"
        aria-label="设置"
        title={`当前账号：${accountName}`}
        onClick={onOpenSettings}
        onContextMenu={(event) => {
          event.preventDefault();
          openAccountMenu(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          openAccountMenu(event.currentTarget);
        }}
      >
        <Avatar avatar={accountAvatar} size="small" />
        <span>{accountName}</span>
      </button>
      <div className="rail-actions">
        {reorderableFolders.map((folder) => (
          <button
            className={`rail-button ${!folderManagementPending && reorderableFolders.length > 1 ? "is-folder-draggable" : ""} ${filter === folder.id ? "is-active" : ""} ${draggedFolderId === folder.id ? "is-dragging" : ""} ${folderDropTarget?.folderId === folder.id ? `drop-${folderDropTarget.edge}` : ""}`}
            data-folder-id={folder.id}
            key={folder.id}
            type="button" aria-label={folder.title} aria-pressed={filter === folder.id} title={folder.title}
            onClick={() => {
              if (!suppressNextFolderClickRef.current) onFilterChange(folder.id);
            }}
            onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              openContextMenu(folder.id, { x: event.clientX, y: event.clientY }, event.currentTarget);
            }}
            onKeyDown={(event) => openFromKeyboard(event, folder.id)}
            onPointerDown={(event) => beginFolderDrag(event, folder.id)}
            onPointerMove={moveFolderDrag}
            onPointerUp={finishFolderDrag}
            onPointerCancel={cancelFolderDrag}>
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
    {accountMenu && (
      <AccountSwitcherMenu
        accounts={accounts}
        activeAccountId={activeAccountId}
        currentAccount={account}
        pending={accountPending}
        point={accountMenu.point}
        restoreFocus={() => accountMenu.anchor.focus()}
        onAdd={onAddAccount}
        onSwitch={onSwitchAccount}
        onClose={closeAccountMenu}
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
