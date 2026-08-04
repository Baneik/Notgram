import {
  ArrowDown,
  ChevronLeft,
  Forward,
  MoreVertical,
  LoaderCircle,
  Phone,
  Search,
  X,
} from "lucide-react";
import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso, type Components, type ListProps } from "react-virtuoso";
import type {
  Chat,
  ConnectionStatus,
  Message,
  MessagePermissions,
  ForwardMessagesResult,
  User,
} from "../telegram/types";
import { useConversationSearch } from "../hooks/useConversationSearch";
import {
  useConversationScroll,
  type EntryConversationScrollRequest,
  type LatestConversationScrollRequest,
  type MessageConversationScrollRequest,
} from "../hooks/useConversationScroll";
import { useMessageForwarding } from "../hooks/useMessageForwarding";
import { formatMessageDay } from "../utils/formatters";
import { Avatar } from "./Avatar";
import {
  DeleteMessageDialog,
  ForwardMessagesDialog,
  MessageActionMenu,
} from "./ConversationOverlays";
import {
  forwardLabelFor,
  replyPreviewFor,
  senderNameForMessage,
} from "./conversationMessages";
import { MessageBubble as RichMessageBubble } from "./MessageBubble";
import { usePreferencesStore } from "../store/preferencesStore";
import { ConversationComposer } from "./ConversationComposer";
import { MediaViewer } from "./MediaViewer";
import { MessageRichText } from "./MessageRichText";
import { photoMessages } from "../utils/mediaViewerModel";
import {
  indexMessagesByVirtualBlock,
  virtualizeMessageGroups,
  type VirtualMessageBlock,
} from "../utils/messageVirtualization";
import { requestVideoWindowPlayback } from "../media/videoWindowBridge";
import { ChatActionMenu } from "./ChatActionMenu";
import { writeClipboardText } from "../utils/clipboard";
import { useTelegramStore } from "../store/telegramStore";

const VirtualMessageListContent = forwardRef<HTMLDivElement, ListProps>((props, ref) => (
  <div {...props} className="message-list-content" ref={ref} />
));
VirtualMessageListContent.displayName = "VirtualMessageListContent";

const EmptyMessageList = () => <div className="messages-empty">没有匹配的消息</div>;

const messageListComponents: Components<VirtualMessageBlock> = {
  EmptyPlaceholder: EmptyMessageList,
  List: VirtualMessageListContent,
};

interface ConversationProps {
  chat?: Chat;
  scrollScope: string;
  entryScrollRequest?: EntryConversationScrollRequest;
  latestScrollRequest?: LatestConversationScrollRequest;
  messageScrollRequest?: MessageConversationScrollRequest;
  messages: Message[];
  forwardTargets: Chat[];
  users: Map<string, User>;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  transportKind: "mock" | "tauri";
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  typingUserIds: string[];
  chatListId: string;
  chatManagementPending: boolean;
  onSendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string) => Promise<boolean>;
  onDeleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  onDraftChange: (chatId: string, text: string, replyToMessageId?: string) => void;
  onTypingChange: (chatId: string, typing: boolean) => Promise<void>;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onLoadRawMessage: (chatId: string, messageId: string) => Promise<string | undefined>;
  onSetMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  onSearchMessages: (query: string) => Promise<void>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onCancelFileDownload: (fileId: number) => Promise<void>;
  onOpenFile: (sourcePath: string) => Promise<void>;
  onSaveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  onOpenDownloadDirectory: () => Promise<void>;
  onStreamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendFileStream: (fileId: number) => Promise<void>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onSendFile: (file?: File) => Promise<boolean>;
  onCancelFileUpload: (messageId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onOpenProfile: () => void;
  onSetChatPinned: (pinned: boolean) => Promise<boolean>;
  onSetChatMuted: (muted: boolean) => Promise<boolean>;
  onSetChatArchived: (archived: boolean) => Promise<boolean>;
  onBack: () => void;
}

