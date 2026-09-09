import { translate } from "../i18n";
import { Archive, Bell, Bot, Folder, MessageCircle, Radio, Settings, UserRound, Users } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ChatFilter } from "../store/telegramStore";
import type { Chat, ChatFolder, TelegramAccount, User } from "../telegram/types";
import { AccountSwitcherMenu } from "./AccountSwitcherMenu";
import { Avatar } from "./Avatar";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { FolderContextMenu } from "./SidebarContextMenus";
import { MotionPresence } from "./MotionPresence";
import { useFlipListMotion } from "../hooks/useFlipListMotion";
import { useFolderReorder } from "../hooks/useFolderReorder";

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
  const reorderableFolders = folders.filter((folder) => folder.id !== "archive");
  const folderDrag = useFolderReorder({
    containerRef: railActionsRef,
    folderIds: reorderableFolders.map((folder) => folder.id),
    disabled: folderManagementPending || accountPending,
    accountId: activeAccountId,
    onReorder: onReorderFolders,
  });
  const byId = new Map(reorderableFolders.map((folder) => [folder.id, folder]));
  const displayFolders = folderDrag.preview
    ? folderDrag.preview.order.map((id) => byId.get(id)).filter((folder): folder is ChatFolder => Boolean(folder))
    : reorderableFolders;
  useFlipListMotion({
    containerRef: railActionsRef,
    itemSelector: ".rail-button[data-motion-key]",
    dependencies: [displayFolders.map((folder) => folder.id).join(",")],
    resetKey: activeAccountId,
  });
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
  ) => {
    folderDrag.cancel();
    setContextMenu({ folderId, point, anchor, keyboardNavigation });
  };

  const openAccountMenu = (anchor: HTMLButtonElement) => {
    setContextMenu(undefined);
    folderDrag.cancel();
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
      <div ref={railActionsRef} className="rail-actions" onClickCapture={folderDrag.suppressClick}>
        {displayFolders.map((folder) => (
          <button
            className={`rail-button ${!folderManagementPending && !accountPending && reorderableFolders.length > 1 ? "is-folder-draggable" : ""} ${filter === folder.id ? "is-active" : ""} ${folderDrag.preview?.folderId === folder.id ? "is-dragging" : ""}`}
            data-folder-id={folder.id}
            data-motion-key={folder.id}
            key={folder.id}
            type="button" aria-label={folder.title} aria-pressed={filter === folder.id} title={folder.title}
            onClick={() => {
              onFilterChange(folder.id);
            }}
            onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              openContextMenu(folder.id, { x: event.clientX, y: event.clientY }, event.currentTarget);
            }}
            onKeyDown={(event) => openFromKeyboard(event, folder.id)}
            onPointerDown={(event) => {
              setContextMenu(undefined);
              folderDrag.begin(event, folder.id);
            }}>
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
