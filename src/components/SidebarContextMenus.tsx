import {
  Check,
  CheckCircle2,
  ChevronRight,
  Folder,
  FolderInput,
  LoaderCircle,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { isChatPinnedInFolder } from "../store/telegramStore.selectors";
import type { Chat, ChatFolder } from "../telegram/types";
import {
  ContextMenuPanel,
  ContextMenuSurface,
  type ContextMenuPoint,
} from "./ContextMenuSurface";

interface ChatContextMenuProps {
  chat: Chat;
  chatListId: string;
  folders: ChatFolder[];
  point: ContextMenuPoint;
  chatPending: boolean;
  folderPending: boolean;
  restoreFocus: () => void;
  onSetPinned: (pinned: boolean) => Promise<boolean>;
  onSetFolderMembership: (folderId: string, included: boolean) => Promise<boolean>;
  onRequestLeave: () => void;
  onClose: () => void;
}

export function ChatContextMenu({
  chat,
  chatListId,
  folders,
  point,
  chatPending,
  folderPending,
  restoreFocus,
  onSetPinned,
  onSetFolderMembership,
  onRequestLeave,
  onClose,
}: ChatContextMenuProps) {
  const customFolders = folders.filter((folder) => folder.id.startsWith("folder:"));
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [action, setAction] = useState<string>();
  const pinned = isChatPinnedInFolder(chat, chatListId);
  const busy = chatPending || folderPending || Boolean(action);

  const run = async (key: string, operation: () => Promise<boolean>) => {
    if (busy) return;
    setAction(key);
    const succeeded = await operation();
    if (succeeded) onClose();
    else setAction(undefined);
  };

  const openFoldersFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" || customFolders.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setFoldersOpen(true);
    globalThis.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(".chat-folder-submenu button:not([disabled])")?.focus();
    }, 0);
  };

  return (
    <ContextMenuSurface
      label={`会话操作：${chat.title}`}
      point={point}
      restoreFocus={restoreFocus}
      onClose={onClose}
    >
      <ContextMenuPanel>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={foldersOpen}
          disabled={busy || customFolders.length === 0}
          onMouseEnter={() => setFoldersOpen(true)}
          onKeyDown={openFoldersFromKeyboard}
          onClick={() => setFoldersOpen(true)}
        >
          <FolderInput size={17} strokeWidth={1.9} />
          <span>分组</span>
          <ChevronRight className="context-menu-chevron" size={16} />
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => void run("pin", () => onSetPinned(!pinned))}
        >
          {action === "pin"
            ? <LoaderCircle className="spin" size={17} />
            : pinned
              ? <PinOff size={17} strokeWidth={1.9} />
              : <Pin size={17} strokeWidth={1.9} />}
          <span>{pinned ? "取消置顶" : "置顶"}</span>
        </button>
        {chat.kind === "group" && (
          <button
            className="is-danger"
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              onClose();
              onRequestLeave();
            }}
          >
            <LogOut size={17} strokeWidth={1.9} />
            <span>退出群组</span>
          </button>
        )}
      </ContextMenuPanel>
      {foldersOpen && (
        <ContextMenuPanel submenu className="chat-folder-submenu" role="menu" aria-label="选择分组">
          {customFolders.map((folder) => {
            const included = chat.folderIds.includes(folder.id);
            const key = `folder:${folder.id}`;
            return (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={included}
                aria-label={`${included ? "从" : "添加到"}${folder.title}`}
                disabled={busy}
                key={folder.id}
                onClick={() => void run(
                  key,
                  () => onSetFolderMembership(folder.id, !included),
                )}
              >
                {action === key
                  ? <LoaderCircle className="spin" size={17} />
                  : included
                    ? <Check size={17} strokeWidth={2.1} />
                    : <Folder size={17} strokeWidth={1.9} />}
                <span>{folder.title}</span>
              </button>
            );
          })}
        </ContextMenuPanel>
      )}
    </ContextMenuSurface>
  );
}

interface FolderContextMenuProps {
  folder: ChatFolder;
  point: ContextMenuPoint;
  unreadCount: number;
  pending: boolean;
  restoreFocus: () => void;
  onEdit: () => void;
  onMarkRead: () => Promise<boolean>;
  onRequestDelete: () => void;
  onClose: () => void;
}

export function FolderContextMenu({
  folder,
  point,
  unreadCount,
  pending,
  restoreFocus,
  onEdit,
  onMarkRead,
  onRequestDelete,
  onClose,
}: FolderContextMenuProps) {
  const [markingRead, setMarkingRead] = useState(false);
  const custom = folder.id.startsWith("folder:");
  const busy = pending || markingRead;

  const markRead = async () => {
    if (busy || unreadCount === 0) return;
    setMarkingRead(true);
    if (await onMarkRead()) onClose();
    else setMarkingRead(false);
  };

  return (
    <ContextMenuSurface
      label={`分组操作：${folder.title}`}
      point={point}
      restoreFocus={restoreFocus}
      onClose={onClose}
    >
      <ContextMenuPanel>
        {custom && (
          <button type="button" role="menuitem" disabled={busy} onClick={() => {
            onClose();
            onEdit();
          }}>
            <Pencil size={17} strokeWidth={1.9} />
            <span>编辑文件夹</span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          disabled={busy || unreadCount === 0}
          title={unreadCount === 0 ? "该分组没有未读会话" : undefined}
          onClick={() => void markRead()}
        >
          {markingRead
            ? <LoaderCircle className="spin" size={17} />
            : <CheckCircle2 size={17} strokeWidth={1.9} />}
          <span>标记为已读</span>
        </button>
        {custom && (
          <button className="is-danger" type="button" role="menuitem" disabled={busy} onClick={() => {
            onClose();
            onRequestDelete();
          }}>
            <Trash2 size={17} strokeWidth={1.9} />
            <span>删除</span>
          </button>
        )}
      </ContextMenuPanel>
    </ContextMenuSurface>
  );
}
