import {
  ArrowDown,
  ArrowUpRight,
  AtSign,
  ChevronLeft,
  Forward,
  MoreVertical,
  LoaderCircle,
  Pin,
  X,
} from "lucide-react";
import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso, type Components, type ListProps } from "react-virtuoso";
import type {
  Chat,
  ChatMessageSearchInput,
  ConnectionStatus,
  ForumTopic,
  Message,
  MessagePermissions,
  ForwardMessagesResult,
  User,
} from "../telegram/types";
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
  AutoDeleteDialog,
  PinMessageDialog,
  SenderActionMenu,
} from "./ConversationOverlays";
import {
  forwardLabelFor,
  messageSummary,
  replyPreviewFor,
  senderChatId,
  senderNameForMessage,
} from "./conversationMessages";
import { MessageBubble as RichMessageBubble } from "./MessageBubble";
import { usePreferencesStore } from "../store/preferencesStore";
import { autoplayAllowed } from "../utils/motionPreference";
import { colorThemeForThemeId } from "../theme/theme";
import { ConversationComposer } from "./ConversationComposer";
import { ReportDialog } from "./SafetySettings";
import { MessageRichText } from "./MessageRichText";
import { photoMessages } from "../utils/mediaViewerModel";
import {
  openMediaViewerWindow,
  syncMediaViewerWindow,
} from "../media/mediaViewerWindowBridge";
import {
  indexMessagesByVirtualBlock,
  virtualizeMessageGroups,
  type VirtualMessageBlock,
} from "../utils/messageVirtualization";
import { requestVideoWindowPlayback } from "../media/videoWindowBridge";
import { ChatActionMenu } from "./ChatActionMenu";
import { MotionPresence } from "./MotionPresence";
import { ForumTopicStrip } from "./ForumTopicStrip";
import { copyMessageContent, writeClipboardText } from "../utils/clipboard";
import { telegramStore, useTelegramStore } from "../store/telegramStore";
import {
  isConversationSwitchActive,
  logPerformance,
  markConversationSwitch,
} from "../utils/performanceMonitor";
import { messageEntranceFor } from "../utils/messageEntrance";
import {
  pinnedMessageForVisibleRange,
  usePinnedMessages,
} from "../hooks/usePinnedMessages";
import { PinnedMessageBanner } from "./PinnedMessageBanner";

const EMPTY_ATTENTION_MESSAGE_IDS: string[] = [];
type MessageNavigationOptions = Pick<
  MessageConversationScrollRequest,
  "behavior" | "highlight"
> & { loadContext?: boolean };

const MessageSourceLocateButton = ({
  message,
  onLocate,
}: {
  message: Message;
  onLocate: (chatId: string, messageId: string) => void;
}) => (
  <button
    className="message-source-locate"
    type="button"
    aria-label={`跳转到消息原位置：${messageSummary(message.content)}`}
    title="跳转到消息原位置"
    onClick={(event) => {
      event.stopPropagation();
      onLocate(message.chatId, message.id);
    }}
  >
    <ArrowUpRight size={15} strokeWidth={2.1} />
  </button>
);

const VirtualMessageListContent = forwardRef<HTMLDivElement, ListProps>((props, ref) => (
  <div {...props} className="message-list-content" ref={ref} />
));
VirtualMessageListContent.displayName = "VirtualMessageListContent";

const EmptyMessageList = () => <div className="messages-empty">没有匹配的消息</div>;
const EmptyPinnedMessageList = () => <div className="messages-empty">当前没有置顶消息</div>;

const messageListComponents: Components<VirtualMessageBlock> = {
  EmptyPlaceholder: EmptyMessageList,
  List: VirtualMessageListContent,
};

const pinnedMessageListComponents: Components<VirtualMessageBlock> = {
  EmptyPlaceholder: EmptyPinnedMessageList,
  List: VirtualMessageListContent,
};

