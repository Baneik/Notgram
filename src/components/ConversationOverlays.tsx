import {
  AlertCircle,
  Check,
  Copy,
  ChevronLeft,
  Download,
  Edit3,
  Flag,
  Forward,
  Hash,
  LoaderCircle,
  Pin,
  PinOff,
  PictureInPicture2,
  Reply,
  AtSign,
  MessageCircle,
  Search,
  Trash2,
  UserRoundX,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNativeContextMenu, type NativeContextMenuItem } from "../contextMenu/nativeContextMenuBridge";
import { ContextMenuPanel, ContextMenuSurface, type ContextMenuPoint } from "./ContextMenuSurface";
import { useContextMenuDismiss } from "../hooks/useContextMenuDismiss";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Chat, ForumTopic, ForumTopicPage, Message } from "../telegram/types";
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
  const fallbackPosition = {
    left: Math.max(8, Math.min(position.left, window.innerWidth - 184 - 8)),
    top: Math.max(8, Math.min(position.top - 21, window.innerHeight - 326 - 8)),
  };
  const nativeItems: NativeContextMenuItem[] = permissions ? [
    ...(permissions.canReply ? [{ id: "reply", label: "回复", icon: "reply" as const }] : []),
    ...(permissions.canForward ? [{ id: "forward", label: "转发", icon: "forward" as const }] : []),
    { id: "copy", label: "复制", icon: "copy" },
    ...(onDownload ? [{ id: "download", label: "下载", icon: "download" as const }] : []),
    ...(permissions.canEdit && message.content.kind === "text"
      ? [{ id: "edit", label: "编辑", icon: "edit" as const }]
      : []),
    ...(permissions.canDeleteOnlyForSelf || permissions.canDeleteForAllUsers
      ? [{ id: "delete", label: "删除", icon: "trash" as const, danger: true }]
      : []),
    ...(message.isPinned ? (onUnpin ? [{ id: "unpin", label: "取消置顶", icon: "pin" as const }] : [])
      : (onPin ? [{ id: "pin-message", label: "置顶消息", icon: "pin" as const }] : [])),
    ...(onPlayInWindow ? [{ id: "play-window", label: "以小窗播放", icon: "play-window" as const }] : []),
    ...(onReport ? [{ id: "report", label: "举报", icon: "trash" as const, danger: true }] : []),
  ] : [
    { id: "reply", label: "回复", icon: "reply", disabled: true },
    { id: "forward", label: "转发", icon: "forward", disabled: true },
    { id: "copy", label: "复制", icon: "copy" },
    ...(onDownload ? [{ id: "download", label: "下载", icon: "download" as const }] : []),
    ...(message.content.kind === "text"
      ? [{ id: "edit", label: "编辑", icon: "edit" as const, disabled: true }]
      : []),
    { id: "delete", label: "删除", icon: "trash", danger: true, disabled: true },
    {
      id: message.isPinned ? "unpin" : "pin-message",
      label: message.isPinned ? "取消置顶" : "置顶消息",
      icon: "pin",
      disabled: true,
    },
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
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyboard(event, onClose)}
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
          {permissions.canForward && (
            <button type="button" role="menuitem" onClick={onForward}>
              <Forward size={16} strokeWidth={1.9} />
              <span>转发</span>
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
          {message.isPinned ? onUnpin && (
            <button type="button" role="menuitem" onClick={onUnpin}>
              <PinOff size={16} strokeWidth={1.9} />
              <span>取消置顶</span>
            </button>
          ) : onPin && (
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
    <div className="message-delete-backdrop" role="presentation">
      <section ref={dialogRef} className="message-pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-message-title" tabIndex={-1}>
        <header className="message-forward-heading">
          <span className="message-forward-heading-icon"><Pin size={18} strokeWidth={1.9} /></span>
          <div><h3 id="pin-message-title">置顶消息</h3><p>{message.content.kind === "text" ? message.content.text : "这条消息"}</p></div>
        </header>
        <div className="message-pin-options">
          {allowOnlyForSelf && <label><input type="checkbox" checked={onlyForSelf} onChange={(event) => setOnlyForSelf(event.target.checked)} />仅为我置顶</label>}
          {allowNotification && !onlyForSelf && <label><input type="checkbox" checked={disableNotification} onChange={(event) => setDisableNotification(event.target.checked)} />静音置顶通知</label>}
        </div>
        <div className="message-delete-actions">
          <button className="dialog-primary" type="button" disabled={pending} onClick={() => onConfirm(disableNotification, onlyForSelf)}>
            {pending ? <LoaderCircle className="spin" size={16} /> : <Pin size={16} />}置顶
          </button>
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>取消</button>
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

interface ForwardMessagesDialogProps {
  selectedCount: number;
  targets: Chat[];
  topicsByChat: Map<string, ForumTopic[]>;
  currentChatId: string;
  query: string;
  pending: boolean;
  pendingTargetId?: string;
  onQueryChange: (query: string) => void;
  onLoadTopics: (chatId: string) => Promise<ForumTopicPage | undefined>;
  onConfirm: (target: Chat, topicId?: string) => void;
  onClose: () => void;
}

export function ForwardMessagesDialog({
  selectedCount,
  targets,
  topicsByChat,
  currentChatId,
  query,
  pending,
  pendingTargetId,
  onQueryChange,
  onLoadTopics,
  onConfirm,
  onClose,
}: ForwardMessagesDialogProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending, searchRef);
  const [forumTarget, setForumTarget] = useState<Chat>();
  const [topicQuery, setTopicQuery] = useState("");
  const [topicsLoading, setTopicsLoading] = useState(false);
  const topics = forumTarget
    ? (topicsByChat.get(forumTarget.id) ?? []).filter((topic) => {
        const normalized = topicQuery.trim().toLocaleLowerCase();
        return !topic.isHidden && (!normalized || topic.name.toLocaleLowerCase().includes(normalized));
      })
    : [];

  useEffect(() => {
    if (!forumTarget || topicsByChat.has(forumTarget.id)) return;
    setTopicsLoading(true);
    void onLoadTopics(forumTarget.id).finally(() => setTopicsLoading(false));
  }, [forumTarget, onLoadTopics, topicsByChat]);

  const chooseTarget = (target: Chat) => {
    if (!target.isForum) {
      onConfirm(target);
      return;
    }
    setForumTarget(target);
    setTopicQuery("");
  };
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
          {forumTarget ? (
            <button className="message-forward-heading-icon" type="button" aria-label="返回会话选择" title="返回" disabled={pending} onClick={() => setForumTarget(undefined)}>
              <ChevronLeft size={18} strokeWidth={1.9} />
            </button>
          ) : (
            <span className="message-forward-heading-icon"><Forward size={18} strokeWidth={1.9} /></span>
          )}
          <div>
            <h3 id="message-forward-title">转发 {selectedCount} 条消息</h3>
            <p>{forumTarget ? `选择“${forumTarget.title}”中的话题` : "选择目标会话"}</p>
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
          <span className="sr-only">{forumTarget ? "搜索目标话题" : "搜索目标会话"}</span>
          <input
            ref={searchRef}
            value={forumTarget ? topicQuery : query}
            onChange={(event) => forumTarget ? setTopicQuery(event.target.value) : onQueryChange(event.target.value)}
            placeholder={forumTarget ? "搜索话题" : "搜索会话"}
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
          {forumTarget ? topicsLoading && topics.length === 0 ? (
            <div className="forward-target-empty"><LoaderCircle className="spin" size={18} />正在加载话题</div>
          ) : topics.length === 0 ? (
            <div className="forward-target-empty">没有匹配的话题</div>
          ) : topics.map((topic) => (
            <button className="forward-target-row" type="button" key={topic.id} disabled={pending || topic.isClosed} onClick={() => onConfirm(forumTarget, topic.id)}>
              <span className="forward-topic-icon"><Hash size={17} /></span>
              <span><strong>{topic.name}</strong><small>{topic.isClosed ? "话题已关闭" : topic.lastMessage ? messageSummary(topic.lastMessage.content) : "暂无消息"}</small></span>
              {pending && pendingTargetId === forumTarget.id ? <LoaderCircle className="spin" size={16} /> : <ChevronLeft className="forward-target-arrow" size={18} strokeWidth={1.8} />}
            </button>
          )) : targets.length === 0 ? (
            <div className="forward-target-empty">没有匹配的会话</div>
          ) : targets.map((target) => (
            <button
              className="forward-target-row"
              type="button"
              key={target.id}
              disabled={pending}
              onClick={() => chooseTarget(target)}
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
