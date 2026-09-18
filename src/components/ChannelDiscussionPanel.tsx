import { servicePersonIds } from "../telegram/serviceMessages";
import { useLocalUserBlocks } from "../store/localUserBlocks";
import { replySenderId } from "../utils/localBlockedMessages";
import { audioMessageNeighbors } from "../media/audioMessageQueue";
import { ConversationViewportBoundary } from "./ConversationViewportBoundary";
import { useDiscussionRead } from "../hooks/useDiscussionRead";
import { outboxCounts } from "../store/telegramStore.outbox";
import { translate } from "../i18n";
import type { ComposerInputElement } from "./ComposerInput";
import { useEditVisibleMessage } from "../hooks/useEditVisibleMessage";
import { isEditableMessageContent } from "../telegram/messageContent";
import {
  Check,
  ChevronLeft,
  Copy,
  Forward,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMessageForwarding } from "../hooks/useMessageForwarding";
import { useTelegramStore } from "../store/telegramStore";
import type {
  Chat,
  ChatReportResult,
  ConnectionStatus,
  ForumTopic,
  ForumTopicPage,
  ForwardMessagesResult,
  Message,
  MessagePermissions,
  MessageReplyQuote,
  MessageTextEntity,
  OutgoingAttachment,
  ReportChatInput,
  User,
} from "../telegram/types";
import { copyMessageContent, writeClipboardText } from "../utils/clipboard";
import {
  mentionTextForUser,
  type ComposerTextInsertion,
} from "../utils/composerInsertion";
import { formatSelectedMessages } from "../utils/messageClipboard";
import { recentMentionUserIdsFor } from "../utils/mentionSuggestions";
import { Avatar } from "./Avatar";
import { ConversationComposer } from "./ConversationComposer";
import { focusComposerFromPointer, useComposerFocus } from "../hooks/useComposerFocus";
import {
  DeleteMessagesDialog,
  MessageActionMenu,
  PinMessageDialog,
  SenderActionMenu,
} from "./ConversationOverlays";
import {
  channelAuthorFor,
  displaysChannelMetadata,
  forwardSourceFor,
  messageSummary,
  replyPreviewFor,
  serviceTargetSummary,
} from "./conversationMessages";
import { ForwardMessagesDialog } from "./ForwardMessagesDialog";
import { MessageBubblePreview, type MessageBubblePreviewProps } from "./MessageBubble";
import { MotionPresence } from "./MotionPresence";
import { ReportDialog } from "./ReportDialog";
import { requestVideoWindowPlayback } from "../media/videoWindowBridge";

interface ChannelDiscussionPanelProps {
  post: Message;
  channel: Chat;
  comments: Message[];
  users: ReadonlyMap<string, User>;
  knownNonBotUsernames?: ReadonlySet<string>;
  forwardTargets: Chat[];
  forumTopics: Map<string, ForumTopic[]>;
  currentUserId: string;
  connectionStatus: ConnectionStatus;
  loading: boolean;
  loadError?: boolean;
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  onClose: () => void;
  onSend: (
    text: string,
    replyToMessageId?: string,
    replyQuote?: MessageReplyQuote,
    entities?: MessageTextEntity[],
    _disableNotification?: boolean,
  ) => Promise<boolean>;
  onSendFiles: (
    attachments: OutgoingAttachment[],
    caption?: string,
    captionEntities?: MessageTextEntity[],
    replyToMessageId?: string,
    replyQuote?: MessageReplyQuote,
    _disableNotification?: boolean,
  ) => Promise<boolean>;
  onEditMessage: (
    messageId: string,
    text: string,
    entities?: MessageTextEntity[],
    chatId?: string,
  ) => Promise<boolean>;
  onDeleteMessage: (messageId: string, revoke: boolean, chatId?: string) => Promise<boolean>;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
    toTopicId?: string,
    description?: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
    force?: boolean,
    signal?: AbortSignal,
  ) => Promise<MessagePermissions | undefined>;
  onLoadForumTopics: (chatId: string) => Promise<ForumTopicPage | undefined>;
  onTypingChange: (chatId: string, typing: boolean) => Promise<void>;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onOpenChat: (chatId: string) => void;
  onOpenSenderProfile: (senderId: string) => void;
  onOpenMention: (username?: string, userId?: string) => void;
  onSearchHashtag: (hashtag: string, chatId?: string) => void;
  onOpenMessageSearch: (senderId?: string, chatId?: string) => void;
  onStartPrivateChat: (senderId: string) => void;
  onGetReportOptions: (chatId: string, messageIds: string[]) => Promise<ChatReportResult>;
  onReportChat: (input: ReportChatInput) => Promise<ChatReportResult>;
  onPinMessage: (
    messageId: string,
    disableNotification: boolean,
    onlyForSelf: boolean,
    chatId?: string,
  ) => Promise<boolean>;
  onUnpinMessage: (messageId: string, chatId?: string) => Promise<boolean>;
  messagePreviewOptions?: Partial<Omit<MessageBubblePreviewProps, "message" | "senderName" | "users">>;
}

