import {
  AlertCircle,
  Copy,
  ChevronLeft,
  Download,
  Edit3,
  Forward,
  LoaderCircle,
  PictureInPicture2,
  Reply,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useContextMenuDismiss } from "../hooks/useContextMenuDismiss";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Chat, Message } from "../telegram/types";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";
import { Avatar } from "./Avatar";
import { messageSummary } from "./conversationMessages";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "👏", "😮"];

interface MessageActionMenuProps {
  position: { left: number; top: number };
  message: Message;
  loading: boolean;
  onReaction: (emoji: string, chosen: boolean) => void;
  onReply: () => void;
  onEdit: () => void;
  onForward: () => void;
  onDelete: () => void;
  onPlayInWindow?: () => void;
  onDownloadVideo?: () => void;
  onCopyRaw?: () => void;
  onDismiss: () => void;
  onClose: () => void;
}

export function MessageActionMenu({
  position,
  message,
  loading,
  onReaction,
  onReply,
  onEdit,
  onForward,
  onDelete,
  onPlayInWindow,
  onDownloadVideo,
  onCopyRaw,
  onDismiss,
  onClose,
}: MessageActionMenuProps) {
  const permissions = message.permissions;
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuDismiss(menuRef, onDismiss);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (!focusFirstMenuButton(menuRef.current)) menuRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [permissions]);
  return (
    <div
      ref={menuRef}
      className="message-action-menu"
      role="menu"
      aria-label="消息操作"
      tabIndex={-1}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyboard(event, onClose)}
    >
      {onPlayInWindow && (
        <button type="button" role="menuitem" onClick={onPlayInWindow}>
          <PictureInPicture2 size={16} strokeWidth={1.9} />
          <span>以小窗播放</span>
        </button>
      )}
      {onDownloadVideo && (
        <button type="button" role="menuitem" onClick={onDownloadVideo}>
          <Download size={16} strokeWidth={1.9} />
          <span>下载视频</span>
        </button>
      )}
      {onCopyRaw && (
        <button type="button" role="menuitem" onClick={onCopyRaw}>
          <Copy size={16} strokeWidth={1.9} />
          <span>复制原始消息</span>
        </button>
      )}
      {!permissions ? (
        <div className="message-action-status" role="status">
          {loading ? (
            <><LoaderCircle className="spin" size={15} />正在读取操作权限</>
          ) : (
            <><AlertCircle size={15} />无法读取操作权限</>
          )}
        </div>
      ) : (
        <>
          <div className="message-action-reactions" role="group" aria-label="表情回应">
            {QUICK_REACTIONS.map((emoji) => {
              const existing = message.interaction?.reactions.find(
                (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
              );
              return (
                <button
                  type="button"
                  key={emoji}
                  aria-label={`回应 ${emoji}`}
                  className={existing?.chosen ? "is-chosen" : ""}
                  onClick={() => onReaction(emoji, !existing?.chosen)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          {permissions.canReply && (
            <button type="button" role="menuitem" onClick={onReply}>
              <Reply size={16} strokeWidth={1.9} />
              <span>回复</span>
            </button>
          )}
          {permissions.canEdit && message.content.kind === "text" && (
            <button type="button" role="menuitem" onClick={onEdit}>
              <Edit3 size={16} strokeWidth={1.9} />
              <span>编辑</span>
            </button>
          )}
          {permissions.canForward && (
            <button type="button" role="menuitem" onClick={onForward}>
              <Forward size={16} strokeWidth={1.9} />
              <span>转发</span>
            </button>
          )}
          {(permissions.canDeleteOnlyForSelf || permissions.canDeleteForAllUsers) && (
            <button className="is-danger" type="button" role="menuitem" onClick={onDelete}>
              <Trash2 size={16} strokeWidth={1.9} />
              <span>删除</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

interface DeleteMessageDialogProps {
  message: Message;
  pending: boolean;
  onConfirm: (revoke: boolean) => void;
  onClose: () => void;
}

export function DeleteMessageDialog({
  message,
  pending,
  onConfirm,
  onClose,
}: DeleteMessageDialogProps) {
  const permissions = message.permissions;
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending);
  if (!permissions) return null;
  return (
    <div className="message-delete-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="message-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-delete-title"
        tabIndex={-1}
      >
        <div className="message-delete-heading">
          <span><Trash2 size={18} strokeWidth={1.9} /></span>
          <div>
            <h3 id="message-delete-title">删除消息</h3>
            <p>{messageSummary(message.content)}</p>
          </div>
        </div>
        <div className="message-delete-actions">
          {permissions.canDeleteOnlyForSelf && (
            <button
              className="dialog-secondary"
              type="button"
              disabled={pending}
              onClick={() => onConfirm(false)}
            >
              仅对我删除
            </button>
          )}
          {permissions.canDeleteForAllUsers && (
            <button
              className="dialog-danger"
              type="button"
              disabled={pending}
              onClick={() => onConfirm(true)}
            >
              {pending ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              为所有人删除
            </button>
          )}
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}

interface ForwardMessagesDialogProps {
  selectedCount: number;
  targets: Chat[];
  currentChatId: string;
  query: string;
  pending: boolean;
  pendingTargetId?: string;
  onQueryChange: (query: string) => void;
  onConfirm: (target: Chat) => void;
  onClose: () => void;
}

export function ForwardMessagesDialog({
  selectedCount,
  targets,
  currentChatId,
  query,
  pending,
  pendingTargetId,
  onQueryChange,
  onConfirm,
  onClose,
}: ForwardMessagesDialogProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending, searchRef);
  return (
    <div
      className="message-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="message-forward-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-forward-title"
        tabIndex={-1}
      >
        <header className="message-forward-heading">
          <span className="message-forward-heading-icon">
            <Forward size={18} strokeWidth={1.9} />
          </span>
          <div>
            <h3 id="message-forward-title">转发 {selectedCount} 条消息</h3>
            <p>选择目标会话</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭转发"
            title="关闭"
            disabled={pending}
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.9} />
          </button>
        </header>
        <label className="forward-target-search">
          <Search size={16} strokeWidth={1.8} />
          <span className="sr-only">搜索目标会话</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索会话"
            type="search"
            disabled={pending}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              event.currentTarget.closest(".message-forward-dialog")
                ?.querySelector<HTMLButtonElement>(".forward-target-row:not([disabled])")
                ?.focus();
            }}
          />
        </label>
        <div
          className="forward-target-list"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".forward-target-row:not([disabled])",
            )];
            if (rows.length === 0) return;
            event.preventDefault();
            const index = rows.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowUp" && index <= 0) {
              searchRef.current?.focus();
              return;
            }
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? rows.length - 1
                : event.key === "ArrowDown"
                  ? Math.min(rows.length - 1, index + 1)
                  : Math.max(0, index - 1);
            rows[nextIndex].focus();
          }}
        >
          {targets.length === 0 ? (
            <div className="forward-target-empty">没有匹配的会话</div>
          ) : targets.map((target) => (
            <button
              className="forward-target-row"
              type="button"
              key={target.id}
              disabled={pending}
              onClick={() => onConfirm(target)}
            >
              <Avatar avatar={target.avatar} size="medium" />
              <span>
                <strong>{target.title}</strong>
                <small>{target.id === currentChatId ? "当前会话" : target.preview}</small>
              </span>
              {pending && pendingTargetId === target.id
                ? <LoaderCircle className="spin" size={16} />
                : <ChevronLeft className="forward-target-arrow" size={18} strokeWidth={1.8} />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
