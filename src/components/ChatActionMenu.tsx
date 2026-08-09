import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Clock3,
  LoaderCircle,
  Pin,
  PinOff,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Chat } from "../telegram/types";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";

interface ChatActionMenuProps {
  chat: Chat;
  chatListId: string;
  pending: boolean;
  onSetPinned: (pinned: boolean) => Promise<boolean>;
  onSetMuted: (muted: boolean) => Promise<boolean>;
  onSetArchived: (archived: boolean) => Promise<boolean>;
  onOpenPinned: () => void;
  onOpenMessageSearch: () => void;
  onOpenAutoDelete: () => void;
  onClose: () => void;
}

type ChatAction = "pin" | "mute" | "archive";

export function ChatActionMenu({
  chat,
  chatListId,
  pending,
  onSetPinned,
  onSetMuted,
  onSetArchived,
  onOpenPinned,
  onOpenMessageSearch,
  onOpenAutoDelete,
  onClose,
}: ChatActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<ChatAction>();
  const pinned = chat.pinnedFolderIds === undefined
    ? chat.pinned
    : chat.pinnedFolderIds.includes(chatListId);
  const archived = chat.folderIds.includes("archive");
  const busy = pending || Boolean(action);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => focusFirstMenuButton(menuRef.current), 0);
    return () => globalThis.clearTimeout(timer);
  }, []);

  const run = async (nextAction: ChatAction, operation: () => Promise<boolean>) => {
    if (busy) return;
    setAction(nextAction);
    const succeeded = await operation();
    setAction(undefined);
    if (succeeded) onClose();
  };

  const icon = (item: ChatAction, fallback: React.ReactNode) =>
    action === item ? <LoaderCircle className="spin" size={16} /> : fallback;

  return (
    <div
      ref={menuRef}
      className="chat-action-menu"
      role="menu"
      aria-label="会话操作"
      aria-busy={busy}
      tabIndex={-1}
      onKeyDown={(event) => handleMenuKeyboard(event, onClose)}
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => void run("pin", () => onSetPinned(!pinned))}
      >
        {icon("pin", pinned
          ? <PinOff size={16} strokeWidth={1.9} />
          : <Pin size={16} strokeWidth={1.9} />)}
        <span>{pinned ? "取消置顶" : "置顶会话"}</span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onOpenPinned}>
        <Pin size={16} strokeWidth={1.9} />
        <span>查看置顶消息</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => {
          onClose();
          onOpenMessageSearch();
        }}
      >
        <Search size={16} strokeWidth={1.9} />
        <span>搜索消息</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || chat.kind === "saved"}
        title={chat.kind === "saved" ? "收藏夹不支持自动删除" : undefined}
        onClick={onOpenAutoDelete}
      >
        <Clock3 size={16} strokeWidth={1.9} />
        <span>自动删除消息</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || chat.kind === "saved"}
        title={chat.kind === "saved" ? "收藏夹不支持静音" : undefined}
        onClick={() => void run("mute", () => onSetMuted(!chat.muted))}
      >
        {icon("mute", chat.muted
          ? <Bell size={16} strokeWidth={1.9} />
          : <BellOff size={16} strokeWidth={1.9} />)}
        <span>{chat.muted ? "取消静音" : "静音通知"}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => void run("archive", () => onSetArchived(!archived))}
      >
        {icon("archive", archived
          ? <ArchiveRestore size={16} strokeWidth={1.9} />
          : <Archive size={16} strokeWidth={1.9} />)}
        <span>{archived ? "移出归档" : "归档会话"}</span>
      </button>
    </div>
  );
}