export function Conversation({
  chat,
  scrollScope,
  entryScrollRequest,
  latestScrollRequest,
  messageScrollRequest,
  messages,
  forwardTargets,
  users,
  historyLoading,
  hasOlderMessages,
  transportKind,
  connectionStatus,
  queuedMessageCount,
  failedQueuedMessageCount,
  typingUserIds,
  chatListId,
  chatManagementPending,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onDraftChange,
  onTypingChange,
  onForwardMessages,
  onLoadMessageProperties,
  onLoadRawMessage,
  onSetMessageReaction,
  onSearchMessages,
  onDownloadFile,
  onCancelFileDownload,
  onOpenFile,
  onSaveFileAs,
  onOpenDownloadDirectory,
  onStreamFile,
  onSuspendFileStream,
  onRetryMessage,
  onSendFile,
  onCancelFileUpload,
  onLoadOlder,
  onOpenProfile,
  onSetChatPinned,
  onSetChatMuted,
  onSetChatArchived,
  onBack,
}: ConversationProps) {
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
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const draftReplyToMessageId = useTelegramStore((state) =>
    chat ? state.drafts.get(chat.id)?.replyToMessageId : undefined,
  );
  const autoplayAnimations = usePreferencesStore((state) => state.autoplayAnimations);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const autoDownloadImages = usePreferencesStore((state) => state.autoDownloadImages);
  const autoDownloadVideos = usePreferencesStore((state) => state.autoDownloadVideos);
  const autoDownloadAudio = usePreferencesStore((state) => state.autoDownloadAudio);
  const autoDownloadFiles = usePreferencesStore((state) => state.autoDownloadFiles);
  const autoDownloadLimitMb = usePreferencesStore((state) => state.autoDownloadLimitMb);
  const autoDownloadPolicy = useMemo(() => ({
    images: autoDownloadImages,
    videos: autoDownloadVideos,
    audio: autoDownloadAudio,
    files: autoDownloadFiles,
    limitMb: autoDownloadLimitMb,
  }), [
    autoDownloadAudio,
    autoDownloadFiles,
    autoDownloadImages,
    autoDownloadLimitMb,
    autoDownloadVideos,
  ]);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const selectionForwardButtonRef = useRef<HTMLButtonElement>(null);
  const chatMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [messageListScrolling, setMessageListScrolling] = useState(false);

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

  const visibleMessageBlocks = useMemo(
    () => virtualizeMessageGroups(visibleMessages),
    [visibleMessages],
  );
  const messageItemIndexes = useMemo(
    () => indexMessagesByVirtualBlock(visibleMessageBlocks),
    [visibleMessageBlocks],
  );
  const viewerPhotos = useMemo(() => photoMessages(displayMessages), [displayMessages]);

  useEffect(() => {
    setViewerMessageId(undefined);
    setChatMenuOpen(false);
  }, [chat?.id]);

  const closeChatMenu = useCallback((restoreFocus = true) => {
    setChatMenuOpen(false);
    if (restoreFocus) globalThis.setTimeout(() => chatMenuButtonRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!chatMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".chat-action-menu") || chatMenuButtonRef.current?.contains(target))
      ) return;
      closeChatMenu(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [chatMenuOpen, closeChatMenu]);

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
  const {
    setMessageListRef,
    virtuosoRef,
    currentScrollKey,
    positioning,
    initialTopMostItemIndex,
    restoreStateFrom,
    highlightedMessageId,
    newMessageNotice,
    jumpToLatest,
    followOutput,
    onTotalListHeightChanged,
    messageListHandlers,
  } = useConversationScroll({
    scope: scrollScope,
    chatId: chat?.id,
    entryRequest: entryScrollRequest,
    latestRequest: latestScrollRequest,
    messageRequest: messageScrollRequest,
    visibleMessages,
    messageItemIndexes,
    virtualItemCount: visibleMessageBlocks.length,
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
  }, [chat?.id]);

  useEffect(() => {
    if (editingMessage) return;
    const replyToMessageId = draftReplyToMessageId;
    if (!replyToMessageId) {
      setReplyingTo(undefined);
      return;
    }
    const target = messagesById.get(replyToMessageId);
    if (target) {
      setReplyingTo((current) => current?.id === target.id ? current : target);
    }
  }, [chat?.id, draftReplyToMessageId, editingMessage, messagesById]);

  useEffect(() => {
    if (actionMenu && !messagesById.has(actionMenu.messageId)) setActionMenu(undefined);
    if (replyingTo && !messagesById.has(replyingTo.id)) {
      setReplyingTo(undefined);
    }
    if (editingMessage && !messagesById.has(editingMessage.id)) {
      setEditingMessage(undefined);
    }
    if (deleteTarget && !messagesById.has(deleteTarget.id)) setDeleteTarget(undefined);
  }, [actionMenu, deleteTarget, editingMessage, messagesById, replyingTo]);

  useEffect(() => {
    if (!actionMenu) return;
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeActionMenu(true);
    };
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
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

  const composerContextTitle = editingMessage
    ? "编辑消息"
    : replyingTo
      ? `回复 ${senderNameForMessage(replyingTo, users, chat)}`
      : undefined;
  const typingNames = typingUserIds.map((userId) => users.get(userId)?.displayName ?? "成员");
  const typingStatus = typingUserIds.length === 0 || chat.kind === "saved" || chat.kind === "channel"
    ? undefined
    : chat.kind === "direct"
      ? "正在输入..."
      : typingUserIds.length === 1
        ? `${typingNames[0]} 正在输入...`
        : typingUserIds.length === 2
          ? `${typingNames.join("、")} 正在输入...`
          : `${typingNames.slice(0, 2).join("、")} 等 ${typingUserIds.length} 人正在输入...`;

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
    const menuHeight = developerMode ? 206 : 170;
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
  }, [actionLoadingId, developerMode, onLoadMessageProperties]);

  const copyRawMessage = async (message: Message) => {
    const raw = await onLoadRawMessage(message.chatId, message.id);
    if (!raw) return;
    try {
      await writeClipboardText(raw);
      closeActionMenu(false);
    } catch {
      // Keep the menu open so the user can retry after clipboard access is restored.
    }
  };

  const cancelEditing = () => {
    setEditingMessage(undefined);
    focusComposer();
  };

  const cancelReply = () => {
    setReplyingTo(undefined);
    focusComposer();
  };

  const startReply = (message: Message) => {
    if (editingMessage) {
      setEditingMessage(undefined);
    }
    setReplyingTo(message);
    setActionMenu(undefined);
    focusComposer();
  };

  const startEditing = (message: Message) => {
    if (message.content.kind !== "text") return;
    setReplyingTo(undefined);
    setEditingMessage(message);
    setActionMenu(undefined);
    focusComposer();
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
      setEditingMessage(undefined);
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
                {typingStatus && <span className="conversation-typing-status" role="status">{typingStatus}</span>}
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
              <button
                ref={chatMenuButtonRef}
                className={`icon-button ${chatMenuOpen ? "is-active" : ""}`}
                type="button"
                aria-label="更多操作"
                title="更多操作"
                aria-haspopup="menu"
                aria-expanded={chatMenuOpen}
                disabled={chatManagementPending}
                onClick={() => setChatMenuOpen((open) => !open)}
              >
                <MoreVertical size={20} strokeWidth={1.8} />
              </button>
              {chatMenuOpen && (
                <ChatActionMenu
                  chat={chat}
                  chatListId={chatListId}
                  pending={chatManagementPending}
                  onSetPinned={onSetChatPinned}
                  onSetMuted={onSetChatMuted}
                  onSetArchived={onSetChatArchived}
                  onClose={() => closeChatMenu(true)}
                />
              )}
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

      <div className={`message-list-shell ${positioning ? "is-positioning" : ""}`}>
        {positioning && (visibleMessages.length === 0 || !restoreStateFrom) && (
          <div className="message-positioning-placeholder" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>正在加载消息</span>
          </div>
        )}
        {historyLoading && (
          <div className="history-loading" aria-label="正在加载更早消息">
            <LoaderCircle className="spin" size={16} />
          </div>
        )}
        <Virtuoso
          key={currentScrollKey}
          className={`message-list ${messageListScrolling ? "is-scrolling" : ""}`}
          ref={virtuosoRef}
          scrollerRef={setMessageListRef}
          isScrolling={setMessageListScrolling}
          role="log"
          aria-label="消息列表"
          aria-busy={positioning}
          tabIndex={0}
          alignToBottom
          components={messageListComponents}
          computeItemKey={(_, block) => block.id}
          data={visibleMessageBlocks}
          defaultItemHeight={52}
          followOutput={followOutput}
          initialTopMostItemIndex={restoreStateFrom ? undefined : initialTopMostItemIndex}
          restoreStateFrom={restoreStateFrom}
          skipAnimationFrameInResizeObserver
          totalListHeightChanged={onTotalListHeightChanged}
          increaseViewportBy={{ top: 900, bottom: 280 }}
          minOverscanItemCount={{ top: 2, bottom: 2 }}
          {...messageListHandlers}
          itemContent={(_, groupModel) => {
            const { firstMessage, messages: messageGroup, positions, startsNewDay } = groupModel;
            const reserveSenderAvatar = firstMessage.content.kind !== "service" &&
              firstMessage.content.kind !== "unsupported" &&
              !firstMessage.outgoing && chat.kind !== "direct";
            const showSenderAvatar = reserveSenderAvatar && !groupModel.continuesAfter;
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
                className={`message-group ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"} ${groupModel.continuesBefore ? "continues-before" : ""} ${groupModel.continuesAfter ? "continues-after" : ""} ${groupModel.id === visibleMessageBlocks.at(-1)?.id ? "is-last-visible" : ""}`}
              >
                {reserveSenderAvatar && (
                  <span className="message-group-avatar">
                    {showSenderAvatar && (
                      <Avatar
                        avatar={senderAvatar ?? {
                          label: Array.from(senderName.trim())[0] ?? "?",
                          color: "#73828c",
                        }}
                        size="small"
                      />
                    )}
                  </span>
                )}
                <div className="message-group-stack">
                  {(selectionMode
                    ? messageGroup.map((message) => ({ kind: "message" as const, message }))
                    : groupModel.segments
                  ).map((segment) => {
                    const renderBubble = (message: Message, albumItem = false) => (
                      <RichMessageBubble
                        key={message.id}
                        message={message}
                        sender={sender}
                        senderName={senderName}
                        groupPosition={positions.get(message.id) ?? "single"}
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
                        onSuspendStream={onSuspendFileStream}
                        onRetry={onRetryMessage}
                        onCancelUpload={onCancelFileUpload}
                        onReaction={onSetMessageReaction}
                        onOpenMedia={selectionMode ? undefined : setViewerMessageId}
                        albumItem={albumItem}
                        autoplayAnimations={autoplayAnimations}
                        autoDownloadPolicy={autoDownloadPolicy}
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
          }}
        />
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
          onPlayInWindow={actionMessage.content.kind === "media" &&
            ["video", "videoNote"].includes(actionMessage.content.mediaType)
            ? () => {
                closeActionMenu(false);
                requestVideoWindowPlayback(`${actionMessage.chatId}:${actionMessage.id}`);
              }
            : undefined}
          onDownloadVideo={actionMessage.content.kind === "media" &&
            ["video", "videoNote"].includes(actionMessage.content.mediaType) &&
            actionMessage.content.fileId !== undefined &&
            actionMessage.content.canDownload !== false &&
            actionMessage.content.isDownloaded !== true &&
            actionMessage.content.isDownloading !== true
            ? () => {
                const content = actionMessage.content;
                if (content.kind !== "media" || content.fileId === undefined) return;
                closeActionMenu(false);
                void onDownloadFile(
                  content.fileId,
                  content.fileName,
                );
              }
            : undefined}
          onCopyRaw={developerMode ? () => void copyRawMessage(actionMessage) : undefined}
          onDismiss={() => closeActionMenu(false)}
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
      <ConversationComposer
        key={chat.id}
        chat={chat}
        editingMessage={editingMessage}
        replyingTo={replyingTo}
        contextTitle={composerContextTitle}
        inputRef={composerInputRef}
        transportKind={transportKind}
        connectionStatus={connectionStatus}
        queuedMessageCount={queuedMessageCount}
        failedQueuedMessageCount={failedQueuedMessageCount}
        onSendMessage={onSendMessage}
        onEditMessage={onEditMessage}
        onDraftChange={onDraftChange}
        onTypingChange={onTypingChange}
        onSendFile={onSendFile}
        onCancelEditing={cancelEditing}
        onCancelReply={cancelReply}
      />
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