interface ConversationProps {
  chat?: Chat;
  topic?: ForumTopic;
  topics: ForumTopic[];
  onSelectTopic: (topicId: string) => void;
  scrollScope: string;
  entryScrollRequest?: EntryConversationScrollRequest;
  latestScrollRequest?: LatestConversationScrollRequest;
  messageScrollRequest?: MessageConversationScrollRequest;
  messages: Message[];
  chatMessages: Message[];
  forwardTargets: Chat[];
  forumTopics: Map<string, ForumTopic[]>;
  users: Map<string, User>;
  historyLoading: boolean;
  historyInitialized: boolean;
  hasOlderMessages: boolean;
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  queuedAttachmentCount: number;
  failedAttachmentCount: number;
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
    toTopicId?: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  onLoadForumTopics: (chatId: string) => Promise<import("../telegram/types").ForumTopicPage | undefined>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onLoadRawMessage: (chatId: string, messageId: string) => Promise<string | undefined>;
  onSetMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  onSetPollAnswer: (messageId: string, optionPositions: number[]) => Promise<boolean>;
  onBotCallback: (messageId: string, data: string) => Promise<import("../telegram/types").CallbackQueryAnswer | undefined>;
  onLoadPinnedMessages: (chatId: string) => Promise<Message[]>;
  onPinMessage: (messageId: string, disableNotification: boolean, onlyForSelf: boolean) => Promise<boolean>;
  onUnpinMessage: (messageId: string) => Promise<boolean>;
  onSetChatMessageAutoDeleteTime: (chatId: string, seconds: number) => Promise<boolean>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onCancelFileDownload: (fileId: number) => Promise<void>;
  onOpenFile: (sourcePath: string) => Promise<void>;
  onSaveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  onOpenDownloadDirectory: () => Promise<void>;
  onStreamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendFileStream: (fileId: number) => Promise<void>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onSendFiles: (attachments: import("../telegram/types").OutgoingAttachment[], caption?: string) => Promise<boolean>;
  onCancelFileUpload: (messageId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onOpenProfile: () => void;
  onPositioned?: (chatId: string) => void;
  onOpenMessage: (
    chatId: string,
    messageId: string,
    options?: MessageNavigationOptions,
  ) => void;
  onOpenMessageSearch: (senderId?: string) => void;
  onOpenSenderProfile: (senderId: string) => void;
  onSetChatPinned: (pinned: boolean) => Promise<boolean>;
  onSetChatMuted: (muted: boolean) => Promise<boolean>;
  onSetChatArchived: (archived: boolean) => Promise<boolean>;
  onBack: () => void;
  onGetBotCommands: (query?: string, botUsername?: string) => Promise<import("../telegram/types").BotCommandSuggestion[]>;
  onGetInlineResults: (botUsername: string, query: string, offset?: string) => Promise<import("../telegram/types").InlineQueryResultPage | undefined>;
  onSendInlineResult: (botUserId: string, queryId: string, resultId: string, replyToMessageId?: string) => Promise<boolean>;
  onSendBotStart: (botUserId: string, parameter?: string) => Promise<boolean>;
  onGetReportOptions: (chatId: string, messageIds: string[]) => Promise<import("../telegram/types").ChatReportOptions | undefined>;
  onReportChat: (input: import("../telegram/types").ReportChatInput) => Promise<boolean>;
  onBlockSender: (senderId: string, kind: "user" | "chat", blocked: boolean) => Promise<boolean>;
}

export function Conversation({
  chat,
  topic,
  topics,
  onSelectTopic,
  scrollScope,
  entryScrollRequest,
  latestScrollRequest,
  messageScrollRequest,
  messages,
  chatMessages,
  forwardTargets,
  forumTopics,
  users,
  historyLoading,
  historyInitialized,
  hasOlderMessages,
  connectionStatus,
  queuedMessageCount,
  failedQueuedMessageCount,
  queuedAttachmentCount,
  failedAttachmentCount,
  typingUserIds,
  chatListId,
  chatManagementPending,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onDraftChange,
  onTypingChange,
  onForwardMessages,
  onLoadForumTopics,
  onLoadMessageProperties,
  onLoadRawMessage,
  onSetMessageReaction,
  onSetPollAnswer,
  onBotCallback,
  onLoadPinnedMessages,
  onPinMessage,
  onUnpinMessage,
  onSetChatMessageAutoDeleteTime,
  onDownloadFile,
  onCancelFileDownload,
  onOpenFile,
  onSaveFileAs,
  onOpenDownloadDirectory,
  onStreamFile,
  onSuspendFileStream,
  onRetryMessage,
  onSendFiles,
  onCancelFileUpload,
  onLoadOlder,
  onOpenProfile,
  onPositioned,
  onOpenMessage,
  onOpenMessageSearch,
  onOpenSenderProfile,
  onSetChatPinned,
  onSetChatMuted,
  onSetChatArchived,
  onBack,
  onGetBotCommands,
  onGetInlineResults,
  onSendInlineResult,
  onSendBotStart,
  onGetReportOptions,
  onReportChat,
  onBlockSender,
}: ConversationProps) {
  const conversationIdentity = chat
    ? topic ? `${chat.id}:topic:${topic.id}` : chat.id
    : undefined;
  const currentUserId = useTelegramStore((state) => state.currentUserId);
  const attentionMessageIds = useTelegramStore((state) => chat
    ? state.unreadAttentionMessageIds.get(chat.id) ?? EMPTY_ATTENTION_MESSAGE_IDS
    : EMPTY_ATTENTION_MESSAGE_IDS);
  const dismissMessageAttention = useTelegramStore(
    (state) => state.dismissMessageAttention,
  );
  const [actionMenu, setActionMenu] = useState<{
    messageId: string;
    left: number;
    top: number;
    returnFocus?: HTMLElement;
  }>();
  const [senderMenu, setSenderMenu] = useState<{
    senderId: string;
    senderName: string;
    x: number;
    y: number;
  }>();
  const [actionLoadingId, setActionLoadingId] = useState<string>();
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [deleteTarget, setDeleteTarget] = useState<Message>();
  const [deletePending, setDeletePending] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<Message>();
  const [pinTarget, setPinTarget] = useState<Message>();
  const [pinPending, setPinPending] = useState(false);
  const [pinnedUnpinId, setPinnedUnpinId] = useState<string>();
  const pinnedReturnAnchorRef = useRef<{
    chatId: string;
    messageId: string;
    offset: number;
  } | undefined>(undefined);
  const [pinnedReturnRestoreId, setPinnedReturnRestoreId] = useState(0);
  const [autoDeleteDialogOpen, setAutoDeleteDialogOpen] = useState(false);
  const [autoDeletePending, setAutoDeletePending] = useState(false);
  const groupManagement = useTelegramStore((state) => state.groupManagement);
  const loadChatManagement = useTelegramStore((state) => state.loadChatManagement);
  const draftReplyToMessageId = useTelegramStore((state) =>
    chat ? state.drafts.get(topic ? `${chat.id}:topic:${topic.id}` : chat.id)?.replyToMessageId : undefined,
  );
  const cacheFile = useTelegramStore((state) => state.cacheFile);
  const autoplayAnimations = usePreferencesStore((state) => autoplayAllowed(
    state.autoplayAnimations,
    state,
  ));
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const colorTheme = usePreferencesStore((state) => colorThemeForThemeId(state.themeId));
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
  const {
    messages: allPinnedMessages,
    loading: pinnedMessagesLoading,
    viewOpen: pinnedViewOpen,
    openView: openPinnedView,
    closeView: closePinnedView,
    removeLoadedMessage,
  } = usePinnedMessages({
    chat,
    chatMessages,
    onLoadPinnedMessages,
  });
  const [visiblePinnedMessageIds, setVisiblePinnedMessageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pinnedMessageIdsKey = useMemo(
    () => allPinnedMessages.map((message) => message.id).join("\n"),
    [allPinnedMessages],
  );
  useEffect(() => {
    if (pinnedReturnAnchorRef.current?.chatId !== chat?.id) {
      pinnedReturnAnchorRef.current = undefined;
    }
  }, [chat?.id]);

  useEffect(() => {
    if (!chat || (chat.kind !== "group" && chat.kind !== "channel")) return;
    void loadChatManagement(chat.id);
  }, [chat?.id, chat?.kind, loadChatManagement]);
  const memberLabels = useMemo(() => new Map(
    groupManagement?.chatId === chat?.id
      ? [
          ...Object.entries(groupManagement?.administratorLabels ?? {}),
          ...(groupManagement?.members ?? []).flatMap((member) => {
            const label = member.customTitle ||
              (member.status === "owner" ? "群主" : member.status === "administrator" ? "管理员" : undefined);
            return label ? [[member.user.id, label] as const] : [];
          }),
        ]
      : [],
  ), [chat?.id, groupManagement]);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const selectionMessageRef = useRef<HTMLElement | null>(null);
  const selectionForwardButtonRef = useRef<HTMLButtonElement>(null);
  const chatMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [messageListScrolling, setMessageListScrolling] = useState(false);
  const [historyScrollbarSettling, setHistoryScrollbarSettling] = useState(false);
  const performanceTraceId = chat && messageScrollRequest?.chatId === chat.id
    ? messageScrollRequest.performanceTraceId
    : chat && latestScrollRequest?.chatId === chat.id
      ? latestScrollRequest.performanceTraceId
      : chat && entryScrollRequest?.chatId === chat.id
        ? entryScrollRequest.performanceTraceId
        : undefined;

  const displayMessages = useMemo(
    () => chat?.kind === "saved"
      ? messages.map((message) => message.outgoing ? message : { ...message, outgoing: true })
      : messages,
    [chat?.kind, messages],
  );
  const renderedMessages = useMemo(
    () => {
      const source = pinnedViewOpen
        ? allPinnedMessages.map((message) => message.mediaAlbumId
          ? { ...message, mediaAlbumId: undefined }
          : message)
        : displayMessages;
      return source;
    },
    [allPinnedMessages, displayMessages, pinnedViewOpen],
  );

  const focusComposer = useCallback(() => {
    globalThis.setTimeout(() => composerInputRef.current?.focus(), 0);
  }, []);

  const messageProjection = useMemo(() => {
    const startedAt = performance.now();
    const blocks = virtualizeMessageGroups(renderedMessages);
    return { blocks, durationMs: performance.now() - startedAt };
  }, [renderedMessages]);
  const visibleMessageBlocks = messageProjection.blocks;
  const messageItemIndexes = useMemo(
    () => indexMessagesByVirtualBlock(visibleMessageBlocks),
    [visibleMessageBlocks],
  );
  const viewerPhotos = useMemo(
    () => photoMessages(pinnedViewOpen ? allPinnedMessages : displayMessages),
    [allPinnedMessages, displayMessages, pinnedViewOpen],
  );
  const openMediaViewer = useCallback((messageId: string) => {
    const activeIndex = viewerPhotos.findIndex((message) => message.id === messageId);
    if (activeIndex < 0) return;
    const nearbyPhotos = viewerPhotos.slice(
      Math.max(0, activeIndex - 24),
      Math.min(viewerPhotos.length, activeIndex + 25),
    );
    const thumbnailFileIds = new Set(nearbyPhotos.flatMap((message) => {
      const content = message.content;
      return content.thumbnailFileId !== undefined &&
        content.thumbnailCanDownload === true &&
        !content.thumbnailPath &&
        !content.thumbnailIsDownloading
        ? [content.thumbnailFileId]
        : [];
    }));
    for (const fileId of thumbnailFileIds) {
      void cacheFile(fileId, 32).catch(() => undefined);
    }
    void openMediaViewerWindow({
      messages: viewerPhotos,
      activeMessageId: messageId,
      colorTheme,
    }, onDownloadFile);
  }, [cacheFile, colorTheme, onDownloadFile, viewerPhotos]);

  useEffect(() => {
    syncMediaViewerWindow(viewerPhotos, colorTheme);
  }, [colorTheme, viewerPhotos]);

  useLayoutEffect(() => {
    const tracing = isConversationSwitchActive(performanceTraceId);
    markConversationSwitch(performanceTraceId, "messageProjected", {
      durationMs: messageProjection.durationMs,
      messageCount: renderedMessages.length,
      blockCount: visibleMessageBlocks.length,
    });
    if (tracing || messageProjection.durationMs >= 4) {
      logPerformance("ui_message_projection", {
        durationMs: messageProjection.durationMs,
        traceId: tracing ? performanceTraceId : undefined,
        messageCount: renderedMessages.length,
        blockCount: visibleMessageBlocks.length,
      });
    }
  }, [
    messageProjection,
    performanceTraceId,
    visibleMessageBlocks.length,
    renderedMessages.length,
  ]);

  useEffect(() => {
    setChatMenuOpen(false);
    setSenderMenu(undefined);
  }, [chat?.id]);

  useLayoutEffect(() => {
    if (historyLoading) {
      setHistoryScrollbarSettling(true);
      return;
    }
    if (!historyScrollbarSettling) return;
    const timer = globalThis.setTimeout(() => setHistoryScrollbarSettling(false), 140);
    return () => globalThis.clearTimeout(timer);
  }, [historyLoading, historyScrollbarSettling]);

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

  const messagesById = useMemo(() => new Map(
    [...displayMessages, ...allPinnedMessages, ...renderedMessages].map((message) => [message.id, message]),
  ), [allPinnedMessages, displayMessages, renderedMessages]);
  const nextAudioPlaybackIdByMessage = useMemo(() => {
    const audioMessages = renderedMessages.filter((message) =>
      message.content.kind === "media" && ["audio", "voice"].includes(message.content.mediaType)
    );
    return new Map(audioMessages.slice(0, -1).map((message, index) => [
      message.id,
      `${message.chatId}:${audioMessages[index + 1].id}`,
    ]));
  }, [renderedMessages]);

  const forwardTargetsById = useMemo(
    () => new Map(forwardTargets.map((target) => [target.id, target])),
    [forwardTargets],
  );
  const forwarding = useMessageForwarding({
    chatId: chat?.id,
    conversationIdentity,
    messages: renderedMessages,
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
  const pinnedBannerVisible = !pinnedViewOpen && !selectionMode &&
    (chat?.kind === "group" || chat?.kind === "channel") &&
    allPinnedMessages.length > 0;
  const {
    messageListRef,
    messageListElement,
    setMessageListRef,
    virtuosoRef,
    currentScrollKey,
    positioning,
    virtuosoKey,
    initialTopMostItemIndex,
    initialAlignToBottom,
    restoreStateFrom,
    highlightedMessageId,
    newMessageNotice,
    awayFromLatest,
    jumpToLatest,
    pinFollowingMessageMount,
    appendMountMessageId,
    revealAttentionMessage,
    revealMessageStart,
    followOutput,
    onTotalListHeightChanged,
    onInitialRangeChanged,
    onInitialAtBottomStateChange,
    messageListHandlers,
  } = useConversationScroll({
    scope: pinnedViewOpen ? `${scrollScope}:pinned` : scrollScope,
    chatId: chat?.id,
    entryRequest: pinnedViewOpen ? undefined : entryScrollRequest,
    latestRequest: pinnedViewOpen ? undefined : latestScrollRequest,
    messageRequest: pinnedViewOpen ? undefined : messageScrollRequest,
    visibleMessages: renderedMessages,
    messageItemIndexes,
    virtualItemCount: visibleMessageBlocks.length,
    search: pinnedViewOpen ? "" : "",
    historyLoading: pinnedViewOpen ? false : historyLoading,
    historyInitialized: pinnedViewOpen ? true : historyInitialized,
    hasOlderMessages: pinnedViewOpen ? false : hasOlderMessages,
    messageCount: pinnedViewOpen ? renderedMessages.length : messages.length,
    onLoadOlder: pinnedViewOpen ? async () => undefined : onLoadOlder,
  });
  useEffect(() => {
    if (pinnedViewOpen || !messageListElement || !pinnedMessageIdsKey) {
      setVisiblePinnedMessageIds((current) => current.size === 0 ? current : new Set());
      return;
    }

    const pinnedMessageOrder = pinnedMessageIdsKey.split("\n");
    const pinnedMessageIds = new Set(pinnedMessageOrder);
    const bannerMessageIdFor = (visibleMessageIds: ReadonlySet<string>) => {
      const firstVisibleIndex = pinnedMessageOrder.findIndex(
        (messageId) => visibleMessageIds.has(messageId),
      );
      return pinnedMessageOrder[
        firstVisibleIndex < 0
          ? pinnedMessageOrder.length - 1
          : Math.max(0, firstVisibleIndex - 1)
      ];
    };
    let frame: number | undefined;
    const publishVisiblePinnedMessages = () => {
      frame = undefined;
      const rootBounds = messageListElement.getBoundingClientRect();
      const next = new Set<string>();
      for (const row of messageListElement.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const messageId = row.dataset.messageId;
        if (!messageId || !pinnedMessageIds.has(messageId)) continue;
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom > rootBounds.top + 1 && bounds.top < rootBounds.bottom - 1) {
          next.add(messageId);
        }
      }
      setVisiblePinnedMessageIds((current) => {
        if (bannerMessageIdFor(current) === bannerMessageIdFor(next)) return current;
        return next;
      });
    };
    const scheduleVisiblePinnedMessages = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(publishVisiblePinnedMessages);
    };

    scheduleVisiblePinnedMessages();
    messageListElement.addEventListener("scroll", scheduleVisiblePinnedMessages, { passive: true });
    globalThis.addEventListener("resize", scheduleVisiblePinnedMessages);
    const mutationObserver = new MutationObserver(scheduleVisiblePinnedMessages);
    mutationObserver.observe(messageListElement, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(scheduleVisiblePinnedMessages);
    resizeObserver.observe(messageListElement);
    const content = messageListElement.querySelector(".message-list-content");
    if (content) resizeObserver.observe(content);

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      messageListElement.removeEventListener("scroll", scheduleVisiblePinnedMessages);
      globalThis.removeEventListener("resize", scheduleVisiblePinnedMessages);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [messageListElement, pinnedMessageIdsKey, pinnedViewOpen]);

  const pinnedBannerMessage = useMemo(
    () => pinnedMessageForVisibleRange(allPinnedMessages, visiblePinnedMessageIds),
    [allPinnedMessages, visiblePinnedMessageIds],
  );

  const openPinnedBannerMessage = useCallback((chatId: string, messageId: string) => {
    const element = messageListRef.current;
    const target = element?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (element && target) {
      const listBounds = element.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      if (targetBounds.bottom > listBounds.top + 1 && targetBounds.top < listBounds.bottom - 1) {
        return;
      }
    }
    onOpenMessage(chatId, messageId, { behavior: "smooth", highlight: false });
  }, [onOpenMessage]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (
      pinnedViewOpen || !chat || !messageListElement ||
      !conversation || attentionMessageIds.length === 0
    ) return;
    const attentionIds = new Set(attentionMessageIds);
    const visibleIds = new Set<string>();
    const observedRows = new Set<Element>();
    const consumeVisibleAttention = () => {
      if (
        !document.hasFocus() ||
        document.visibilityState !== "visible" ||
        !conversation.contains(document.activeElement)
      ) return;
      for (const messageId of visibleIds) {
        if (attentionIds.has(messageId)) dismissMessageAttention(chat.id, messageId);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const messageId = (entry.target as HTMLElement).dataset.messageId;
        if (!messageId) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) visibleIds.add(messageId);
        else visibleIds.delete(messageId);
      }
      consumeVisibleAttention();
    }, { root: messageListElement, threshold: 0.01 });
    const observeMountedAttentionRows = () => {
      for (const messageId of attentionIds) {
        const row = messageListElement.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        if (!row || observedRows.has(row)) continue;
        observedRows.add(row);
        observer.observe(row);
      }
    };
    observeMountedAttentionRows();
    const mutationObserver = new MutationObserver(observeMountedAttentionRows);
    mutationObserver.observe(messageListElement, { childList: true, subtree: true });
    document.addEventListener("focusin", consumeVisibleAttention);
    globalThis.addEventListener("focus", consumeVisibleAttention);
    document.addEventListener("visibilitychange", consumeVisibleAttention);
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      document.removeEventListener("focusin", consumeVisibleAttention);
      globalThis.removeEventListener("focus", consumeVisibleAttention);
      document.removeEventListener("visibilitychange", consumeVisibleAttention);
    };
  }, [
    attentionMessageIds,
    chat,
    dismissMessageAttention,
    messageListElement,
    pinnedViewOpen,
  ]);
  const actionMessage = actionMenu
    ? messagesById.get(actionMenu.messageId)
    : undefined;
  const preservePositioningFrame = Boolean(
    !pinnedViewOpen &&
    renderedMessages.length > 0 &&
    messageListRef.current?.dataset.conversationVirtuosoKey === virtuosoKey &&
    Boolean(messageListRef.current?.querySelector("[data-message-id]")) &&
    (
      entryScrollRequest?.chatId === chat?.id ||
      latestScrollRequest?.chatId === chat?.id ||
      messageScrollRequest?.chatId === chat?.id
    )
  );

