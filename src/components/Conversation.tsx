import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronLeft,
  FileText,
  ImageIcon,
  Download,
  Edit3,
  MoreVertical,
  MoreHorizontal,
  LoaderCircle,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
  RotateCcw,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type {
  Chat,
  Message,
  MessageContent,
  MessagePermissions,
  User,
} from "../telegram/types";
import { formatMessageTime } from "../utils/formatters";
import {
  groupConsecutiveMessages,
  isGroupFirst,
  messageGroupPosition,
  type MessageGroupPosition,
} from "../utils/messageGrouping";
import { Avatar } from "./Avatar";

interface ConversationProps {
  chat?: Chat;
  messages: Message[];
  users: Map<string, User>;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  transportKind: "mock" | "tauri";
  onSendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string) => Promise<boolean>;
  onDeleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onSendFile: (file?: File) => Promise<boolean>;
  onCancelFileUpload: (messageId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onBack: () => void;
}

export function Conversation({
  chat,
  messages,
  users,
  historyLoading,
  hasOlderMessages,
  transportKind,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onLoadMessageProperties,
  onDownloadFile,
  onRetryMessage,
  onSendFile,
  onCancelFileUpload,
  onLoadOlder,
  onBack,
}: ConversationProps) {
  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [actionMenu, setActionMenu] = useState<{
    messageId: string;
    left: number;
    top: number;
  }>();
  const [actionLoadingId, setActionLoadingId] = useState<string>();
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [deleteTarget, setDeleteTarget] = useState<Message>();
  const [deletePending, setDeletePending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const draftBeforeEditRef = useRef<string | undefined>(undefined);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const previousLayoutRef = useRef<{
    chatId?: string;
    firstId?: string;
    lastId?: string;
    search: string;
    height: number;
    scrollTop: number;
    distanceBottom: number;
  } | undefined>(undefined);

  const sendAttachment = async (file?: File) => {
    if (attachmentPending) return;
    setAttachmentPending(true);
    try {
      await onSendFile(file);
    } finally {
      setAttachmentPending(false);
    }
  };

  const visibleMessages = useMemo(() => {
    const query = messageSearch.trim().toLocaleLowerCase();
    if (!query) return messages;
    return messages.filter((message) => {
      if (message.content.kind !== "text") {
        return message.content.fileName.toLocaleLowerCase().includes(query);
      }
      return message.content.text.toLocaleLowerCase().includes(query);
    });
  }, [messageSearch, messages]);

  const visibleMessageGroups = useMemo(
    () => groupConsecutiveMessages(visibleMessages),
    [visibleMessages],
  );

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  const actionMessage = actionMenu
    ? messagesById.get(actionMenu.messageId)
    : undefined;
  const actionPermissions = actionMessage?.permissions;

  useEffect(() => {
    setActionMenu(undefined);
    setActionLoadingId(undefined);
    setReplyingTo(undefined);
    setEditingMessage(undefined);
    setDeleteTarget(undefined);
    setDeletePending(false);
    setDraft("");
    draftBeforeEditRef.current = undefined;
  }, [chat?.id]);

  useEffect(() => {
    if (actionMenu && !messagesById.has(actionMenu.messageId)) setActionMenu(undefined);
    if (replyingTo && !messagesById.has(replyingTo.id)) setReplyingTo(undefined);
    if (editingMessage && !messagesById.has(editingMessage.id)) {
      setEditingMessage(undefined);
      setDraft(draftBeforeEditRef.current ?? "");
      draftBeforeEditRef.current = undefined;
    }
    if (deleteTarget && !messagesById.has(deleteTarget.id)) setDeleteTarget(undefined);
  }, [actionMenu, deleteTarget, editingMessage, messagesById, replyingTo]);

  useEffect(() => {
    if (!actionMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".message-action-menu")) return;
      setActionMenu(undefined);
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionMenu(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [actionMenu]);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (!element) return;
    const previous = previousLayoutRef.current;
    const firstId = visibleMessages[0]?.id;
    const lastId = visibleMessages.at(-1)?.id;

    if (!previous || previous.chatId !== chat?.id) {
      element.scrollTop = element.scrollHeight;
    } else if (previous.search !== messageSearch) {
      element.scrollTop = messageSearch ? 0 : element.scrollHeight;
    } else if (
      previous.firstId &&
      firstId !== previous.firstId &&
      visibleMessages.some((message) => message.id === previous.firstId)
    ) {
      element.scrollTop = previous.scrollTop + element.scrollHeight - previous.height;
    } else if (lastId !== previous.lastId && previous.distanceBottom < 96) {
      element.scrollTop = element.scrollHeight;
    }

    previousLayoutRef.current = {
      chatId: chat?.id,
      firstId,
      lastId,
      search: messageSearch,
      height: element.scrollHeight,
      scrollTop: element.scrollTop,
      distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
    };
  }, [chat?.id, messageSearch, visibleMessages]);

  useEffect(() => {
    const element = messageListRef.current;
    if (
      !element ||
      messageSearch ||
      historyLoading ||
      !hasOlderMessages ||
      element.scrollHeight > element.clientHeight + 1
    ) {
      return;
    }
    const attemptKey = `${chat?.id ?? ""}:${messages.length}`;
    if (autoFillAttemptRef.current === attemptKey) return;
    autoFillAttemptRef.current = attemptKey;
    void onLoadOlder();
  }, [chat?.id, hasOlderMessages, historyLoading, messageSearch, messages.length, onLoadOlder]);

  if (!chat) {
    return (
      <section className="conversation empty-conversation">
        <div className="conversation-empty-mark">N</div>
        <h2>选择一个对话</h2>
      </section>
    );
  }

  const peer = chat.peerId ? users.get(chat.peerId) : undefined;
  const statusLabel =
    chat.kind === "channel"
      ? "频道"
      : chat.kind === "group"
        ? "群组"
        : chat.kind === "saved"
          ? "仅自己可见"
          : peer?.presence === "typing"
            ? "正在输入"
            : peer?.presence === "online"
              ? "在线"
              : peer?.lastSeenLabel
                ? `最后上线：${peer.lastSeenLabel}`
                : "离线";
  const composerContextMessage = editingMessage ?? replyingTo;
  const composerContextTitle = editingMessage
    ? "编辑消息"
    : replyingTo
      ? `回复 ${senderNameForMessage(replyingTo, users, chat)}`
      : undefined;

  const focusComposer = () => {
    globalThis.setTimeout(() => composerInputRef.current?.focus(), 0);
  };

  const openActionMenu = async (message: Message, left: number, top: number) => {
    const menuWidth = 184;
    const menuHeight = 150;
    setActionMenu({
      messageId: message.id,
      left: Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8)),
    });
    if (message.permissions || actionLoadingId === message.id) return;
    setActionLoadingId(message.id);
    await onLoadMessageProperties(message.chatId, message.id);
    setActionLoadingId((current) => current === message.id ? undefined : current);
  };

  const cancelEditing = () => {
    setEditingMessage(undefined);
    setDraft(draftBeforeEditRef.current ?? "");
    draftBeforeEditRef.current = undefined;
    focusComposer();
  };

  const startReply = (message: Message) => {
    if (editingMessage) {
      setDraft(draftBeforeEditRef.current ?? "");
      setEditingMessage(undefined);
      draftBeforeEditRef.current = undefined;
    }
    setReplyingTo(message);
    setActionMenu(undefined);
    focusComposer();
  };

  const startEditing = (message: Message) => {
    if (message.content.kind !== "text") return;
    if (!editingMessage) draftBeforeEditRef.current = draft;
    setReplyingTo(undefined);
    setEditingMessage(message);
    setDraft(message.content.text);
    setActionMenu(undefined);
    focusComposer();
  };

  const submitMessage = async () => {
    const submitted = draft.trim();
    if (!submitted || sending) return;
    if (editingMessage) {
      setSending(true);
      const edited = await onEditMessage(editingMessage.id, submitted);
      setSending(false);
      if (edited) cancelEditing();
      return;
    }
    setDraft("");
    setSending(true);
    const sent = await onSendMessage(submitted, replyingTo?.id);
    setSending(false);
    if (sent) {
      setReplyingTo(undefined);
    } else {
      setDraft((current) => current ? `${submitted}\n${current}` : submitted);
    }
  };

  const confirmDelete = async (revoke: boolean) => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    const deleted = await onDeleteMessage(deleteTarget.id, revoke);
    setDeletePending(false);
    if (deleted) setDeleteTarget(undefined);
  };

  return (
    <section className={`conversation ${searchOpen ? "has-message-search" : ""}`} aria-label={`${chat.title} 对话`}>
      <header className="conversation-header">
        <button className="mobile-back icon-button" type="button" aria-label="返回会话列表" title="返回会话列表" onClick={onBack}>
          <ChevronLeft size={21} strokeWidth={2} />
        </button>
        <Avatar avatar={chat.avatar} size="medium" />
        <div className="conversation-title">
          <h2>{chat.title}</h2>
          <span>{statusLabel}</span>
        </div>
        <div className="conversation-actions">
          <button className="icon-button" type="button" aria-label="语音通话" title="语音通话">
            <Phone size={19} strokeWidth={1.8} />
          </button>
          <button
            className={`icon-button ${searchOpen ? "is-active" : ""}`}
            type="button"
            aria-label="搜索消息"
            title="搜索消息"
            onClick={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setMessageSearch("");
            }}
          >
            <Search size={19} strokeWidth={1.8} />
          </button>
          <button className="icon-button" type="button" aria-label="更多操作" title="更多操作">
            <MoreVertical size={20} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="message-search-row">
          <Search size={16} strokeWidth={1.8} />
          <input
            autoFocus
            value={messageSearch}
            onChange={(event) => setMessageSearch(event.target.value)}
            placeholder="搜索当前对话"
            type="search"
          />
          <button className="icon-button" type="button" aria-label="关闭消息搜索" title="关闭消息搜索" onClick={() => { setSearchOpen(false); setMessageSearch(""); }}>
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>
      )}

      <div
        className="message-list"
        ref={messageListRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const previous = previousLayoutRef.current;
          if (previous) {
            previous.scrollTop = element.scrollTop;
            previous.height = element.scrollHeight;
            previous.distanceBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
          }
          if (element.scrollTop <= 64 && !messageSearch && hasOlderMessages && !historyLoading) {
            void onLoadOlder();
          }
        }}
      >
        {historyLoading && <div className="history-loading" aria-label="正在加载更早消息"><LoaderCircle className="spin" size={16} /></div>}
        <div className="message-day">今天</div>
        {visibleMessages.length === 0 ? (
          <div className="messages-empty">没有匹配的消息</div>
        ) : (
          visibleMessageGroups.map((messageGroup) => {
            const firstMessage = messageGroup[0];
            const sender = users.get(firstMessage.senderId);
            const senderName = sender?.displayName ??
              (chat.kind === "direct" ? chat.title : "Telegram 用户");
            const senderAvatar = sender?.avatar ??
              (chat.kind === "direct" ? chat.avatar : undefined);
            return (
              <div
                className={`message-group ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"}`}
                key={firstMessage.id}
              >
                {!firstMessage.outgoing && (
                  <span className="message-group-avatar">
                    <Avatar
                      avatar={senderAvatar ?? {
                        label: Array.from(senderName.trim())[0] ?? "?",
                        color: "#73828c",
                      }}
                      size="small"
                    />
                  </span>
                )}
                <div className="message-group-stack">
                  {messageGroup.map((message, index) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      sender={sender}
                      senderName={senderName}
                      groupPosition={messageGroupPosition(messageGroup, index)}
                      replyPreview={replyPreviewFor(message, messagesById, users, chat)}
                      onOpenActions={openActionMenu}
                      onDownload={onDownloadFile}
                      onRetry={onRetryMessage}
                      onCancelUpload={onCancelFileUpload}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {actionMenu && actionMessage && (
        <div
          className="message-action-menu"
          role="menu"
          aria-label="消息操作"
          style={{ left: actionMenu.left, top: actionMenu.top }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {!actionPermissions ? (
            <div className="message-action-status" role="status">
              {actionLoadingId === actionMessage.id ? (
                <><LoaderCircle className="spin" size={15} />正在读取操作权限</>
              ) : (
                <><AlertCircle size={15} />无法读取操作权限</>
              )}
            </div>
          ) : (
            <>
              {actionPermissions.canReply && (
                <button type="button" role="menuitem" onClick={() => startReply(actionMessage)}>
                  <Reply size={16} strokeWidth={1.9} />
                  <span>回复</span>
                </button>
              )}
              {actionPermissions.canEdit && actionMessage.content.kind === "text" && (
                <button type="button" role="menuitem" onClick={() => startEditing(actionMessage)}>
                  <Edit3 size={16} strokeWidth={1.9} />
                  <span>编辑</span>
                </button>
              )}
              {(actionPermissions.canDeleteOnlyForSelf ||
                actionPermissions.canDeleteForAllUsers) && (
                <button
                  className="is-danger"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setDeleteTarget(actionMessage);
                    setActionMenu(undefined);
                  }}
                >
                  <Trash2 size={16} strokeWidth={1.9} />
                  <span>删除</span>
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="composer-wrap">
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await sendAttachment(file);
            event.target.value = "";
          }}
        />
        {composerContextMessage && (
          <div className={`composer-context ${editingMessage ? "is-editing" : "is-replying"}`}>
            <span className="composer-context-icon">
              {editingMessage
                ? <Edit3 size={18} strokeWidth={1.9} />
                : <Reply size={18} strokeWidth={1.9} />}
            </span>
            <span className="composer-context-copy">
              <strong>{composerContextTitle}</strong>
              <small>{messageSummary(composerContextMessage.content)}</small>
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label={editingMessage ? "取消编辑" : "取消回复"}
              title={editingMessage ? "取消编辑" : "取消回复"}
              onClick={editingMessage ? cancelEditing : () => setReplyingTo(undefined)}
            >
              <X size={17} strokeWidth={1.9} />
            </button>
          </div>
        )}
        <div className={`composer ${editingMessage ? "is-editing" : ""}`}>
          <button className="icon-button" type="button" aria-label="表情" title="表情" disabled={Boolean(editingMessage)}>
            <Smile size={21} strokeWidth={1.8} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="添加附件"
            title={composerContextMessage ? "完成当前消息操作后添加附件" : attachmentPending ? "正在选择文件" : "添加附件"}
            disabled={Boolean(composerContextMessage) || attachmentPending}
            onClick={() => {
              if (transportKind === "tauri") void sendAttachment();
              else fileInputRef.current?.click();
            }}
          >
            {attachmentPending
              ? <LoaderCircle className="spin" size={19} strokeWidth={1.8} />
              : <Paperclip size={20} strokeWidth={1.8} />}
          </button>
          <textarea
            ref={composerInputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={async (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                if (event.nativeEvent.isComposing) return;
                event.preventDefault();
                await submitMessage();
              }
            }}
            rows={1}
            placeholder={editingMessage ? "编辑消息" : "写一条消息"}
            aria-label="消息内容"
            disabled={sending}
          />
          <button
            className="send-button icon-button"
            type="button"
            aria-label={editingMessage ? "保存编辑" : "发送消息"}
            title={editingMessage ? "保存编辑" : "发送消息"}
            disabled={!draft.trim() || sending}
            onClick={submitMessage}
          >
            {editingMessage
              ? <Check size={19} strokeWidth={2.2} />
              : <Send size={19} strokeWidth={2} />}
          </button>
        </div>
      </div>

      {deleteTarget && deleteTarget.permissions && (
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
                <p>{messageSummary(deleteTarget.content)}</p>
              </div>
            </div>
            <div className="message-delete-actions">
              {deleteTarget.permissions.canDeleteOnlyForSelf && (
                <button
                  className="dialog-secondary"
                  type="button"
                  disabled={deletePending}
                  onClick={() => void confirmDelete(false)}
                >
                  仅对我删除
                </button>
              )}
              {deleteTarget.permissions.canDeleteForAllUsers && (
                <button
                  className="dialog-danger"
                  type="button"
                  disabled={deletePending}
                  onClick={() => void confirmDelete(true)}
                >
                  {deletePending ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                  为所有人删除
                </button>
              )}
              <button
                className="dialog-secondary"
                type="button"
                disabled={deletePending}
                onClick={() => setDeleteTarget(undefined)}
              >
                取消
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function MessageBubble({
  message,
  sender,
  senderName,
  groupPosition,
  replyPreview,
  onOpenActions,
  onDownload,
  onRetry,
  onCancelUpload,
}: {
  message: Message;
  sender?: User;
  senderName: string;
  groupPosition: MessageGroupPosition;
  replyPreview?: ReplyPreview;
  onOpenActions: (message: Message, left: number, top: number) => Promise<void>;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
  onCancelUpload: (messageId: string) => Promise<void>;
}) {
  const isPhoto = message.content.kind === "media" && message.content.mediaType === "photo";
  const hasCaption = message.content.kind === "media" &&
    message.content.mediaType === "photo" &&
    Boolean(message.content.caption);
  const showSender = !message.outgoing && isGroupFirst(groupPosition);
  const mediaSource = message.content.kind === "media"
    ? localSource(message.content.localPath) ??
      localSource(message.content.thumbnailPath) ??
      message.content.previewDataUrl
    : undefined;
  const fileProgress = message.content.kind !== "text" && message.content.progress !== undefined
    ? `${Math.round(message.content.progress * 100)}%`
    : undefined;
  const downloadFileId = message.content.kind !== "text" ? message.content.fileId : undefined;
  const downloadFileName = message.content.kind !== "text" ? message.content.fileName : "";
  const canDownload = message.content.kind !== "text" &&
    downloadFileId !== undefined &&
    message.content.canDownload !== false &&
    !message.content.isDownloaded &&
    !message.content.isDownloading;
  const canCancelUpload = message.content.kind !== "text" &&
    message.content.isUploading === true;
  return (
    <article className={`message-row group-${groupPosition} ${message.outgoing ? "is-outgoing" : "is-incoming"}`}>
      <div
        className="message-bubble-shell"
        onContextMenu={(event) => {
          event.preventDefault();
          void onOpenActions(message, event.clientX, event.clientY);
        }}
      >
        <div className={`message-bubble ${isPhoto ? "is-photo" : ""} ${hasCaption ? "has-caption" : ""}`}>
          {showSender && <span className="message-sender">{sender?.displayName ?? senderName}</span>}
          {replyPreview && (
            <span className="message-reply-preview">
              <strong>{replyPreview.author}</strong>
              <small>{replyPreview.text}</small>
            </span>
          )}
          {message.content.kind === "text" ? (
            <p>{message.content.text}</p>
          ) : message.content.kind === "media" && message.content.mediaType === "photo" ? (
            <div className="photo-message" data-media-type="photo">
              <div
                className="photo-preview"
                style={message.content.width && message.content.height
                  ? { aspectRatio: `${message.content.width} / ${message.content.height}` }
                  : undefined}
              >
                {mediaSource ? (
                  <img src={mediaSource} alt={message.content.caption || message.content.fileName} />
                ) : (
                  <span className="photo-placeholder" aria-label="图片正在加载">
                    <ImageIcon size={28} strokeWidth={1.6} />
                  </span>
                )}
                {(message.content.isDownloading || message.content.isUploading) && (
                  <span className="media-progress">
                    <span>{message.content.progress === undefined
                      ? <LoaderCircle className="spin" size={15} />
                      : `${Math.round(message.content.progress * 100)}%`}</span>
                    {canCancelUpload && (
                      <button type="button" aria-label={`取消上传 ${downloadFileName}`} title="取消上传" onClick={() => void onCancelUpload(message.id)}>
                        <X size={14} strokeWidth={2.2} />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {message.content.caption && <p className="photo-caption">{message.content.caption}</p>}
            </div>
          ) : (
            <div className="file-message">
              <span className="file-icon"><FileText size={19} strokeWidth={1.8} /></span>
              <span className="file-copy">
                <strong>{message.content.fileName}</strong>
                <small>{message.content.isUploading ? `上传中 ${fileProgress ?? ""}` : message.content.isDownloading ? `下载中 ${fileProgress ?? ""}` : message.delivery === "failed" ? "发送失败" : message.content.isDownloaded ? `已缓存 · ${message.content.sizeLabel}` : message.content.sizeLabel}</small>
              </span>
              {(canDownload || canCancelUpload) && (
                <button
                  className="file-download"
                  type="button"
                  aria-label={canCancelUpload ? `取消上传 ${message.content.fileName}` : `下载 ${message.content.fileName}`}
                  title={canCancelUpload ? "取消上传" : "下载到 downloads"}
                  onClick={() => canCancelUpload ? void onCancelUpload(message.id) : void onDownload(downloadFileId!, downloadFileName)}
                >
                  {canCancelUpload ? <X size={16} strokeWidth={2.2} /> : <Download size={16} strokeWidth={2} />}
                </button>
              )}
            </div>
          )}
          <span className="message-meta">
            {message.editedAt && <span>已编辑</span>}
            <time dateTime={message.sentAt}>{formatMessageTime(message.sentAt)}</time>
            {message.outgoing && (
              message.delivery === "read" ? <CheckCheck size={14} strokeWidth={2.2} />
                : message.delivery === "sending" ? <LoaderCircle className="spin" size={13} strokeWidth={2} />
                  : message.delivery === "failed" ? (
                    <button className="message-retry" type="button" disabled={!message.canRetry} aria-label="重试发送" title={message.canRetry ? "重试发送" : "发送失败"} onClick={() => void onRetry(message.id)}>
                      {message.canRetry ? <RotateCcw size={13} strokeWidth={2.2} /> : <AlertCircle size={13} strokeWidth={2.2} />}
                    </button>
                  ) : <Check size={14} strokeWidth={2.2} />
            )}
          </span>
        </div>
        <button
          className="message-action-trigger"
          type="button"
          aria-label="消息操作"
          title="消息操作"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const left = message.outgoing ? bounds.left - 184 : bounds.right + 4;
            void onOpenActions(message, left, bounds.top);
          }}
        >
          <MoreHorizontal size={18} strokeWidth={1.9} />
        </button>
      </div>
    </article>
  );
}

interface ReplyPreview {
  author: string;
  text: string;
}

const senderNameForMessage = (message: Message, users: Map<string, User>, chat: Chat) => {
  if (message.outgoing) return "你";
  return users.get(message.senderId)?.displayName ??
    (chat.kind === "direct" ? chat.title : "Telegram 用户");
};

const replyPreviewFor = (
  message: Message,
  messagesById: Map<string, Message>,
  users: Map<string, User>,
  chat: Chat,
): ReplyPreview | undefined => {
  if (!message.replyTo) return undefined;
  if (message.replyTo.kind === "story") {
    return { author: "动态", text: "回复了一条动态" };
  }
  const target = message.replyTo.messageId
    ? messagesById.get(message.replyTo.messageId)
    : undefined;
  if (target) {
    return {
      author: senderNameForMessage(target, users, chat),
      text: messageSummary(target.content),
    };
  }
  const origin = message.replyTo.origin;
  const author = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? origin.authorSignature
        : undefined;
  return {
    author: author || "回复消息",
    text: message.replyTo.quote ||
      (message.replyTo.content ? messageSummary(message.replyTo.content) : "原消息不可用"),
  };
};

const messageSummary = (content: MessageContent) => {
  const raw = content.kind === "text"
    ? content.text
    : content.caption || content.fileName;
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
};

const localSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};
