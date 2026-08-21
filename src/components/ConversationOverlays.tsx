import {
  AlertCircle,
  BellOff,
  Check,
  Copy,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Flag,
  Forward,
  LoaderCircle,
  Pin,
  PinOff,
  PictureInPicture2,
  Reply,
  Repeat2,
  AtSign,
  MessageCircle,
  Search,
  Trash2,
  UserRound,
  UserRoundX,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNativeContextMenu, type NativeContextMenuItem } from "../contextMenu/nativeContextMenuBridge";
import { ContextMenuPanel, ContextMenuSurface, type ContextMenuPoint } from "./ContextMenuSurface";
import { useContextMenuDismiss } from "../hooks/useContextMenuDismiss";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Chat, Message } from "../telegram/types";
import { MAX_QUICK_FORWARD_TARGETS } from "../store/conversationActivity";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";
import { currentColorTheme } from "../theme/theme";
import { Avatar } from "./Avatar";
import { messageSummary } from "./conversationMessages";

interface SenderActionMenuProps {
  position: ContextMenuPoint;
  senderName: string;
  onSearch: () => void;
  onMention?: () => void;
  onPrivateChat?: () => void;
  onDismiss: () => void;
}

export function SenderActionMenu({
  position,
  senderName,
  onSearch,
  onMention,
  onPrivateChat,
  onDismiss,
}: SenderActionMenuProps) {
  const nativeMenu = useNativeContextMenu({
    label: "成员操作",
    colorTheme: currentColorTheme(),
    items: [
      { id: "mention", label: `@${senderName}`, icon: "at", disabled: !onMention },
      { id: "private", label: "私聊", icon: "message", disabled: !onPrivateChat },
      { id: "search", label: "搜索成员消息", icon: "search" },
    ],
  }, position, (actionId) => {
    onDismiss();
    if (actionId === "mention") onMention?.();
    else if (actionId === "private") onPrivateChat?.();
    else if (actionId === "search") onSearch();
  }, onDismiss);
  if (nativeMenu) return null;
  return (
    <ContextMenuSurface label="成员操作" point={position} onClose={onDismiss}>
      <ContextMenuPanel>
        <button type="button" role="menuitem" disabled={!onMention} onClick={() => { onDismiss(); onMention?.(); }}>
          <AtSign size={16} strokeWidth={1.9} />
          <span>@{senderName}</span>
        </button>
        <button type="button" role="menuitem" disabled={!onPrivateChat} onClick={() => { onDismiss(); onPrivateChat?.(); }}>
          <MessageCircle size={16} strokeWidth={1.9} />
          <span>私聊</span>
        </button>
        <button type="button" role="menuitem" onClick={() => { onDismiss(); onSearch(); }}>
          <Search size={16} strokeWidth={1.9} />
          <span>搜索 {senderName} 的消息</span>
        </button>
      </ContextMenuPanel>
    </ContextMenuSurface>
  );
}
interface MessageActionMenuProps {
  position: { left: number; top: number };
  message: Message;
  loading: boolean;
  onReply: () => void;
  onEdit: () => void;
  onForward: () => void;
  forwardTargets: Chat[];
  onQuickForward: (target: Chat) => void;
  onForwardAlbum?: () => void;
  onQuickForwardAlbum?: (target: Chat) => void;
  onRepeat?: () => void;
  onDelete: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
  onPlayInWindow?: () => void;
  onDownload?: () => void;
  onCopy: () => void;
  onDismiss: () => void;
  onClose: () => void;
  onReport?: () => void;
}