  const sendMessageAndFollowLatest = useCallback(async (
    text: string,
    replyToMessageId?: string,
  ) => {
    jumpToLatest("auto");
    return onSendMessage(text, replyToMessageId);
  }, [jumpToLatest, onSendMessage]);

  const sendFilesAndFollowLatest = useCallback(async (
    attachments: import("../telegram/types").OutgoingAttachment[],
    caption?: string,
  ) => {
    jumpToLatest("auto");
    return onSendFiles(attachments, caption);
  }, [jumpToLatest, onSendFiles]);

  useEffect(() => {
    if (!chat || pinnedViewOpen) return;
    let focusTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const isEditable = (target: Element | null) => target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && !["checkbox", "radio", "range", "file"].includes(target.type)) ||
      target?.getAttribute("contenteditable") === "true";
    const isProtectedSurface = (target: Element | null) => Boolean(
      target?.closest("[role='dialog'], [role='menu'], .context-menu-panel, .chat-action-menu"),
    );
    const focusComposerWhenFree = (onlyWhenUnfocused = false) => {
      if (window.matchMedia("(forced-colors: active)").matches) return;
      if (focusTimer !== undefined) globalThis.clearTimeout(focusTimer);
      focusTimer = globalThis.setTimeout(() => {
        focusTimer = undefined;
        const active = document.activeElement;
        if (!document.hasFocus() || isEditable(active) || isProtectedSurface(active)) return;
        if (onlyWhenUnfocused && active !== document.body && active !== document.documentElement) return;
        composerInputRef.current?.focus({ preventScroll: true });
      }, 80);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (isEditable(target) || isProtectedSurface(target)) return;
      focusComposerWhenFree();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (next && next !== document.body && next !== document.documentElement) return;
      focusComposerWhenFree(true);
    };
    const onWindowFocus = () => focusComposerWhenFree(true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("focus", onWindowFocus);
      if (focusTimer !== undefined) globalThis.clearTimeout(focusTimer);
    };
  }, [chat?.id, pinnedViewOpen]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest<HTMLElement>(".message-row");
      selectionMessageRef.current = row?.querySelector(".message-rich-text") ? row : null;
    };
    const onSelectionChange = () => {
      const selection = globalThis.getSelection();
      const boundary = selectionMessageRef.current;
      if (!selection || selection.isCollapsed || !boundary) return;
      const anchorRow = selection.anchorNode instanceof Element
        ? selection.anchorNode.closest<HTMLElement>(".message-row")
        : selection.anchorNode?.parentElement?.closest<HTMLElement>(".message-row");
      const focusRow = selection.focusNode instanceof Element
        ? selection.focusNode.closest<HTMLElement>(".message-row")
        : selection.focusNode?.parentElement?.closest<HTMLElement>(".message-row");
      if (anchorRow !== boundary || focusRow !== boundary) selection.removeAllRanges();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      selectionMessageRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (
      !chat ||
      pinnedViewOpen ||
      positioning ||
      historyLoading ||
      selectionMode
    ) return;
    const active = document.activeElement;
    const activeChatRow = active instanceof Element && Boolean(active.closest(".chat-row"));
    if (active && active !== document.body && active !== document.documentElement &&
      active !== composerInputRef.current &&
      (!activeChatRow || window.matchMedia("(forced-colors: active)").matches)) return;
    composerInputRef.current?.focus({ preventScroll: true });
  }, [conversationIdentity, historyLoading, pinnedViewOpen, positioning, selectionMode]);

  useLayoutEffect(() => {
    if (
      pinnedViewOpen || !chat || positioning ||
      (historyLoading && renderedMessages.length === 0)
    ) return;
    onPositioned?.(chat.id);
  }, [
    chat?.id,
    historyLoading,
    onPositioned,
    pinnedViewOpen,
    positioning,
    renderedMessages.length,
  ]);

  useLayoutEffect(() => {
    const anchor = pinnedReturnAnchorRef.current;
    if (
      pinnedViewOpen || pinnedReturnRestoreId === 0 || !chat ||
      !anchor || anchor.chatId !== chat.id
    ) return;
    const itemIndex = messageItemIndexes.get(anchor.messageId);
    if (itemIndex === undefined) {
      pinnedReturnAnchorRef.current = undefined;
      return;
    }

    let frame: number | undefined;
    let remainingFrames = 32;
    let stableFrames = 0;
    const settleAnchor = () => {
      frame = undefined;
      const element = messageListRef.current;
      if (!element || element.dataset.conversationVirtuosoKey !== virtuosoKey) {
        remainingFrames -= 1;
      } else {
        const target = element.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
        );
        if (!target) {
          virtuosoRef.current?.scrollToIndex({
            index: itemIndex,
            align: "start",
            offset: -anchor.offset,
            behavior: "auto",
          });
          stableFrames = 0;
        } else {
          const offset = target.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
          const difference = offset - anchor.offset;
          if (Math.abs(difference) > 0.5) {
            element.scrollTop += difference;
            stableFrames = 0;
          } else {
            stableFrames += 1;
          }
        }
        remainingFrames -= 1;
      }
      if (stableFrames >= 2 || remainingFrames <= 0) {
        pinnedReturnAnchorRef.current = undefined;
        return;
      }
      frame = requestAnimationFrame(settleAnchor);
    };
    frame = requestAnimationFrame(settleAnchor);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [
    chat?.id,
    messageItemIndexes,
    pinnedReturnRestoreId,
    pinnedViewOpen,
    virtuosoKey,
  ]);

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
  }, [conversationIdentity]);

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
  }, [conversationIdentity, draftReplyToMessageId, editingMessage, messagesById]);

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
      ? `回复 ${senderNameForMessage(replyingTo, users, chat, forwardTargetsById)}`
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

  const openActionMenu = useCallback(async (
    message: Message,
    left: number,
    top: number,
    returnFocus?: HTMLElement,
  ) => {
    setActionMenu({
      messageId: message.id,
      left,
      top,
      returnFocus,
    });
    if (message.permissions || actionLoadingId === message.id) return;
    setActionLoadingId(message.id);
    await onLoadMessageProperties(message.chatId, message.id);
    setActionLoadingId((current) => current === message.id ? undefined : current);
  }, [actionLoadingId, onLoadMessageProperties]);

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

  const copyMessage = async (message: Message) => {
    try {
      await copyMessageContent(message);
      closeActionMenu(false);
    } catch {
      // Keep the menu open so the user can retry or download an unavailable image.
    }
  };

  const cancelEditing = () => {
    setEditingMessage(undefined);
    focusComposer();
  };

  const cancelReply = () => {
    setReplyingTo(undefined);
    const currentDraft = telegramStore.getState().drafts.get(topic ? `${chat.id}:topic:${topic.id}` : chat.id);
    if (currentDraft?.replyToMessageId) {
      onDraftChange(chat.id, currentDraft.text, undefined);
    }
    focusComposer();
  };

  const startReply = (message: Message) => {
    if (editingMessage) {
      setEditingMessage(undefined);
    }
    // Persist the reply target immediately. Message updates can replace the
    // `messagesById` map before the composer debounce runs; without a draft
    // target the sync effect treats that update as a cancelled reply.
    const currentDraft = telegramStore.getState().drafts.get(
      topic ? `${chat.id}:topic:${topic.id}` : chat.id,
    );
    onDraftChange(chat.id, currentDraft?.text ?? "", message.id);
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

  const fuckOff = async () => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    const target = deleteTarget;
    const options = await onGetReportOptions(chat.id, [target.id]);
    const option = options?.options.find((item) => /spam|scam|垃圾|诈骗/i.test(item.title)) ?? options?.options[0];
    const chatSenderId = senderChatId(target.senderId);
    const operations: Promise<boolean>[] = [onDeleteMessage(target.id, target.permissions?.canDeleteForAllUsers === true)];
    if (!target.outgoing && target.senderId !== "unknown") {
      operations.push(onBlockSender(chatSenderId ?? target.senderId, chatSenderId ? "chat" : "user", true));
    }
    if (option) operations.push(onReportChat({ chatId: chat.id, messageIds: [target.id], optionId: option.id }));
    const results = await Promise.all(operations);
    setDeletePending(false);
    if (results.every(Boolean)) setDeleteTarget(undefined);
  };

  const capturePinnedReturnAnchor = () => {
    if (!chat || !messageListRef.current) return;
    const element = messageListRef.current;
    const bounds = element.getBoundingClientRect();
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return rowBounds.bottom > bounds.top + 1 && rowBounds.top < bounds.bottom - 1;
      });
    if (!anchor?.dataset.messageId) return;
    pinnedReturnAnchorRef.current = {
      chatId: chat.id,
      messageId: anchor.dataset.messageId,
      offset: anchor.getBoundingClientRect().top - bounds.top,
    };
  };

  const openPinnedMessages = (knownPinnedMessages: Message[] = []) => {
    if (!chat) return;
    capturePinnedReturnAnchor();
    setChatMenuOpen(false);
    openPinnedView(knownPinnedMessages);
  };

  const closePinnedMessages = () => {
    closePinnedView();
    setPinnedReturnRestoreId((current) => current + 1);
  };

  const openMessageInHistory = (chatId: string, messageId: string) => {
    if (pinnedViewOpen) {
      pinnedReturnAnchorRef.current = undefined;
      closePinnedView();
    }
    onOpenMessage(chatId, messageId);
  };

  const confirmPin = async (disableNotification: boolean, onlyForSelf: boolean) => {
    if (!pinTarget || pinPending) return;
    setPinPending(true);
    const succeeded = await onPinMessage(pinTarget.id, disableNotification, onlyForSelf);
    setPinPending(false);
    if (succeeded) setPinTarget(undefined);
  };

  const unpinFromMenu = async (message: Message) => {
    if (pinnedUnpinId) return;
    setPinnedUnpinId(message.id);
    const succeeded = await onUnpinMessage(message.id);
    if (succeeded) {
      removeLoadedMessage(message);
    }
    setPinnedUnpinId(undefined);
  };

  const saveAutoDelete = async (seconds: number) => {
    if (!chat || autoDeletePending) return;
    setAutoDeletePending(true);
    const succeeded = await onSetChatMessageAutoDeleteTime(chat.id, seconds);
    setAutoDeletePending(false);
    if (succeeded) setAutoDeleteDialogOpen(false);
  };

  const startForwardSelection = (message: Message) => {
    if (editingMessage) {
      setEditingMessage(undefined);
    }
    setActionMenu(undefined);
    forwarding.startSelection(message);
    globalThis.setTimeout(() => selectionForwardButtonRef.current?.focus(), 0);
  };

  const toggleMessageSelection = forwarding.toggleSelection;
  const confirmForward = forwarding.confirm;

  return (
    <section
      ref={conversationRef}
      className={`conversation ${topic && !selectionMode && !pinnedViewOpen ? "has-forum-topic-strip" : ""} ${selectionMode ? "is-selecting-messages" : ""} ${pinnedViewOpen ? "is-pinned-messages-view" : ""}`}
      onPointerUp={(event) => {
        if (event.button !== 0 || selectionMode || pinnedViewOpen) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
        const selection = globalThis.getSelection();
        if (selection && !selection.isCollapsed) return;
        composerInputRef.current?.focus({ preventScroll: true });
      }}
      aria-label={`${topic ? `${topic.name} 话题` : chat.title} 对话`}
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
        ) : pinnedViewOpen ? (
          <>
            <button
              className="icon-button pinned-messages-back"
              type="button"
              aria-label="返回会话"
              title="返回会话"
              onClick={closePinnedMessages}
            >
              <ChevronLeft size={21} strokeWidth={2} />
            </button>
            <span className="pinned-view-heading-icon" aria-hidden="true">
              <Pin size={18} strokeWidth={1.9} />
            </span>
            <div className="pinned-view-title">
              <strong>置顶消息</strong>
              <span>{pinnedMessagesLoading ? "正在读取" : `${allPinnedMessages.length} 条消息`}</span>
            </div>
          </>
        ) : (
          <>
            {!topic && (
              <button
                className="mobile-back icon-button"
                type="button"
                aria-label="返回会话列表"
                title="返回会话列表"
                onClick={onBack}
              >
                <ChevronLeft size={21} strokeWidth={2} />
              </button>
            )}
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
                {topic?.isClosed ? (
                  <span className="conversation-typing-status">话题已关闭</span>
                ) : typingStatus && (
                  <span className="conversation-typing-status" role="status">
                    {typingStatus}
                  </span>
                )}
              </span>
            </button>
            <div className="conversation-actions">
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
                  onOpenPinned={() => openPinnedMessages()}
                  onOpenMessageSearch={() => onOpenMessageSearch()}
                  onOpenAutoDelete={() => {
                    setChatMenuOpen(false);
                    setAutoDeleteDialogOpen(true);
                  }}
                  onClose={() => closeChatMenu(true)}
                />
              )}
            </div>
          </>
        )}
      </header>

      {topic && !selectionMode && !pinnedViewOpen && (
        <ForumTopicStrip
          topics={topics}
          activeTopicId={topic.id}
          onSelectTopic={onSelectTopic}
        />
      )}

      <div className={`message-list-shell ${positioning ? "is-positioning" : ""} ${pinnedViewOpen ? "pinned-message-view" : ""} ${pinnedBannerVisible ? "has-pinned-message-banner" : ""}`}>
        {pinnedBannerVisible && (
          <PinnedMessageBanner
            messages={allPinnedMessages}
            message={pinnedBannerMessage}
            onOpenAll={openPinnedMessages}
            onOpenMessage={openPinnedBannerMessage}
          />
        )}
        {pinnedViewOpen && pinnedMessagesLoading && allPinnedMessages.length === 0 && (
          <div className="pinned-messages-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>正在读取置顶消息</span>
          </div>
        )}
        {!pinnedViewOpen && positioning && renderedMessages.length === 0 && !preservePositioningFrame && (
          <div
            className={`message-positioning-placeholder ${renderedMessages.length > 0 ? "is-warm" : ""}`}
            role="status"
          >
            <LoaderCircle className="spin" size={18} />
            <span>正在加载消息</span>
          </div>
        )}
        {!pinnedViewOpen && historyLoading && (
          <div className="history-loading" aria-label="正在加载更早消息">
            <LoaderCircle className="spin" size={16} />
          </div>
        )}
        <Virtuoso
          key={virtuosoKey}
          className={`message-list ${messageListScrolling ? "is-scrolling" : ""} ${!pinnedViewOpen && (historyLoading || historyScrollbarSettling) ? "is-history-adjusting" : ""}`}
          ref={virtuosoRef}
          scrollerRef={setMessageListRef}
          isScrolling={setMessageListScrolling}
          role="log"
          aria-label={pinnedViewOpen ? "置顶消息列表" : "消息列表"}
          aria-busy={
            positioning ||
            (pinnedViewOpen && pinnedMessagesLoading) ||
            (!pinnedViewOpen && historyLoading)
          }
          tabIndex={0}
          alignToBottom={initialAlignToBottom}
          components={pinnedViewOpen ? pinnedMessageListComponents : messageListComponents}
          computeItemKey={(_, block) => block.id}
          data={visibleMessageBlocks}
          defaultItemHeight={52}
          followOutput={followOutput}
          rangeChanged={onInitialRangeChanged}
          atBottomThreshold={0}
          atBottomStateChange={onInitialAtBottomStateChange}
          initialTopMostItemIndex={restoreStateFrom ? undefined : initialTopMostItemIndex}
          restoreStateFrom={restoreStateFrom}
          totalListHeightChanged={onTotalListHeightChanged}
          increaseViewportBy={{ top: 900, bottom: 280 }}
          minOverscanItemCount={{ top: 2, bottom: 2 }}
          {...messageListHandlers}
          itemContent={(_, groupModel) => {
            const { firstMessage, messages: messageGroup, positions, startsNewDay } = groupModel;
            const reserveSenderAvatar = firstMessage.content.kind !== "service" &&
              firstMessage.content.kind !== "unsupported" &&
              !firstMessage.outgoing && chat.kind !== "direct";
            const showSenderAvatar = reserveSenderAvatar && !groupModel.continuesAfter &&
              messageGroup.some((message) => !message.isRemoving);
            const sender = users.get(firstMessage.senderId);
            const senderChat = senderChatId(firstMessage.senderId);
            const senderChatDetails = senderChat ? forwardTargetsById.get(senderChat) : undefined;
            const senderName = sender?.displayName ??
              senderChatDetails?.title ??
              (chat.kind === "direct" ? chat.title : "Telegram 用户");
            const senderAvatar = sender?.avatar ??
              senderChatDetails?.avatar ??
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
                      <button
                        className="message-sender-avatar"
                        type="button"
                        aria-label={`查看 ${senderName} 资料`}
                        onClick={() => onOpenSenderProfile(firstMessage.senderId)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setSenderMenu({
                            senderId: firstMessage.senderId,
                            senderName,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                          event.preventDefault();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          setSenderMenu({
                            senderId: firstMessage.senderId,
                            senderName,
                            x: bounds.left + bounds.width / 2,
                            y: bounds.top + bounds.height / 2,
                          });
                        }}
                      >
                        <Avatar
                          avatar={senderAvatar ?? {
                            label: Array.from(senderName.trim())[0] ?? "?",
                            color: "#73828c",
                          }}
                          size="small"
                        />
                      </button>
                    )}
                  </span>
                )}
                <div className="message-group-stack">
                  {(selectionMode
                    ? messageGroup.map((message) => ({ kind: "message" as const, message }))
                    : groupModel.segments
                  ).map((segment) => {
                    const renderBubble = (message: Message, albumItem = false) => {
                      const entrance = messageEntranceFor(message);
                      return <RichMessageBubble
                        key={message.renderKey ?? message.id}
                        message={message}
                        entrance={entrance}
                        senderName={senderName}
                        senderLabel={message.senderTag || memberLabels.get(message.senderId)}
                        senderProfileAvailable={!message.outgoing && message.senderId !== "unknown"}
                        groupPosition={positions.get(message.id) ?? "single"}
                        replyPreview={replyPreviewFor(
                          message,
                          messagesById,
                          users,
                          chat,
                          forwardTargetsById,
                          currentUserId,
                        )}
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
                        onPollAnswer={onSetPollAnswer}
                        onBotCallback={onBotCallback}
                        onExpandLongText={revealMessageStart}
                        onMount={message.id === appendMountMessageId
                          ? pinFollowingMessageMount
                          : undefined}
                        deferUntilPinned={message.id === appendMountMessageId}
                        nextAudioPlaybackId={nextAudioPlaybackIdByMessage.get(message.id)}
                        onOpenReply={openMessageInHistory}
                        onOpenSenderProfile={onOpenSenderProfile}
                        onOpenMedia={selectionMode ? undefined : openMediaViewer}
                        cornerAction={!selectionMode && pinnedViewOpen ? (
                          <MessageSourceLocateButton
                            message={message}
                            onLocate={openMessageInHistory}
                          />
                        ) : undefined}
                        albumItem={albumItem}
                        autoplayAnimations={autoplayAnimations}
                        autoDownloadPolicy={autoDownloadPolicy}
                        developerMode={developerMode}
                      />;
                    };
                    if (segment.kind === "message") return renderBubble(segment.message);

                    const captionMessages = segment.messages.filter((message) =>
                      message.content.kind === "media" && Boolean(message.content.caption),
                    );
                    const albumReply = segment.messages.map((message) => replyPreviewFor(
                      message,
                      messagesById,
                      users,
                      chat,
                      forwardTargetsById,
                      currentUserId,
                    )).find(Boolean);
                    return (
                      <div
                        className={`media-album ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"}`}
                        data-media-album-id={segment.albumId}
                        key={`album:${segment.albumId}:${segment.messages[0]?.renderKey ?? segment.messages[0]?.id}`}
                        role="group"
                        aria-label={`${segment.messages.length} 项媒体相册`}
                      >
                        {albumReply && (
                          <button
                            className={`message-reply-preview media-album-reply ${albumReply.isCurrentUser ? "is-current-user" : ""}`}
                            type="button"
                            disabled={!albumReply.messageId}
                            onClick={() => {
                              if (albumReply.chatId && albumReply.messageId) {
                                openMessageInHistory(albumReply.chatId, albumReply.messageId);
                              }
                            }}
                          >
                            <strong>{albumReply.author}</strong>
                            <small>{albumReply.text}</small>
                          </button>
                        )}
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
        {!pinnedViewOpen && currentScrollKey && attentionMessageIds.length > 0 && (
          <button
            className={`conversation-jump-button jump-to-attention ${awayFromLatest ? "is-stacked" : ""}`}
            type="button"
            aria-label={`跳到提及或引用，${attentionMessageIds.length} 条待查看`}
            title="跳到提及或引用"
            onClick={() => {
              const messageId = attentionMessageIds.at(-1);
              if (
                chat && messageId &&
                revealAttentionMessage(messageId)
              ) {
                dismissMessageAttention(chat.id, messageId);
              }
            }}
          >
            <AtSign size={19} strokeWidth={2.1} />
            <span>{attentionMessageIds.length > 99 ? "99+" : attentionMessageIds.length}</span>
          </button>
        )}
        {!pinnedViewOpen && currentScrollKey && awayFromLatest && (
            <button
              className="conversation-jump-button jump-to-latest"
              type="button"
              aria-label={newMessageNotice?.key === currentScrollKey && newMessageNotice.count > 0
                ? `跳到最新消息，${newMessageNotice.count} 条新消息`
                : "跳到最新消息"}
              title="跳到最新消息"
              onClick={() => jumpToLatest("auto", true)}
            >
              <ArrowDown size={19} strokeWidth={2.1} />
              {newMessageNotice?.key === currentScrollKey && newMessageNotice.count > 0 && (
                <span>{newMessageNotice.count > 99 ? "99+" : newMessageNotice.count}</span>
              )}
            </button>
          )}
      </div>

      {actionMenu && actionMessage && (
        <MessageActionMenu
          position={actionMenu}
          message={actionMessage}
          loading={actionLoadingId === actionMessage.id}
          onReply={() => startReply(actionMessage)}
          onEdit={() => startEditing(actionMessage)}
          onForward={() => startForwardSelection(actionMessage)}
          onDelete={() => {
            setDeleteTarget(actionMessage);
            setActionMenu(undefined);
          }}
          onPin={actionMessage.permissions?.canPin ? () => {
            setPinTarget(actionMessage);
            setActionMenu(undefined);
          } : undefined}
          onUnpin={actionMessage.permissions?.canPin ? () => {
            setActionMenu(undefined);
            void unpinFromMenu(actionMessage);
          } : undefined}
          onPlayInWindow={actionMessage.content.kind === "media" &&
            ["video", "videoNote"].includes(actionMessage.content.mediaType)
            ? () => {
                closeActionMenu(false);
                requestVideoWindowPlayback(`${actionMessage.chatId}:${actionMessage.id}`);
              }
            : undefined}
          onDownload={(actionMessage.content.kind === "media" || actionMessage.content.kind === "file") &&
            actionMessage.content.fileId !== undefined &&
            actionMessage.content.canDownload !== false &&
            actionMessage.content.isDownloading !== true
            ? () => {
              const content = actionMessage.content;
                if ((content.kind !== "media" && content.kind !== "file") || content.fileId === undefined) return;
                closeActionMenu(false);
                void onDownloadFile(
                  content.fileId,
                  content.fileName,
                );
              }
            : undefined}
          onCopy={() => void copyMessage(actionMessage)}
          onCopyRaw={developerMode ? () => void copyRawMessage(actionMessage) : undefined}
          onReport={() => { setReportTarget(actionMessage); setActionMenu(undefined); }}
          onDismiss={() => closeActionMenu(false)}
          onClose={() => closeActionMenu(true)}
        />
      )}

      {senderMenu && (
        <SenderActionMenu
          position={senderMenu}
          senderName={senderMenu.senderName}
          onSearch={() => onOpenMessageSearch(senderMenu.senderId)}
          onDismiss={() => setSenderMenu(undefined)}
        />
      )}

      <MotionPresence present={Boolean(reportTarget && chat)}>
        {reportTarget && chat
          ? <ReportDialog chatId={chat.id} messageIds={[reportTarget.id]} title={chat.title} onGetOptions={onGetReportOptions} onSubmit={onReportChat} onClose={() => setReportTarget(undefined)} />
          : null}
      </MotionPresence>

      {pinnedViewOpen ? null : selectionMode ? (
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
        key={topic ? `${chat.id}:${topic.id}` : chat.id}
        chatId={chat.id}
        draftKey={topic ? `${chat.id}:topic:${topic.id}` : chat.id}
        editingMessage={editingMessage}
        replyingTo={replyingTo}
        contextTitle={composerContextTitle}
        defaultBotUsername={chat.kind === "direct" && chat.peerId && users.get(chat.peerId)?.isBot
          ? users.get(chat.peerId)?.username
          : undefined}
        inputRef={composerInputRef}
        connectionStatus={connectionStatus}
        queuedMessageCount={queuedMessageCount}
        failedQueuedMessageCount={failedQueuedMessageCount}
        queuedAttachmentCount={queuedAttachmentCount}
        failedAttachmentCount={failedAttachmentCount}
        onSendMessage={sendMessageAndFollowLatest}
        onEditMessage={onEditMessage}
        onDraftChange={onDraftChange}
        onTypingChange={onTypingChange}
        onSendFiles={sendFilesAndFollowLatest}
        onCancelEditing={cancelEditing}
        onCancelReply={cancelReply}
        onGetBotCommands={onGetBotCommands}
        onGetInlineResults={onGetInlineResults}
        onSendInlineResult={onSendInlineResult}
        onSendBotStart={onSendBotStart}
      />
      )}

      <MotionPresence present={Boolean(deleteTarget)}>
        {deleteTarget ? <DeleteMessageDialog
          message={deleteTarget}
          pending={deletePending}
          onConfirm={(revoke) => void confirmDelete(revoke)}
          onFuckOff={() => void fuckOff()}
          onClose={() => setDeleteTarget(undefined)}
        /> : null}
      </MotionPresence>

      <MotionPresence present={Boolean(pinTarget)}>
        {pinTarget ? <PinMessageDialog
          message={pinTarget}
          pending={pinPending}
          allowOnlyForSelf={chat.kind === "direct"}
          allowNotification={chat.kind === "group"}
          onConfirm={(disableNotification, onlyForSelf) => void confirmPin(disableNotification, onlyForSelf)}
          onClose={() => { if (!pinPending) setPinTarget(undefined); }}
        /> : null}
      </MotionPresence>

      <MotionPresence present={Boolean(autoDeleteDialogOpen && chat)}>
        {autoDeleteDialogOpen && chat ? <AutoDeleteDialog
          currentTime={chat.messageAutoDeleteTime ?? 0}
          pending={autoDeletePending}
          onConfirm={(seconds) => void saveAutoDelete(seconds)}
          onClose={() => { if (!autoDeletePending) setAutoDeleteDialogOpen(false); }}
        /> : null}
      </MotionPresence>

      <MotionPresence present={Boolean(forwardDialogOpen && selectionMode)}>
        {forwardDialogOpen && selectionMode ? <ForwardMessagesDialog
          selectedCount={selectedMessageIds.size}
          targets={filteredForwardTargets}
          topicsByChat={forumTopics}
          currentChatId={chat.id}
          query={forwardQuery}
          pending={forwardPending}
          pendingTargetId={forwardPendingTargetId}
          onQueryChange={forwarding.setQuery}
          onLoadTopics={onLoadForumTopics}
          onConfirm={(target, topicId) => void confirmForward(target, topicId)}
          onClose={forwarding.closeDialog}
        /> : null}
      </MotionPresence>

    </section>
  );
}
