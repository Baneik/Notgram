import {
  ArrowDown,
  Check,
  ChevronLeft,
  Forward,
  Edit3,
  MoreVertical,
  LoaderCircle,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
  Reply,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Chat,
  ChatDraft,
  ConnectionStatus,
  Message,
  MessagePermissions,
  ForwardMessagesResult,
  User,
} from "../telegram/types";
import { useComposerAutoResize } from "../hooks/useComposerAutoResize";
import { useConversationSearch } from "../hooks/useConversationSearch";
import {
  useConversationScroll,
  type LatestConversationScrollRequest,
  type MessageConversationScrollRequest,
} from "../hooks/useConversationScroll";
import { useMessageForwarding } from "../hooks/useMessageForwarding";
import { formatMessageDay, localDateKey } from "../utils/formatters";
import {
  groupConsecutiveMessages,
  messageGroupPosition,
} from "../utils/messageGrouping";
import { Avatar } from "./Avatar";
import {
  DeleteMessageDialog,
  ForwardMessagesDialog,
  MessageActionMenu,
} from "./ConversationOverlays";
import {
  forwardLabelFor,
  messageSummary,
  replyPreviewFor,
  senderNameForMessage,
} from "./conversationMessages";
import { MessageBubble as RichMessageBubble } from "./MessageBubble";
import { usePreferencesStore } from "../store/preferencesStore";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { MediaViewer } from "./MediaViewer";
import { MessageRichText } from "./MessageRichText";
import { photoMessages } from "../utils/mediaViewerModel";
import { segmentMediaAlbums } from "../utils/mediaAlbums";

interface ConversationProps {
  chat?: Chat;
  scrollScope: string;
  latestScrollRequest?: LatestConversationScrollRequest;
  messageScrollRequest?: MessageConversationScrollRequest;
  messages: Message[];
  chatDraft?: ChatDraft;
  forwardTargets: Chat[];
  users: Map<string, User>;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  transportKind: "mock" | "tauri";
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  onSendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string) => Promise<boolean>;
  onDeleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  onDraftChange: (chatId: string, text: string, replyToMessageId?: string) => void;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onSetMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  onSearchMessages: (query: string) => Promise<void>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onCancelFileDownload: (fileId: number) => Promise<void>;
  onOpenFile: (sourcePath: string) => Promise<void>;
  onSaveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  onOpenDownloadDirectory: () => Promise<void>;
  onStreamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onSendFile: (file?: File) => Promise<boolean>;
  onCancelFileUpload: (messageId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onOpenProfile: () => void;
  onBack: () => void;
}