export function MessageActionMenu({
  position,
  message,
  loading,
  onReply,
  onEdit,
  onForward,
  forwardTargets,
  onQuickForward,
  onForwardAlbum,
  onQuickForwardAlbum,
  onRepeat,
  onDelete,
  onPin,
  onUnpin,
  onPlayInWindow,
  onDownload,
  onCopy,
  onDismiss,
  onClose,
  onReport,
}: MessageActionMenuProps) {
  const permissions = message.permissions;
  const menuRef = useRef<HTMLDivElement>(null);
  const [expandedForwardAction, setExpandedForwardAction] = useState<"forward" | "merge-forward">();
  const quickForwardTargets = forwardTargets.slice(0, MAX_QUICK_FORWARD_TARGETS);
  const fallbackPosition = {
    left: Math.max(8, Math.min(position.left, window.innerWidth - 184 - 8)),
    top: Math.max(8, Math.min(position.top - 21, window.innerHeight - 326 - 8)),
  };
  const fallbackSubmenuSide = fallbackPosition.left + 184 + 6 + 204 <= window.innerWidth - 8
    ? "right"
    : "left";
  const quickForwardItems = quickForwardTargets.map((target) => ({
    id: `quick-forward:${encodeURIComponent(target.id)}`,
    label: target.title,
    icon: "message" as const,
    avatar: target.avatar,
  }));
  const quickMergeForwardItems = quickForwardTargets.map((target) => ({
    id: `quick-merge-forward:${encodeURIComponent(target.id)}`,
    label: target.title,
    icon: "message" as const,
    avatar: target.avatar,
  }));
  const nativeItems: NativeContextMenuItem[] = permissions ? [
    ...(permissions.canReply ? [{ id: "reply", label: "回复", icon: "reply" as const }] : []),
    ...(permissions.canForward ? [{
      id: "forward",
      label: "转发",
      icon: "forward" as const,
      actionable: true,
      children: quickForwardItems.length > 0 ? quickForwardItems : undefined,
    }] : []),
    ...(permissions.canForward && onForwardAlbum ? [{
      id: "merge-forward",
      label: "合并转发",
      icon: "forward" as const,
      actionable: true,
      children: quickMergeForwardItems.length > 0 ? quickMergeForwardItems : undefined,
    }] : []),
    ...(permissions.canForward && onRepeat
      ? [{ id: "repeat", label: "复读", icon: "repeat" as const }]
      : []),
    { id: "copy", label: "复制", icon: "copy" },
    ...(onDownload ? [{ id: "download", label: "下载", icon: "download" as const }] : []),
    ...(permissions.canEdit && message.content.kind === "text"
      ? [{ id: "edit", label: "编辑", icon: "edit" as const }]
      : []),
    ...(permissions.canDeleteOnlyForSelf || permissions.canDeleteForAllUsers
      ? [{ id: "delete", label: "删除", icon: "trash" as const, danger: true }]
      : []),
    ...(!loading && message.isPinned ? (onUnpin ? [{ id: "unpin", label: "取消置顶", icon: "pin" as const }] : [])
      : !loading && onPin ? [{ id: "pin-message", label: "置顶消息", icon: "pin" as const }] : []),
    ...(onPlayInWindow ? [{ id: "play-window", label: "以小窗播放", icon: "play-window" as const }] : []),
    ...(onReport ? [{ id: "report", label: "举报", icon: "trash" as const, danger: true }] : []),
  ] : [
    { id: "reply", label: "回复", icon: "reply", disabled: true },
    { id: "forward", label: "转发", icon: "forward", disabled: true },
    ...(onForwardAlbum
      ? [{ id: "merge-forward", label: "合并转发", icon: "forward" as const, disabled: true }]
      : []),
    ...(onRepeat ? [{ id: "repeat", label: "复读", icon: "repeat" as const, disabled: true }] : []),
    { id: "copy", label: "复制", icon: "copy" },
    ...(onDownload ? [{ id: "download", label: "下载", icon: "download" as const }] : []),
    ...(message.content.kind === "text"
      ? [{ id: "edit", label: "编辑", icon: "edit" as const, disabled: true }]
      : []),
    { id: "delete", label: "删除", icon: "trash", danger: true, disabled: true },
    ...(onPlayInWindow ? [{ id: "play-window", label: "以小窗播放", icon: "play-window" as const }] : []),
    ...(onReport ? [{ id: "report", label: "举报", icon: "trash" as const, danger: true, disabled: true }] : []),
  ];
  const nativeMenu = useNativeContextMenu({
    label: "消息操作",
    colorTheme: currentColorTheme(),
    items: nativeItems,
  }, { x: position.left, y: position.top }, (actionId) => {
    if (actionId === "reply") onReply();
    else if (actionId === "forward") onForward();
    else if (actionId === "merge-forward") onForwardAlbum?.();
    else if (actionId.startsWith("quick-forward:")) {
      const targetId = decodeURIComponent(actionId.slice("quick-forward:".length));
      const target = quickForwardTargets.find((candidate) => candidate.id === targetId);
      if (target) onQuickForward(target);
    } else if (actionId.startsWith("quick-merge-forward:")) {
      const targetId = decodeURIComponent(actionId.slice("quick-merge-forward:".length));
      const target = quickForwardTargets.find((candidate) => candidate.id === targetId);
      if (target) onQuickForwardAlbum?.(target);
    }
    else if (actionId === "repeat") onRepeat?.();
    else if (actionId === "copy") onCopy();
    else if (actionId === "edit") onEdit();
    else if (actionId === "delete") onDelete();
    else if (actionId === "pin-message") onPin?.();
    else if (actionId === "unpin") onUnpin?.();
    else if (actionId === "play-window") onPlayInWindow?.();
    else if (actionId === "download") onDownload?.();
    else if (actionId === "report") onReport?.();
  }, onDismiss);
  useContextMenuDismiss(menuRef, onDismiss);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (!focusFirstMenuButton(menuRef.current)) menuRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [permissions]);
  if (nativeMenu) return null;
  return (
    <div
      ref={menuRef}
      className="message-action-menu"
      role="menu"
      aria-label="消息操作"
      tabIndex={-1}
      style={fallbackPosition}
      data-submenu-side={fallbackSubmenuSide}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyboard(event, onClose)}
      onMouseLeave={() => setExpandedForwardAction(undefined)}
    >
      {!permissions ? (
        <>
          <button type="button" role="menuitem" onClick={onCopy}>
            <Copy size={16} strokeWidth={1.9} />
            <span>复制</span>
          </button>
          {onDownload && (
            <button type="button" role="menuitem" onClick={onDownload}>
              <Download size={16} strokeWidth={1.9} />
              <span>下载</span>
            </button>
          )}
          <div className="message-action-status" role="status">
            {loading ? (
              <><LoaderCircle className="spin" size={15} />正在读取操作权限</>
            ) : (
              <><AlertCircle size={15} />无法读取操作权限</>
            )}
          </div>
        </>
      ) : (
        <>
          {permissions.canReply && (
            <button type="button" role="menuitem" onClick={onReply}>
              <Reply size={16} strokeWidth={1.9} />
              <span>回复</span>
            </button>
          )}
          {permissions.canForward && quickForwardTargets.length > 0 ? (
            <div
              className="message-action-menu-group"
              onMouseEnter={() => setExpandedForwardAction("forward")}
              onMouseLeave={() => setExpandedForwardAction(undefined)}
            >
              <button className="has-submenu" type="button" role="menuitem" aria-haspopup="menu" onClick={onForward}>
                <Forward size={16} strokeWidth={1.9} />
                <span>转发</span>
                <ChevronRight size={15} strokeWidth={1.9} />
              </button>
              {expandedForwardAction === "forward" && (
                <div className="message-action-submenu" role="menu" aria-label="快速转发">
                  {quickForwardTargets.map((target) => (
                    <button type="button" role="menuitem" key={target.id} onClick={() => onQuickForward(target)}>
                      <Avatar avatar={target.avatar} size="small" />
                      <span>{target.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : permissions.canForward ? (
            <button type="button" role="menuitem" onClick={onForward}>
              <Forward size={16} strokeWidth={1.9} />
              <span>转发</span>
            </button>
          ) : null}
          {permissions.canForward && onForwardAlbum && quickForwardTargets.length > 0 ? (
            <div
              className="message-action-menu-group"
              onMouseEnter={() => setExpandedForwardAction("merge-forward")}
              onMouseLeave={() => setExpandedForwardAction(undefined)}
            >
              <button className="has-submenu" type="button" role="menuitem" aria-haspopup="menu" onClick={onForwardAlbum}>
                <Forward size={16} strokeWidth={1.9} />
                <span>合并转发</span>
                <ChevronRight size={15} strokeWidth={1.9} />
              </button>
              {expandedForwardAction === "merge-forward" && (
                <div className="message-action-submenu" role="menu" aria-label="快速合并转发">
                  {quickForwardTargets.map((target) => (
                    <button type="button" role="menuitem" key={target.id} onClick={() => onQuickForwardAlbum?.(target)}>
                      <Avatar avatar={target.avatar} size="small" />
                      <span>{target.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : permissions.canForward && onForwardAlbum ? (
            <button type="button" role="menuitem" onClick={onForwardAlbum}>
              <Forward size={16} strokeWidth={1.9} />
              <span>合并转发</span>
            </button>
          ) : null}
          {permissions.canForward && onRepeat && (
            <button type="button" role="menuitem" onClick={onRepeat}>
              <Repeat2 size={16} strokeWidth={1.9} />
              <span>复读</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={onCopy}>
            <Copy size={16} strokeWidth={1.9} />
            <span>复制</span>
          </button>
          {onDownload && (
            <button type="button" role="menuitem" onClick={onDownload}>
              <Download size={16} strokeWidth={1.9} />
              <span>下载</span>
            </button>
          )}
          {permissions.canEdit && message.content.kind === "text" && (
            <button type="button" role="menuitem" onClick={onEdit}>
              <Edit3 size={16} strokeWidth={1.9} />
              <span>编辑</span>
            </button>
          )}
          {(permissions.canDeleteOnlyForSelf || permissions.canDeleteForAllUsers) && (
            <button className="is-danger" type="button" role="menuitem" onClick={onDelete}>
              <Trash2 size={16} strokeWidth={1.9} />
              <span>删除</span>
            </button>
          )}
          {!loading && message.isPinned ? onUnpin && (
            <button type="button" role="menuitem" onClick={onUnpin}>
              <PinOff size={16} strokeWidth={1.9} />
              <span>取消置顶</span>
            </button>
          ) : !loading && onPin && (
            <button type="button" role="menuitem" onClick={onPin}>
              <Pin size={16} strokeWidth={1.9} />
              <span>置顶消息</span>
            </button>
          )}
          {onPlayInWindow && (
            <button type="button" role="menuitem" onClick={onPlayInWindow}>
              <PictureInPicture2 size={16} strokeWidth={1.9} />
              <span>以小窗播放</span>
            </button>
          )}
          {onReport && <button className="is-danger" type="button" role="menuitem" onClick={onReport}><Flag size={16} strokeWidth={1.9} /><span>举报</span></button>}
        </>
      )}
    </div>
  );
}
interface DeleteMessagesDialogProps {
  count: number;
  batch?: boolean;
  preview?: string;
  canDeleteOnlyForSelf: boolean;
  canDeleteForAllUsers: boolean;
  pending: boolean;
  onConfirm: (revoke: boolean) => void;
  onClose: () => void;
}
export function DeleteMessagesDialog({
  count,
  batch = false,
  preview,
  canDeleteOnlyForSelf,
  canDeleteForAllUsers,
  pending,
  onConfirm,
  onClose,
}: DeleteMessagesDialogProps) {
  const [pendingScope, setPendingScope] = useState<"self" | "all">();
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending);
  useEffect(() => {
    if (!pending) setPendingScope(undefined);
  }, [pending]);
  const confirm = (scope: "self" | "all") => {
    setPendingScope(scope);
    onConfirm(scope === "all");
  };
  if (!canDeleteOnlyForSelf && !canDeleteForAllUsers) return null;
  return (
    <div className="message-delete-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
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
            <h3 id="message-delete-title">{batch || count > 1 ? `删除 ${count} 条消息` : "删除消息"}</h3>
            <p>选择这次删除对谁生效</p>
          </div>
        </div>
        {preview && <p className="message-delete-preview">{preview}</p>}
        <div className="message-delete-options">
          {canDeleteOnlyForSelf && (
            <button
              className="message-delete-option"
              type="button"
              aria-label="仅对我删除"
              disabled={pending}
              onClick={() => confirm("self")}
            >
              <span className="message-delete-option-icon">
                {pending && pendingScope === "self" ? <LoaderCircle className="spin" size={18} /> : <UserRoundX size={18} />}
              </span>
              <span><strong>仅对我删除</strong><small>其他成员仍能看到{count > 1 ? "这些消息" : "这条消息"}</small></span>
            </button>
          )}
          {canDeleteForAllUsers && (
            <button
              className="message-delete-option is-for-everyone"
              type="button"
              aria-label="为所有人删除"
              disabled={pending}
              onClick={() => confirm("all")}
            >
              <span className="message-delete-option-icon">
                {pending && pendingScope === "all" ? <LoaderCircle className="spin" size={18} /> : <UsersRound size={18} />}
              </span>
              <span><strong>为所有人删除</strong><small>从所有成员的聊天记录中移除</small></span>
            </button>
          )}
        </div>
        <div className="message-delete-actions">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}

interface PinMessageDialogProps {
  message: Message;
  pending: boolean;
  allowOnlyForSelf: boolean;
  allowNotification: boolean;
  onConfirm: (disableNotification: boolean, onlyForSelf: boolean) => void;
  onClose: () => void;
}

export function PinMessageDialog({ message, pending, allowOnlyForSelf, allowNotification, onConfirm, onClose }: PinMessageDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending);
  const [disableNotification, setDisableNotification] = useState(false);
  const [onlyForSelf, setOnlyForSelf] = useState(false);
  return (
    <div className="message-delete-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section ref={dialogRef} className="message-pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-message-title" tabIndex={-1}>
        <header className="message-pin-heading">
          <span className="message-pin-heading-icon"><Pin size={19} strokeWidth={2} /></span>
          <div><h3 id="pin-message-title">置顶消息</h3><p>让这条消息显示在会话顶部</p></div>
        </header>
        <p className="message-pin-preview">{message.content.kind === "text" ? message.content.text : "这条消息"}</p>
        <div className="message-pin-options">
          {allowOnlyForSelf && <label className={`message-pin-option${onlyForSelf ? " is-selected" : ""}`}>
            <input type="checkbox" checked={onlyForSelf} onChange={(event) => setOnlyForSelf(event.target.checked)} />
            <span className="message-pin-option-icon"><UserRound size={17} strokeWidth={1.9} /></span>
            <span><strong>仅为我置顶</strong><small>其他成员不会看到这条置顶</small></span>
          </label>}
          {allowNotification && !onlyForSelf && <label className={`message-pin-option${disableNotification ? " is-selected" : ""}`}>
            <input type="checkbox" checked={disableNotification} onChange={(event) => setDisableNotification(event.target.checked)} />
            <span className="message-pin-option-icon"><BellOff size={17} strokeWidth={1.9} /></span>
            <span><strong>静音置顶通知</strong><small>不会向群成员发送置顶提醒</small></span>
          </label>}
        </div>
        <div className="message-delete-actions">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>取消</button>
          <button className="dialog-primary message-pin-confirm" type="button" disabled={pending} onClick={() => onConfirm(disableNotification, onlyForSelf)}>
            {pending ? <LoaderCircle className="spin" size={16} /> : <Pin size={16} />}置顶消息
          </button>
        </div>
      </section>
    </div>
  );
}

interface AutoDeleteDialogProps {
  currentTime: number;
  pending: boolean;
  onConfirm: (seconds: number) => void;
  onClose: () => void;
}

const AUTO_DELETE_PRESETS = [
  [0, "关闭"],
  [86400, "1 天"],
  [604800, "1 周"],
  [2592000, "1 个月"],
] as const;

export function AutoDeleteDialog({ currentTime, pending, onConfirm, onClose }: AutoDeleteDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending);
  const isPreset = AUTO_DELETE_PRESETS.some(([seconds]) => seconds === currentTime);
  const [selection, setSelection] = useState(isPreset ? String(currentTime) : "custom");
  const [customDays, setCustomDays] = useState(String(Math.max(1, Math.ceil((currentTime || 86400) / 86400))));
  const seconds = selection === "custom" ? Number(customDays) * 86400 : Number(selection);
  const valid = Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 31_536_000;
  return (
    <div className="message-delete-backdrop" role="presentation">
      <section ref={dialogRef} className="auto-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-delete-title" tabIndex={-1}>
        <header className="message-forward-heading">
          <span className="message-forward-heading-icon"><Trash2 size={18} strokeWidth={1.9} /></span>
          <div><h3 id="auto-delete-title">自动删除消息</h3><p>新消息会在设定时间后自动删除，历史消息不会受影响</p></div>
        </header>
        <label className="auto-delete-field">删除时间
          <select aria-label="自动删除时长" value={selection} onChange={(event) => setSelection(event.target.value)} disabled={pending}>
            {AUTO_DELETE_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <option value="custom">自定义</option>
          </select>
        </label>
        {selection === "custom" && <label className="auto-delete-field">自定义天数
          <input aria-label="自定义天数" type="number" min={1} max={365} step={1} value={customDays} onChange={(event) => setCustomDays(event.target.value)} disabled={pending} />
        </label>}
        <div className="message-delete-actions">
          <button className="dialog-primary" type="button" disabled={pending || !valid} onClick={() => onConfirm(seconds)}>{pending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存</button>
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>取消</button>
        </div>
      </section>
    </div>
  );
}