interface MessageMenuState {
  messageId: string;
  left: number;
  top: number;
  replyQuote?: MessageReplyQuote;
  keyboardNavigation?: boolean;
}

const senderFor = (
  message: Message,
  users: ReadonlyMap<string, User>,
  chats: ReadonlyMap<string, Chat>,
  currentUserId: string,
) => {
  if (message.senderId === currentUserId || message.outgoing) return translate("你");
  if (message.senderId.startsWith("chat:")) {
    return chats.get(message.senderId.slice("chat:".length))?.title ?? translate("频道管理员");
  }
  return users.get(message.senderId)?.displayName ?? translate("Telegram 用户");
};

const avatarFor = (
  message: Message,
  users: ReadonlyMap<string, User>,
  chats: ReadonlyMap<string, Chat>,
  currentUserId: string,
) => {
  if (message.senderId === currentUserId || message.outgoing) {
    return users.get(currentUserId)?.avatar ?? { label: translate("我"), color: "#d16f45" };
  }
  if (message.senderId.startsWith("chat:")) {
    return chats.get(message.senderId.slice("chat:".length))?.avatar ?? { label: translate("频"), color: "#73828c" };
  }
  return users.get(message.senderId)?.avatar ?? { label: "?", color: "#73828c" };
};

export function ChannelDiscussionPanel({
  post,
  channel,
  comments,
  users,
  knownNonBotUsernames = new Set(),
  forwardTargets,
  forumTopics,
  currentUserId,
  connectionStatus,
  loading,
  loadError = false,
  onRetry,
  hasMore,
  onLoadMore,
  onClose,
  onSend,
  onSendFiles,
  onEditMessage,
  onDeleteMessage,
  onForwardMessages,
  onLoadMessageProperties,
  onLoadForumTopics,
  onTypingChange,
  onOpenMessage,
  onOpenChat,
  onOpenSenderProfile,
  onOpenMention,
  onSearchHashtag,
  onOpenMessageSearch,
  onStartPrivateChat,
  onGetReportOptions,
  onReportChat,
  onPinMessage,
  onUnpinMessage,
  messagePreviewOptions,
}: ChannelDiscussionPanelProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const captureScroll = useCallback((structuralChange: boolean) => {
    const element = scrollerRef.current;
    if (!structuralChange || !element) return;
    const top = element.scrollTop, height = element.scrollHeight;
    return () => { element.scrollTop = top + element.scrollHeight - height; };
  }, []);
  const inputRef = useRef<ComposerInputElement>(null);
  const insertionIdRef = useRef(0);
  const discussionChatId = post.discussionThread?.chatId ?? comments[0]?.chatId ?? post.chatId;
  const draftKey = `${post.chatId}:discussion:${post.id}`;
  const storedDiscussionChat = useTelegramStore((state) => state.chats.get(discussionChatId));
  const outbox = useTelegramStore((state) => state.outbox);
  const threadId = post.discussionThread?.messageId ?? post.id;
  const queueCounts = useMemo(() => outboxCounts(outbox.filter(item =>
    item.chatId === discussionChatId && item.discussionThreadId === threadId)), [outbox, discussionChatId, threadId]);
  const administratorLabels = useTelegramStore((state) => state.chatAdministratorLabels.get(discussionChatId));
  const loadChatAdministratorLabels = useTelegramStore((state) => state.loadChatAdministratorLabels);
  const updateThreadDraft = useTelegramStore((state) => state.updateThreadDraft);
  const markMessageThreadRead = useTelegramStore((state) => state.markMessageThreadRead);
  useDiscussionRead(scrollerRef, draftKey, discussionChatId, comments,
    connectionStatus === "online" && discussionChatId !== post.chatId, markMessageThreadRead);
  const getBotCommandSuggestions = useTelegramStore((state) => state.getBotCommandSuggestions);
  const getInlineQueryResults = useTelegramStore((state) => state.getInlineQueryResults);
  const sendInlineQueryResultMessage = useTelegramStore((state) => state.sendInlineQueryResultMessage);
  const sendBotStartMessage = useTelegramStore((state) => state.sendBotStartMessage);
  const activeAccountId = useTelegramStore(state => state.activeAccountId);
  const blockedUsers = useLocalUserBlocks(state => state.users);
  const blockedById = useMemo(() => new Map(blockedUsers.filter(user => user.accountId === activeAccountId)
    .map(user => [user.userId, user])), [activeAccountId, blockedUsers]);
  const [revealedMessages, setRevealedMessages] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setRevealedMessages(new Set()); }, [activeAccountId, draftKey]);
  const audioNeighbors = useMemo(() => audioMessageNeighbors(comments.filter(message =>
    !blockedById.has(message.senderId) || revealedMessages.has(message.id))), [comments, blockedById, revealedMessages]);
  const usersById = useMemo(() => new Map(users), [users]);
  const messagesById = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );
  const discussionChat = useMemo<Chat>(() => storedDiscussionChat ?? (discussionChatId === channel.id
    ? channel
    : {
        ...channel,
        id: discussionChatId,
        kind: "group",
        title: translate("{{value0}} 讨论", { value0: channel.title }),
      }), [channel, discussionChatId, storedDiscussionChat]);
  const targetChatsById = useMemo(() => new Map([
    ...forwardTargets.map((target) => [target.id, target] as const),
    [channel.id, channel] as const,
    [discussionChat.id, discussionChat] as const,
  ]), [channel, discussionChat, forwardTargets]);
  const recentMentionUserIds = useMemo(() => recentMentionUserIdsFor(comments), [comments]);
  const memberLabels = useMemo(
    () => new Map(Object.entries(administratorLabels ?? {})),
    [administratorLabels],
  );
  const [actionMenu, setActionMenu] = useState<MessageMenuState>();
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [replyQuote, setReplyQuote] = useState<MessageReplyQuote>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [deleteTarget, setDeleteTarget] = useState<Message>();
  const [deletePending, setDeletePending] = useState(false);
  const [reportTarget, setReportTarget] = useState<Message>();
  const [pinTarget, setPinTarget] = useState<Message>();
  const [pinPending, setPinPending] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [senderMenu, setSenderMenu] = useState<{
    senderId: string;
    senderName: string;
    x: number;
    y: number;
  }>();
  const [textInsertion, setTextInsertion] = useState<ComposerTextInsertion>();
  const [selectionCopying, setSelectionCopying] = useState(false);
  const [selectionCopied, setSelectionCopied] = useState(false);

  const forwarding = useMessageForwarding({
    chatId: discussionChatId,
    conversationIdentity: draftKey,
    messages: comments,
    messagesById,
    targets: forwardTargets,
    onLoadMessageProperties,
    onForwardMessages,
  });
  const actionMessage = actionMenu ? messagesById.get(actionMenu.messageId) : undefined;
  const actionAlbumMessageIds = actionMessage?.mediaAlbumId
    ? comments.filter((message) => message.mediaAlbumId === actionMessage.mediaAlbumId).map((message) => message.id)
    : [];

  const composerFocus = useComposerFocus(inputRef, `${activeAccountId}:${discussionChatId}:${draftKey}`,
    !forwarding.selectionMode);
  const focusComposer = composerFocus.request;

  useLayoutEffect(() => {
    focusComposer();
  }, [draftKey, focusComposer]);
  useLayoutEffect(() => {
    if (!forwarding.selectionMode) focusComposer({ reason: "entry" });
  }, [focusComposer, forwarding.selectionMode]);

  useEffect(() => {
    if (discussionChat.kind !== "group" && discussionChat.kind !== "channel") return;
    void loadChatAdministratorLabels(discussionChatId, true);
  }, [discussionChat.kind, discussionChatId, loadChatAdministratorLabels]);

  useEffect(() => {
    setActionMenu(undefined);
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    setEditingMessage(undefined);
    setDeleteTarget(undefined);
    setReportTarget(undefined);
    setPinTarget(undefined);
    setSenderMenu(undefined);
    setTextInsertion(undefined);
    setHighlightedMessageId(undefined);
  }, [draftKey]);

  useEffect(() => {
    if (actionMenu && !messagesById.has(actionMenu.messageId)) setActionMenu(undefined);
    if (replyingTo && !messagesById.has(replyingTo.id)) {
      setReplyingTo(undefined);
      setReplyQuote(undefined);
    }
    if (editingMessage && !messagesById.has(editingMessage.id)) setEditingMessage(undefined);
    if (deleteTarget && !messagesById.has(deleteTarget.id)) setDeleteTarget(undefined);
  }, [actionMenu, deleteTarget, editingMessage, messagesById, replyingTo]);

  const closeActionMenu = useCallback(() => {
    setActionMenu(undefined);
    focusComposer();
  }, [focusComposer]);

  const openMessageActions: NonNullable<MessageBubblePreviewProps["onOpenActions"]> = useCallback(async (
    message,
    left,
    top,
    _returnFocus,
    selectedReplyQuote,
    keyboardNavigation,
  ) => {
    if (blockedById.has(message.senderId) && !revealedMessages.has(message.id)) return;
    setActionMenu({
      messageId: message.id,
      left,
      top,
      replyQuote: selectedReplyQuote,
      keyboardNavigation,
    });
  }, [blockedById, revealedMessages]);

  const startReply = useCallback((message: Message, selectedQuote?: MessageReplyQuote) => {
    setEditingMessage(undefined);
    setReplyingTo(message);
    setReplyQuote(selectedQuote);
    setActionMenu(undefined);
    composerFocus.capture(true)();
  }, [composerFocus]);

  const startEditing = useCallback((message: Message) => {
    if (!isEditableMessageContent(message.content)) return;
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    setEditingMessage(message);
    setActionMenu(undefined);
    focusComposer();
  }, [focusComposer]);

  const editLatestVisible = useEditVisibleMessage(inputRef, scrollerRef, comments,
    draftKey, onLoadMessageProperties, startEditing);

  const confirmDelete = useCallback(async (revoke: boolean) => {
    if (!deleteTarget || deletePending) return;
    const restoreFocus = composerFocus.capture();
    setDeletePending(true);
    const deleted = await onDeleteMessage(deleteTarget.id, revoke, deleteTarget.chatId);
    setDeletePending(false);
    if (deleted) setDeleteTarget(undefined);
    restoreFocus();
  }, [deletePending, deleteTarget, composerFocus, onDeleteMessage]);

  const openPinDialog = useCallback(async (message: Message) => {
    if (pinPending) return;
    setActionMenu(undefined);
    setPinPending(true);
    const permissions = await onLoadMessageProperties(message.chatId, message.id, true);
    setPinPending(false);
    if (permissions?.canPin) setPinTarget({ ...message, permissions });
  }, [onLoadMessageProperties, pinPending]);

  const confirmPin = useCallback(async (disableNotification: boolean, onlyForSelf: boolean) => {
    if (!pinTarget || pinPending) return;
    const restoreFocus = composerFocus.capture();
    setPinPending(true);
    const pinned = await onPinMessage(
      pinTarget.id,
      disableNotification,
      onlyForSelf,
      pinTarget.chatId,
    );
    setPinPending(false);
    if (pinned) setPinTarget(undefined);
    restoreFocus();
  }, [composerFocus, onPinMessage, pinPending, pinTarget]);

  const unpinMessage = useCallback(async (message: Message) => {
    if (pinPending) return;
    const restoreFocus = composerFocus.capture();
    setActionMenu(undefined);
    setPinPending(true);
    const permissions = await onLoadMessageProperties(message.chatId, message.id, true);
    if (permissions?.canPin) await onUnpinMessage(message.id, message.chatId);
    setPinPending(false);
    restoreFocus();
  }, [composerFocus, onLoadMessageProperties, onUnpinMessage, pinPending]);

  const openReply = useCallback((chatId: string, messageId: string) => {
    if (chatId !== discussionChatId || !messagesById.has(messageId)) {
      onOpenMessage(chatId, messageId);
      return;
    }
    document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    )?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(messageId);
    globalThis.setTimeout(() => setHighlightedMessageId((current) =>
      current === messageId ? undefined : current), 1800);
    focusComposer();
  }, [discussionChatId, focusComposer, messagesById, onOpenMessage]);

  const insertSenderMention = useCallback((senderId: string) => {
    const sender = users.get(senderId);
    if (!sender) return;
    insertionIdRef.current += 1;
    setTextInsertion({
      id: `${sender.id}:${insertionIdRef.current}`,
      text: mentionTextForUser(sender),
      draftKey,
      userId: sender.id,
    });
    focusComposer();
  }, [draftKey, focusComposer, users]);

  const openSenderMenu = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    message: Message,
    senderName: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSenderMenu({
      senderId: message.senderId,
      senderName,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const copySelectedMessages = useCallback(async () => {
    if (forwarding.selectedIds.size === 0 || selectionCopying) return;
    const ordered = comments.filter((message) => forwarding.selectedIds.has(message.id));
    if (ordered.length === 0) return;
    setSelectionCopying(true);
    try {
      await writeClipboardText(formatSelectedMessages(
        ordered,
        users,
        discussionChat,
        targetChatsById,
        messagesById,
      ));
      setSelectionCopied(true);
      forwarding.clearSelection();
      globalThis.setTimeout(() => setSelectionCopied(false), 1600);
    } finally {
      setSelectionCopying(false);
    }
  }, [comments, discussionChat, forwarding, messagesById, selectionCopying, targetChatsById, users]);

  useEffect(() => {
    if (!forwarding.selectionMode) return;
    const copyWithKeyboard = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "c" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (forwarding.selectedIds.size === 0) return;
      event.preventDefault();
      void copySelectedMessages();
    };
    document.addEventListener("keydown", copyWithKeyboard, true);
    return () => document.removeEventListener("keydown", copyWithKeyboard, true);
  }, [copySelectedMessages, forwarding.selectedIds.size, forwarding.selectionMode]);

  const preserveComposerFocus = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!forwarding.selectionMode) focusComposerFromPointer(event, composerFocus);
  }, [composerFocus, forwarding.selectionMode]);

  const searchDiscussionHashtag = useCallback(
    (hashtag: string) => onSearchHashtag(hashtag, discussionChatId),
    [discussionChatId, onSearchHashtag],
  );

  return (
    <section
      className={`channel-discussion-panel ${forwarding.selectionMode ? "is-selecting-messages" : ""}`}
      data-composer-scope={draftKey}
      onPointerDown={preserveComposerFocus}
      onPointerUp={preserveComposerFocus}
      aria-label={translate("{{value0}} 的讨论", { value0: channel.title })}
    >
      <header className="channel-discussion-header">
        <button className="icon-button" type="button" aria-label={translate("返回频道")} title={translate("返回频道")} onClick={onClose}>
          <ChevronLeft size={21} strokeWidth={2} />
        </button>
        <div className="channel-discussion-heading">
          <strong>{channel.title}</strong>
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="channel-discussion-messages"
        role="log"
        aria-label={translate("留言列表")}
      >
        <ConversationViewportBoundary identity={draftKey} items={comments} capture={captureScroll}>
        <div className="channel-discussion-stream">
          <div className="channel-discussion-post">
            <MessageBubblePreview
              message={post}
              senderName={channel.title}
              users={users}
              senderChats={targetChatsById}
              channelPost
              showChannelMetadata
              {...messagePreviewOptions}
              onOpenMention={onOpenMention}
              onSearchHashtag={(hashtag) => onSearchHashtag(hashtag, post.chatId)}
            />
          </div>

          {loadError && <div className="channel-discussion-page-status channel-discussion-error" role="alert">
            <span className="conversation-notice">{translate("留言加载失败")}</span>
            <button className="text-button" type="button" disabled={loading} onClick={onRetry}>
              <RotateCcw size={14} />{translate("重试")}
            </button>
          </div>}
          {hasMore && !loadError && comments.length > 0 && <button className="dialog-secondary channel-discussion-load-more"
            type="button" disabled={loading} onClick={onLoadMore}>
            {loading ? <LoaderCircle className="spin" size={14} /> : null}{translate("加载更早留言")}
          </button>}
          {loading && comments.length === 0 ? (
            <div className="channel-discussion-empty" role="status"><span className="conversation-notice conversation-notice-status"><LoaderCircle className="spin" size={18} />{translate("正在加载留言")}</span></div>
          ) : comments.length === 0 && !loadError ? (
            <div className="channel-discussion-empty"><span className="conversation-notice">{translate("还没有留言")}</span></div>
          ) : comments.map((comment, index) => {
            const blocked = !comment.outgoing ? blockedById.get(comment.senderId) : undefined;
            const concealed = Boolean(blocked && !revealedMessages.has(comment.id));
            const senderName = blocked?.alias ?? senderFor(comment, users, targetChatsById, currentUserId);
            const preview = replyPreviewFor(comment, messagesById, usersById, discussionChat, targetChatsById, currentUserId);
            const blockedReply = blockedById.get(replySenderId(comment, messagesById) ?? "");
            const profileAvailable = !blocked && !comment.outgoing &&
              comment.senderId !== "unknown" &&
              (comment.senderId.startsWith("chat:") || users.has(comment.senderId));
            const previous = comments[index - 1];
            const selected = forwarding.selectedIds.has(comment.id);
            const selectionPending = forwarding.loadingIds.has(comment.id);
            const forwardSource = forwardSourceFor(comment, usersById, targetChatsById);
            const forwardNavigation = forwardSource?.navigation;
            return (
              <div
                className={`message-group channel-discussion-message-group ${comment.outgoing ? "is-outgoing" : "is-incoming"}`}
                key={comment.renderKey ?? `${comment.chatId}:${comment.id}`}
              >
                {!comment.outgoing && comment.content.kind !== "service" && comment.content.kind !== "unsupported" && (
                  <span className="message-group-avatar">
                    <button
                      className="message-sender-avatar"
                      type="button"
                      aria-label={translate("查看 {{value0}} 的资料", { value0: senderName })}
                      title={translate("查看资料")}
                      disabled={!profileAvailable}
                      onClick={() => profileAvailable && onOpenSenderProfile(comment.senderId)}
                      onContextMenu={(event) => profileAvailable && openSenderMenu(event, comment, senderName)}
                    >
                      <Avatar avatar={blocked?.aliasAvatar ?? avatarFor(comment, users, targetChatsById, currentUserId)} size="small" />
                    </button>
                  </span>
                )}
                <div className="message-group-stack">
                  <MessageBubblePreview
                    message={comment}
                    senderName={senderName}
                    users={users}
                    senderChats={targetChatsById}
                    senderLabel={blocked ? undefined : comment.senderTag || memberLabels.get(comment.senderId)}
                    senderIsAdministrator={!blocked && memberLabels.has(comment.senderId)}
                    senderProfileAvailable={profileAvailable}
                    channelAuthor={channelAuthorFor(comment)}
                    showChannelMetadata={displaysChannelMetadata(comment)}
                    serviceMembers={servicePersonIds(comment.content).map((id) => ({
                      id, name: blockedById.get(id)?.alias ?? users.get(id)?.displayName ??
                        (id.startsWith("chat:") ? targetChatsById.get(id.slice(5))?.title : undefined) ?? translate("Telegram 用户"),
                      profileAvailable: !blockedById.has(id) && (users.has(id) || (id.startsWith("chat:") && targetChatsById.has(id.slice(5)))),
                    }))}
                    serviceTargetSummary={serviceTargetSummary(comment, messagesById, blockedById)}
                    replyPreview={preview && blockedReply ? { ...preview, author: blockedReply.alias, concealed: true } : preview}
                    forwardLabel={forwardSource?.label}
                    onOpenForwardSource={forwardNavigation ? () => {
                      if (forwardNavigation.kind === "message") {
                        onOpenMessage(forwardNavigation.chatId, forwardNavigation.messageId);
                      } else if (forwardNavigation.kind === "chat") {
                        onOpenChat(forwardNavigation.chatId);
                      } else {
                        onOpenSenderProfile(forwardNavigation.userId);
                      }
                    } : undefined}
                    selectionMode={forwarding.selectionMode}
                    selected={selected}
                    highlighted={highlightedMessageId === comment.id}
                    selectionPending={selectionPending}
                    joinsSelectionBefore={Boolean(previous && (
                      forwarding.selectedIds.has(previous.id) || forwarding.loadingIds.has(previous.id)
                    ))}
                    selectionLimitReached={forwarding.selectedIds.size >= 100}
                    {...messagePreviewOptions}
                    locallyConcealed={concealed}
                    onRevealLocallyBlocked={() => setRevealedMessages(current => new Set([...current, comment.id]))}
                    previousAudioPlaybackId={audioNeighbors.get(comment.id)?.previousId}
                    nextAudioPlaybackId={audioNeighbors.get(comment.id)?.nextId}
                    onToggleSelection={forwarding.toggleSelection}
                    onOpenActions={openMessageActions}
                    onOpenReply={openReply}
                    onOpenSenderProfile={onOpenSenderProfile}
                    onOpenMention={onOpenMention}
                    onSearchHashtag={searchDiscussionHashtag}
                  />
                </div>
              </div>
            );
          })}
        </div>
        </ConversationViewportBoundary>
      </div>

      {forwarding.selectionMode ? (
        <div className="message-selection-bar" role="toolbar" aria-label={translate("消息选择操作")}>
          <span>{forwarding.selectedIds.size > 0 ? translate("复制或转发所选消息") : translate("点击消息进行选择")}</span>
          <div className="message-selection-actions">
            <button
              className={`icon-button ${selectionCopied ? "is-confirmed" : ""}`}
              type="button"
              aria-label={translate("复制所选消息")}
              title={translate("复制")}
              disabled={forwarding.selectedIds.size === 0 || selectionCopying}
              onClick={() => void copySelectedMessages()}
            >
              {selectionCopied ? <Check size={19} /> : selectionCopying ? <LoaderCircle className="spin" size={18} /> : <Copy size={18} />}
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={translate("转发所选消息")}
              title={translate("转发")}
              disabled={forwarding.selectedIds.size === 0}
              onClick={forwarding.openSelectedDialog}
            >
              <Forward size={19} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={translate("取消选择")}
              title={translate("取消选择")}
              onClick={() => {
                forwarding.clearSelection();
                focusComposer();
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>
      ) : (
        <div className="channel-discussion-composer">
          <ConversationComposer
            key={draftKey}
            chatId={discussionChatId}
            draftKey={draftKey}
            editingMessage={editingMessage}
            replyingTo={replyingTo}
            replyQuote={replyQuote}
            contextTitle={channel.title}
            users={users}
            textInsertion={textInsertion}
            knownNonBotUsernames={knownNonBotUsernames}
            mentionsEnabled
            recentMentionUserIds={recentMentionUserIds}
            onTextInsertionApplied={(id) => setTextInsertion((current) => current?.id === id ? undefined : current)}
            inputRef={inputRef}
            onEditLatestVisible={editLatestVisible}
            focus={composerFocus}
            connectionStatus={connectionStatus}
            {...queueCounts}
            onSendMessage={async (...args) => {
              const sent = await onSend(...args);
              if (sent) {
                setReplyingTo(undefined);
                setReplyQuote(undefined);
              }
              return sent;
            }}
            onEditMessage={async (messageId, text, entities) => {
              const edited = await onEditMessage(messageId, text, entities, discussionChatId);
              if (edited) setEditingMessage(undefined);
              return edited;
            }}
            onDraftChange={(_chatId, text, replyToMessageId, selectedQuote, entities) => {
              updateThreadDraft(
                draftKey,
                discussionChatId,
                text,
                replyToMessageId,
                selectedQuote,
                entities,
              );
            }}
            onTypingChange={onTypingChange}
            onSendFiles={async (...args) => {
              const sent = await onSendFiles(...args);
              if (sent) {
                setReplyingTo(undefined);
                setReplyQuote(undefined);
              }
              return sent;
            }}
            onCancelEditing={() => {
              setEditingMessage(undefined);
            }}
            onCancelReply={() => {
              setReplyingTo(undefined);
              setReplyQuote(undefined);
            }}
            onGetBotCommands={(query = "", botUsername) =>
              getBotCommandSuggestions(discussionChatId, query, botUsername)}
            onGetInlineResults={(botUsername, query, offset = "") =>
              getInlineQueryResults(discussionChatId, botUsername, query, offset)}
            onSendInlineResult={(botUserId, queryId, resultId, replyToMessageId) =>
              sendInlineQueryResultMessage(
                discussionChatId,
                botUserId,
                queryId,
                resultId,
                replyToMessageId,
              )}
            onSendBotStart={(botUserId, parameter) =>
              sendBotStartMessage(discussionChatId, botUserId, parameter)}
          />
        </div>
      )}

      {actionMenu && actionMessage && (
        <MessageActionMenu
          key={`${activeAccountId}:${draftKey}:${actionMessage.chatId}:${actionMessage.id}`}
          position={actionMenu}
          message={actionMessage}
          onLoadPermissions={onLoadMessageProperties}
          keyboardNavigation={actionMenu.keyboardNavigation}
          onReply={() => startReply(actionMessage, actionMenu.replyQuote)}
          onEdit={() => startEditing(actionMessage)}
          onForward={() => {
            forwarding.openDialogForMessages(actionAlbumMessageIds.length > 1 ? actionAlbumMessageIds : [actionMessage.id]);
            setActionMenu(undefined);
          }}
          forwardTargets={forwardTargets}
          onQuickForward={(target) => {
            setActionMenu(undefined);
            void forwarding.quickForward(actionAlbumMessageIds.length > 1 ? actionAlbumMessageIds : [actionMessage.id], target);
          }}
          onRepeat={!actionMessage.outgoing ? () => {
            const restoreFocus = composerFocus.capture();
            setActionMenu(undefined);
            void onForwardMessages(
              discussionChatId,
              [actionMessage.id],
              discussionChatId,
            ).finally(restoreFocus);
          } : undefined}
          onDelete={() => {
            setDeleteTarget(actionMessage);
            setActionMenu(undefined);
          }}
          onCopy={() => {
            void copyMessageContent(actionMessage).then(closeActionMenu).catch(() => undefined);
          }}
          onPin={actionMessage.permissions?.canPin ? () => void openPinDialog(actionMessage) : undefined}
          onUnpin={actionMessage.permissions?.canPin ? () => void unpinMessage(actionMessage) : undefined}
          onPlayInWindow={actionMessage.content.kind === "media" &&
            ["video", "videoNote"].includes(actionMessage.content.mediaType)
            ? () => {
                setActionMenu(undefined);
                if (messagePreviewOptions?.onOpenMedia) messagePreviewOptions.onOpenMedia(actionMessage.id, actionMessage.chatId, true);
                else requestVideoWindowPlayback(`${actionMessage.chatId}:${actionMessage.id}`);
              }
            : undefined}
          onDownload={(actionMessage.content.kind === "media" || actionMessage.content.kind === "file") &&
            actionMessage.content.fileId !== undefined &&
            actionMessage.content.canDownload !== false &&
            actionMessage.content.isDownloading !== true &&
            messagePreviewOptions?.onDownload
            ? () => {
                const content = actionMessage.content;
                if ((content.kind !== "media" && content.kind !== "file") || content.fileId === undefined) return;
                setActionMenu(undefined);
                void messagePreviewOptions.onDownload?.(content.fileId, content.fileName);
              }
            : undefined}
          onReport={!actionMessage.outgoing ? () => {
            setReportTarget(actionMessage);
            setActionMenu(undefined);
          } : undefined}
          onDismiss={closeActionMenu}
          onClose={closeActionMenu}
        />
      )}

      {senderMenu && (
        <SenderActionMenu
          position={senderMenu}
          senderName={senderMenu.senderName}
          onMention={!senderMenu.senderId.startsWith("chat:") && senderMenu.senderId !== "unknown"
            ? () => insertSenderMention(senderMenu.senderId)
            : undefined}
          onPrivateChat={!senderMenu.senderId.startsWith("chat:") && senderMenu.senderId !== "unknown"
            ? () => onStartPrivateChat(senderMenu.senderId)
            : undefined}
          onSearch={() => onOpenMessageSearch(senderMenu.senderId, discussionChatId)}
          onDismiss={() => {
            setSenderMenu(undefined);
            focusComposer();
          }}
        />
      )}

      <MotionPresence present={Boolean(reportTarget)}>
        {reportTarget ? (
          <ReportDialog
            chatId={reportTarget.chatId}
            messageIds={[reportTarget.id]}
            title={discussionChat.title}
            onGetOptions={onGetReportOptions}
            onSubmit={onReportChat}
            onClose={() => {
              setReportTarget(undefined);
            }}
          />
        ) : null}
      </MotionPresence>

      <MotionPresence present={Boolean(deleteTarget)}>
        {deleteTarget?.permissions ? (
          <DeleteMessagesDialog
            count={1}
            preview={messageSummary(deleteTarget.content)}
            canDeleteOnlyForSelf={deleteTarget.permissions.canDeleteOnlyForSelf}
            canDeleteForAllUsers={deleteTarget.permissions.canDeleteForAllUsers}
            pending={deletePending}
            onConfirm={(revoke) => void confirmDelete(revoke)}
            onClose={() => {
              setDeleteTarget(undefined);
            }}
          />
        ) : null}
      </MotionPresence>

      <MotionPresence present={Boolean(pinTarget)}>
        {pinTarget ? (
          <PinMessageDialog
            message={pinTarget}
            pending={pinPending}
            allowOnlyForSelf={false}
            allowNotification
            onConfirm={(disableNotification, onlyForSelf) => void confirmPin(disableNotification, onlyForSelf)}
            onClose={() => {
              setPinTarget(undefined);
            }}
          />
        ) : null}
      </MotionPresence>

      <MotionPresence present={forwarding.dialogOpen && forwarding.forwardMessageIds.length > 0}>
        {forwarding.dialogOpen && forwarding.forwardMessageIds.length > 0 ? (
          <ForwardMessagesDialog
            selectedCount={forwarding.forwardMessageIds.length}
            targets={forwarding.filteredTargets}
            topicsByChat={forumTopics}
            currentChatId={discussionChatId}
            initialTargetId={forwarding.initialTargetId}
            query={forwarding.query}
            pending={forwarding.pending}
            pendingTargetId={forwarding.pendingTargetId}
            onQueryChange={forwarding.setQuery}
            onLoadTopics={onLoadForumTopics}
            onConfirm={(targets, description) => void forwarding.confirm(targets, description)}
            onClose={() => {
              forwarding.closeDialog();
            }}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}