export function Conversation({
  chat,
  scrollScope,
  latestScrollRequest,
  messageScrollRequest,
  messages,
  chatDraft,
  forwardTargets,
  users,
  historyLoading,
  hasOlderMessages,
  transportKind,
  connectionStatus,
  queuedMessageCount,
  failedQueuedMessageCount,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onDraftChange,
  onForwardMessages,
  onLoadMessageProperties,
  onSetMessageReaction,
  onSearchMessages,
  onDownloadFile,
  onCancelFileDownload,
  onOpenFile,
  onSaveFileAs,
  onOpenDownloadDirectory,
  onStreamFile,
  onRetryMessage,
  onSendFile,
  onCancelFileUpload,
  onLoadOlder,
  onOpenProfile,
  onBack,
}: ConversationProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [actionMenu, setActionMenu] = useState<{
    messageId: string;
    left: number;
    top: number;
    returnFocus?: HTMLElement;
  }>();
  const [actionLoadingId, setActionLoadingId] = useState<string>();
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [deleteTarget, setDeleteTarget] = useState<Message>();
  const [deletePending, setDeletePending] = useState(false);
  const [viewerMessageId, setViewerMessageId] = useState<string>();
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const autoplayAnimations = usePreferencesStore((state) => state.autoplayAnimations);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const selectionForwardButtonRef = useRef<HTMLButtonElement>(null);
  const draftBeforeEditRef = useRef<string | undefined>(undefined);

  const sendAttachment = async (file?: File) => {
    if (attachmentPending) return;
    setAttachmentPending(true);
    try {
      await onSendFile(file);
    } finally {
      setAttachmentPending(false);
    }
  };

  const displayMessages = useMemo(
    () => chat?.kind === "saved"
      ? messages.map((message) => message.outgoing ? message : { ...message, outgoing: true })
      : messages,
    [chat?.kind, messages],
  );
  const {
    open: searchOpen,
    query: messageSearch,
    visibleMessages,
    setQuery: setMessageSearch,
    close: closeMessageSearch,
    toggle: toggleMessageSearch,
  } = useConversationSearch(chat?.id, displayMessages, onSearchMessages);

  useEffect(() => {
    if (messageScrollRequest?.chatId === chat?.id) closeMessageSearch();
  }, [chat?.id, messageScrollRequest?.chatId, messageScrollRequest?.requestId]);

  const visibleMessageGroups = useMemo(
    () => groupConsecutiveMessages(visibleMessages),
    [visibleMessages],
  );
  const viewerPhotos = useMemo(() => photoMessages(displayMessages), [displayMessages]);

  useEffect(() => {
    setViewerMessageId(undefined);
  }, [chat?.id]);

  useEffect(() => {
    if (viewerMessageId && !viewerPhotos.some((message) => message.id === viewerMessageId)) {
      setViewerMessageId(undefined);
    }
  }, [viewerMessageId, viewerPhotos]);

  const messagesById = useMemo(
    () => new Map(displayMessages.map((message) => [message.id, message])),
    [displayMessages],
  );

  const forwardTargetsById = useMemo(
    () => new Map(forwardTargets.map((target) => [target.id, target])),
    [forwardTargets],
  );
  const forwarding = useMessageForwarding({
    chatId: chat?.id,
    messages,
    messagesById,
    targets: forwardTargets,
    onLoadMessageProperties,
    onForwardMessages,
  });
  const {
    selectedIds: selectedMessageIds,
    loadingIds: selectionLoadingIds,
    selectionMode,
    dialogOpen: forwardDialogOpen,
    query: forwardQuery,
    pending: forwardPending,
    pendingTargetId: forwardPendingTargetId,
    filteredTargets: filteredForwardTargets,
  } = forwarding;
  useComposerAutoResize(composerInputRef, draft, !selectionMode, chat?.id);

  const {
    messageListRef,
    currentScrollKey,
    highlightedMessageId,
    newMessageNotice,
    jumpToLatest,
    messageListHandlers,
  } = useConversationScroll({
    scope: scrollScope,
    chatId: chat?.id,
    latestRequest: latestScrollRequest,
    messageRequest: messageScrollRequest,
    visibleMessages,
    search: messageSearch,
    historyLoading,
    hasOlderMessages,
    messageCount: messages.length,
    onLoadOlder,
  });

  const actionMessage = actionMenu
    ? messagesById.get(actionMenu.messageId)
    : undefined;

  const closeActionMenu = useCallback((restoreFocus = true) => {
    const returnFocus = actionMenu?.returnFocus;
    setActionMenu(undefined);
    if (restoreFocus && returnFocus?.isConnected) {
      globalThis.setTimeout(() => returnFocus.focus(), 0);
    }
  }, [actionMenu]);

  useEffect(() => {
    setActionMenu(undefined);
    setActionLoadingId(undefined);
    setReplyingTo(undefined);
    setEditingMessage(undefined);
    setDeleteTarget(undefined);
    setDeletePending(false);
    setDraft(chatDraft?.text ?? "");
    draftBeforeEditRef.current = undefined;
  }, [chat?.id]);

  useEffect(() => {
    if (!editingMessage) setDraft(chatDraft?.text ?? "");
  }, [chat?.id, chatDraft?.text, editingMessage]);

  useEffect(() => {
    if (editingMessage) return;
    const replyToMessageId = chatDraft?.replyToMessageId;
    if (!replyToMessageId) {
      setReplyingTo(undefined);
      return;
    }
    const target = messagesById.get(replyToMessageId);
    if (target) {
      setReplyingTo((current) => current?.id === target.id ? current : target);
    }
  }, [chat?.id, chatDraft?.replyToMessageId, editingMessage, messagesById]);

  useEffect(() => {
    if (actionMenu && !messagesById.has(actionMenu.messageId)) setActionMenu(undefined);
    if (replyingTo && !messagesById.has(replyingTo.id)) {
      setReplyingTo(undefined);
    }
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
      closeActionMenu(false);
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeActionMenu(true);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [actionMenu, closeActionMenu]);

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

  const openActionMenu = useCallback(async (
    message: Message,
    left: number,
    top: number,
    returnFocus?: HTMLElement,
  ) => {
    const menuWidth = 184;
    const menuHeight = 170;
    setActionMenu({
      messageId: message.id,
      left: Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8)),
      returnFocus,
    });
    if (message.permissions || actionLoadingId === message.id) return;
    setActionLoadingId(message.id);
    await onLoadMessageProperties(message.chatId, message.id);
    setActionLoadingId((current) => current === message.id ? undefined : current);
  }, [actionLoadingId, onLoadMessageProperties]);

  const cancelEditing = () => {
    setEditingMessage(undefined);
    setDraft(chatDraft?.text ?? draftBeforeEditRef.current ?? "");
    draftBeforeEditRef.current = undefined;
    focusComposer();
  };

  const cancelReply = () => {
    setReplyingTo(undefined);
    onDraftChange(chat.id, draft, undefined);
    focusComposer();
  };

  const startReply = (message: Message) => {
    if (editingMessage) {
      setDraft(chatDraft?.text ?? draftBeforeEditRef.current ?? "");
      setEditingMessage(undefined);
      draftBeforeEditRef.current = undefined;
    }
    setReplyingTo(message);
    onDraftChange(chat.id, chatDraft?.text ?? draft, message.id);
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
    const sent = await onSendMessage(submitted, replyingTo?.id ?? chatDraft?.replyToMessageId);
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

  const startForwardSelection = (message: Message) => {
    if (editingMessage) {
      setDraft(chatDraft?.text ?? draftBeforeEditRef.current ?? "");
      setEditingMessage(undefined);
      draftBeforeEditRef.current = undefined;
    }
    setActionMenu(undefined);
    closeMessageSearch();
    forwarding.startSelection(message);
    globalThis.setTimeout(() => selectionForwardButtonRef.current?.focus(), 0);
  };

  const toggleMessageSelection = forwarding.toggleSelection;
  const confirmForward = forwarding.confirm;

  return (
    <section
      className={`conversation ${searchOpen ? "has-message-search" : ""} ${selectionMode ? "is-selecting-messages" : ""}`}
      aria-label={`${chat.title} 对话`}
    >
      <header className={`conversation-header ${selectionMode ? "is-selection-header" : ""}`}>
        {selectionMode ? (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label="取消选择"
              title="取消选择"
              onClick={forwarding.clearSelection}
            >
              <X size={20} strokeWidth={2} />
            </button>
            <div className="message-selection-title">
              <strong>已选择 {selectedMessageIds.size} 条</strong>
              <span>最多可同时转发 100 条消息</span>
            </div>
          </>
        ) : (
          <>
            <button className="mobile-back icon-button" type="button" aria-label="返回会话列表" title="返回会话列表" onClick={onBack}>
              <ChevronLeft size={21} strokeWidth={2} />
            </button>
            <button
              className="conversation-profile-trigger"
              type="button"
              aria-label={`查看 ${chat.title} 资料`}
              title="查看资料"
              onClick={onOpenProfile}
            >
              <Avatar avatar={chat.avatar} size="medium" />
              <span className="conversation-title">
                <strong>{chat.title}</strong>
                <span>{statusLabel}</span>
              </span>
            </button>
            <div className="conversation-actions">
              <button className="icon-button" type="button" aria-label="语音通话" title="语音通话">
                <Phone size={19} strokeWidth={1.8} />
              </button>
              <button
                className={`icon-button ${searchOpen ? "is-active" : ""}`}
                type="button"
                aria-label="搜索消息"
                title="搜索消息"
                onClick={toggleMessageSearch}
              >
                <Search size={19} strokeWidth={1.8} />
              </button>
              <button className="icon-button" type="button" aria-label="更多操作" title="更多操作">
                <MoreVertical size={20} strokeWidth={1.8} />
              </button>
            </div>
          </>
        )}
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
          <button className="icon-button" type="button" aria-label="关闭消息搜索" title="关闭消息搜索" onClick={closeMessageSearch}>
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>
      )}

      <div className="message-list-shell">
        <div
          className="message-list"
          ref={messageListRef}
          role="log"
          aria-label="消息列表"
          tabIndex={0}
          {...messageListHandlers}
        >
          <div className="message-list-content">
          {historyLoading && <div className="history-loading" aria-label="正在加载更早消息"><LoaderCircle className="spin" size={16} /></div>}
          {visibleMessages.length === 0 ? (
            <div className="messages-empty">没有匹配的消息</div>
          ) : (
            visibleMessageGroups.map((messageGroup, groupIndex) => {
            const firstMessage = messageGroup[0];
            const previousMessage = visibleMessageGroups[groupIndex - 1]?.[0];
            const startsNewDay = !previousMessage ||
              localDateKey(previousMessage.sentAt) !== localDateKey(firstMessage.sentAt);
            const showSenderAvatar = firstMessage.content.kind !== "service" &&
              firstMessage.content.kind !== "unsupported" &&
              !firstMessage.outgoing && chat.kind !== "direct";
            const sender = users.get(firstMessage.senderId);
            const senderName = sender?.displayName ??
              (chat.kind === "direct" ? chat.title : "Telegram 用户");
            const senderAvatar = sender?.avatar ??
              (chat.kind === "direct" ? chat.avatar : undefined);
            return (
              <Fragment key={firstMessage.id}>
              {startsNewDay && (
                <div className="message-day">{formatMessageDay(firstMessage.sentAt)}</div>
              )}
              <div
                className={`message-group ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"}`}
              >
                {showSenderAvatar && (
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
                  {(selectionMode
                    ? messageGroup.map((message) => ({ kind: "message" as const, message }))
                    : segmentMediaAlbums(messageGroup)
                  ).map((segment) => {
                    const renderBubble = (message: Message, albumItem = false) => (
                      <RichMessageBubble
                        key={message.id}
                        message={message}
                        sender={sender}
                        senderName={senderName}
                        groupPosition={messageGroupPosition(
                          messageGroup,
                          messageGroup.findIndex((candidate) => candidate.id === message.id),
                        )}
                        replyPreview={replyPreviewFor(message, messagesById, users, chat)}
                        forwardLabel={forwardLabelFor(message, users, forwardTargetsById)}
                        selectionMode={selectionMode}
                        selected={selectedMessageIds.has(message.id)}
                        highlighted={highlightedMessageId === message.id}
                        selectionPending={selectionLoadingIds.has(message.id)}
                        selectionLimitReached={selectedMessageIds.size >= 100}
                        onToggleSelection={toggleMessageSelection}
                        onOpenActions={openActionMenu}
                        onDownload={onDownloadFile}
                        onCancelDownload={onCancelFileDownload}
                        onOpenFile={onOpenFile}
                        onSaveFileAs={onSaveFileAs}
                        onOpenDownloadDirectory={onOpenDownloadDirectory}
                        onStream={onStreamFile}
                        onRetry={onRetryMessage}
                        onCancelUpload={onCancelFileUpload}
                        onReaction={onSetMessageReaction}
                        onOpenMedia={selectionMode ? undefined : setViewerMessageId}
                        albumItem={albumItem}
                        autoplayAnimations={autoplayAnimations}
                        developerMode={developerMode}
                      />
                    );
                    if (segment.kind === "message") return renderBubble(segment.message);

                    const captionMessages = segment.messages.filter((message) =>
                      message.content.kind === "media" && Boolean(message.content.caption),
                    );
                    return (
                      <div
                        className={`media-album ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"}`}
                        data-media-album-id={segment.albumId}
                        key={`album:${segment.albumId}:${segment.messages[0]?.id}`}
                        role="group"
                        aria-label={`${segment.messages.length} 项媒体相册`}
                      >
                        <div
                          className="media-album-grid"
                          data-count={Math.min(segment.messages.length, 5)}
                        >
                          {segment.messages.map((message) => renderBubble(message, true))}
                        </div>
                        {captionMessages.length > 0 && (
                          <div className="media-album-captions">
                            {captionMessages.map((message) => {
                              const content = message.content;
                              return content.kind === "media" && content.caption ? (
                                <div className="media-album-caption-entry" key={message.id}>
                                  <MessageRichText
                                    className="media-album-caption"
                                    text={content.caption}
                                    entities={content.captionEntities}
                                  />
                                </div>
                              ) : null;
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              </Fragment>
            );
            })
          )}
          </div>
        </div>
        {!messageSearch &&
          currentScrollKey &&
          newMessageNotice?.key === currentScrollKey &&
          newMessageNotice.count > 0 && (
            <button
              className="jump-to-latest"
              type="button"
              aria-label={`跳到最新消息，${newMessageNotice.count} 条新消息`}
              title="跳到最新消息"
              onClick={jumpToLatest}
            >
              <ArrowDown size={19} strokeWidth={2.1} />
              <span>{newMessageNotice.count > 99 ? "99+" : newMessageNotice.count}</span>
            </button>
          )}
      </div>

      {actionMenu && actionMessage && (
        <MessageActionMenu
          position={actionMenu}
          message={actionMessage}
          loading={actionLoadingId === actionMessage.id}
          onReaction={(emoji, chosen) => {
            closeActionMenu(true);
            void onSetMessageReaction(actionMessage.id, emoji, chosen);
          }}
          onReply={() => startReply(actionMessage)}
          onEdit={() => startEditing(actionMessage)}
          onForward={() => startForwardSelection(actionMessage)}
          onDelete={() => {
            setDeleteTarget(actionMessage);
            setActionMenu(undefined);
          }}
          onClose={() => closeActionMenu(true)}
        />
      )}

      {selectionMode ? (
        <div className="message-selection-bar">
          <span>{selectedMessageIds.size} 条消息</span>
          <button
            ref={selectionForwardButtonRef}
            className="selection-forward-button"
            type="button"
            onClick={forwarding.openDialog}
          >
            <Forward size={18} strokeWidth={1.9} />
            转发
          </button>
        </div>
      ) : (
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
        {connectionStatus !== "online" && (
          <ConnectionStatusIndicator
            className="composer-connection-status"
            status={connectionStatus}
          />
        )}
        {(queuedMessageCount > 0 || failedQueuedMessageCount > 0) && (
          <div className="composer-outbox-status" role="status">
            {failedQueuedMessageCount > 0
              ? `${failedQueuedMessageCount} 条离线消息需要手动重试`
              : `${queuedMessageCount} 条消息将在联网后发送`}
          </div>
        )}
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
              onClick={editingMessage ? cancelEditing : cancelReply}
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
            onChange={(event) => {
              const value = event.target.value;
              setDraft(value);
              if (!editingMessage) {
                onDraftChange(
                  chat.id,
                  value,
                  replyingTo?.id ?? chatDraft?.replyToMessageId,
                );
              }
            }}
            onKeyDown={async (event) => {
              const submitWithKeyboard = event.key === "Enter" && (
                (sendOnEnter && !event.shiftKey) ||
                (!sendOnEnter && (event.ctrlKey || event.metaKey))
              );
              if (submitWithKeyboard) {
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
      )}

      {deleteTarget && (
        <DeleteMessageDialog
          message={deleteTarget}
          pending={deletePending}
          onConfirm={(revoke) => void confirmDelete(revoke)}
          onClose={() => setDeleteTarget(undefined)}
        />
      )}

      {forwardDialogOpen && selectionMode && (
        <ForwardMessagesDialog
          selectedCount={selectedMessageIds.size}
          targets={filteredForwardTargets}
          currentChatId={chat.id}
          query={forwardQuery}
          pending={forwardPending}
          pendingTargetId={forwardPendingTargetId}
          onQueryChange={forwarding.setQuery}
          onConfirm={(target) => void confirmForward(target)}
          onClose={forwarding.closeDialog}
        />
      )}

      {viewerMessageId && (
        <MediaViewer
          messages={viewerPhotos}
          activeMessageId={viewerMessageId}
          onActiveMessageChange={setViewerMessageId}
          onClose={() => setViewerMessageId(undefined)}
          onDownload={onDownloadFile}
        />
      )}
    </section>
  );
}
