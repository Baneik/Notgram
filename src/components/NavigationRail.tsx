import { translate } from "../i18n";
import { Archive, Bell, Bot, Folder, MessageCircle, Radio, Settings, UserRound, Users } from "lucide-react";
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
import { MotionPresence } from "./MotionPresence";
import { useFlipListMotion } from "../hooks/useFlipListMotion";

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
  onEditFolder: (folderId: string) => void;
  onReorderFolders: (folderIds: string[]) => void;
  onMarkFolderRead: (folderId: string) => Promise<boolean>;
  onRequestDeleteFolder: (folder: ChatFolder) => void;
  onOpenSettings: () => void;
  onAddAccount: () => Promise<boolean>;
  onSwitchAccount: (accountId: string) => Promise<boolean>;
}

const reorderFolderIds = (
  folders: Array<{ id: string }>,
  draggedId: string,
  target: { folderId: string; edge: "before" | "after" },
) => {
  const reordered = folders.map((folder) => folder.id).filter((id) => id !== draggedId);
  const targetIndex = reordered.indexOf(target.folderId);
  if (targetIndex < 0) return reordered;
  reordered.splice(targetIndex + (target.edge === "after" ? 1 : 0), 0, draggedId);
  return reordered;
};

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
    keyboardNavigation: boolean;
  }>();
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const [accountMenu, setAccountMenu] = useState<{
    anchor: HTMLButtonElement;
  }>();
  const closeAccountMenu = useCallback(() => setAccountMenu(undefined), []);
  const accountSwitcherRef = useRef<HTMLDivElement>(null);
  const railActionsRef = useRef<HTMLDivElement>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string>();
  const [dragPreviewOrder, setDragPreviewOrder] = useState<string[]>();
  const dragPreviewOrderRef = useRef<string[] | undefined>(undefined);
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
  const displayFolders = dragPreviewOrder
    ? dragPreviewOrder.map((id) => reorderableFolders.find((folder) => folder.id === id)).filter((folder): folder is typeof reorderableFolders[number] => Boolean(folder))
    : reorderableFolders;
  useFlipListMotion({
    containerRef: railActionsRef,
    itemSelector: ".rail-button[data-motion-key]",
    dependencies: [displayFolders.map((folder) => folder.id).join(",")],
  });
  const reorderableFoldersRef = useRef(reorderableFolders);
  const onReorderFoldersRef = useRef(onReorderFolders);
  reorderableFoldersRef.current = reorderableFolders;
  dragPreviewOrderRef.current = dragPreviewOrder;
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
    keyboardNavigation = false,
  ) => setContextMenu({ folderId, point, anchor, keyboardNavigation });

  const openAccountMenu = (anchor: HTMLButtonElement) => {
    setContextMenu(undefined);
    dragPreviewOrderRef.current = undefined;
    setDragPreviewOrder(undefined);
    setAccountMenu((current) => current ? undefined : { anchor });
  };

  useEffect(() => {
    if (!accountMenu) return;
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !accountSwitcherRef.current?.contains(target)) {
        closeAccountMenu();
      }
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAccountMenu();
      globalThis.setTimeout(() => accountMenu.anchor.focus(), 0);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [accountMenu, closeAccountMenu]);

  useEffect(() => {
    if (!accountPending) return;
    closeContextMenu();
    closeAccountMenu();
    setDraggedFolderId(undefined);
    dragPreviewOrderRef.current = undefined;
    setDragPreviewOrder(undefined);
    folderDropTargetRef.current = undefined;
    setFolderDropTarget(undefined);
  }, [accountPending, closeAccountMenu, closeContextMenu]);

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
      true,
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
    const nextPreview = reorderFolderIds(reorderableFoldersRef.current, drag.folderId, { folderId, edge: pointerPosition < midpoint ? "before" : "after" });
    if (nextPreview.join(",") !== (dragPreviewOrderRef.current ?? reorderableFoldersRef.current.map((folder) => folder.id)).join(",")) {
      dragPreviewOrderRef.current = nextPreview;
      setDragPreviewOrder(nextPreview);
    }
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
        const reordered = dragPreviewOrderRef.current ?? reorderFolderIds(reorderableFoldersRef.current, drag.folderId, target);
        onReorderFoldersRef.current(reordered);
      }
    }

    if (drag.element.hasPointerCapture(event.pointerId)) {
      drag.element.releasePointerCapture(event.pointerId);
    }
    setDraggedFolderId(undefined);
    dragPreviewOrderRef.current = undefined;
    setDragPreviewOrder(undefined);
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
    <nav className="navigation-rail" aria-label={translate("聊天文件夹")}>
      <div ref={accountSwitcherRef} className={`rail-account-switcher ${accountMenu ? "is-open" : ""}`}>
        <button
          className="rail-account"
          type="button"
          aria-label={translate("切换账号")}
          aria-expanded={Boolean(accountMenu)}
          title={translate("当前账号：{{value0}}", { value0: accountName })}
          onClick={(event) => openAccountMenu(event.currentTarget)}
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
        <MotionPresence present={Boolean(accountMenu)} variant="popover">
          <AccountSwitcherMenu
            accounts={accounts}
            activeAccountId={activeAccountId}
            currentAccount={account}
            pending={accountPending}
            onAdd={onAddAccount}
            onSwitch={onSwitchAccount}
            onClose={closeAccountMenu}
          />
        </MotionPresence>
      </div>
      <div ref={railActionsRef} className="rail-actions">
        {displayFolders.map((folder) => (
          <button
            className={`rail-button ${!folderManagementPending && reorderableFolders.length > 1 ? "is-folder-draggable" : ""} ${filter === folder.id ? "is-active" : ""} ${draggedFolderId === folder.id ? "is-dragging" : ""} ${folderDropTarget?.folderId === folder.id ? `drop-${folderDropTarget.edge}` : ""}`}
            data-folder-id={folder.id}
            data-motion-key={folder.id}
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
      </div>
      <div className="rail-footer">
        <button className="rail-button rail-settings" type="button" aria-label={translate("设置")} title={translate("设置")} onClick={onOpenSettings}>
          <span className="rail-icon"><Settings size={23} strokeWidth={1.8} /></span><span>{translate("设置")}</span>
        </button>
      </div>
    </nav>
    {contextMenu && contextFolder && (
      <FolderContextMenu
        folder={contextFolder}
        point={contextMenu.point}
        keyboardNavigation={contextMenu.keyboardNavigation}
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
