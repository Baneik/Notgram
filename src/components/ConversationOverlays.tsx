import {
  AlertCircle,
  ChevronLeft,
  Edit3,
  Forward,
  LoaderCircle,
  Reply,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Chat, Message } from "../telegram/types";
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
}: MessageActionMenuProps) {
  const permissions = message.permissions;
  return (
    <div
      className="message-action-menu"
      role="menu"
      aria-label="消息操作"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
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
  if (!permissions) return null;
  return (
    <div className="message-delete-backdrop" role="presentation">
      <section
        className="message-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-delete-title"
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
  return (
    <div
      className="message-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="message-forward-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-forward-title"
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
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索会话"
            type="search"
            disabled={pending}
          />
        </label>
        <div className="forward-target-list">
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
