import { translate } from "../i18n";
import {
  ArrowDown,
  ArrowUpRight,
  AtSign,
  Check,
  ChevronRight,
  Heart,
  ChevronLeft,
  Copy,
  Forward,
  MoreVertical,
  LoaderCircle,
  Pin,
  Play,
  MessageCircle,
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
  type CSSProperties,
} from "react";
import { Virtuoso, type Components, type ListProps } from "react-virtuoso";
import type {
  Chat,
  ChatMessageSearchInput,
  ConnectionStatus,
  ForumTopic,
  Message,
  SponsoredMessage,
  MessagePermissions,
  MessageReactionSenderPage,
  MessageReactionType,
  MessageReplyQuote,
  MessageTextEntity,
  ForwardMessagesResult,
  User,
} from "../telegram/types";
import {
  useConversationScroll,
  type ConversationScrollRequest,
  type MessageConversationScrollRequest,
} from "../hooks/useConversationScroll";
import { useMessageForwarding } from "../hooks/useMessageForwarding";
import { useConversationActivityTracker } from "../hooks/useConversationActivityTracker";
import {
  getConversationActivityRecords,
  quickForwardChatsAt,
  sortChatsByConversationActivity,
} from "../store/conversationActivity";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { formatMessageDay, formatUnreadCount, localDateKey } from "../utils/formatters";
import { observeLayout } from "../utils/layoutObservation";
import { Avatar } from "./Avatar";
import {
  DeleteMessagesDialog,
  MessageActionMenu,
  AutoDeleteDialog,
  PinMessageDialog,
  SenderActionMenu,
} from "./ConversationOverlays";
import { ForwardMessagesDialog } from "./ForwardMessagesDialog";
import {
  forwardSourceFor,
  channelAuthorFor,
  channelDiscussionAvailable,
  displaysChannelMetadata,
  messageSummary,
  replyPreviewFor,
  senderChatId,
  senderNameForMessage,
} from "./conversationMessages";
import { channelDiscussionProjection } from "../store/telegramStore.messages";
import { MessageBubble as RichMessageBubble } from "./MessageBubble";
import { usePreferencesStore } from "../store/preferencesStore";
import { autoplayAllowed } from "../utils/motionPreference";
import { colorThemeForThemeId } from "../theme/theme";
import { ConversationComposer } from "./ConversationComposer";
import { ReportDialog } from "./SafetySettings";
import { photoMessages, photoThumbnailWindow } from "../utils/mediaViewerModel";
import {
  openMediaViewerWindow,
  syncMediaViewerWindow,
} from "../media/mediaViewerWindowBridge";
import {
  indexMessagesByVirtualBlock,
  virtualizeMessageGroups,
  virtualizeMessageTimeline,
  type VirtualMessageBlock,
} from "../utils/messageVirtualization";
import { requestVideoWindowPlayback } from "../media/videoWindowBridge";
import { ChatActionMenu } from "./ChatActionMenu";
import { MotionPresence } from "./MotionPresence";
import { ChannelDiscussionPanel } from "./ChannelDiscussionPanel";
import { motionLifecycleTiming } from "../utils/motionTokens";
import { recentMentionUserIdsFor } from "../utils/mentionSuggestions";
import { ForumTopicStrip } from "./ForumTopicStrip";
import { copyMessageContent, writeClipboardText } from "../utils/clipboard";
import { formatSelectedMessages } from "../utils/messageClipboard";
import {
  clampSelectionToMessageText,
  replyQuoteFromSelection,
  type SelectionPointerPosition,
} from "../utils/messageTextSelection";
import { telegramStore, useTelegramStore } from "../store/telegramStore";
import { useLocalUserBlocks } from "../store/localUserBlocks";
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
import { conversationHeaderStatus } from "../utils/conversationHeaderStatus";
import {
  audioPlaybackController,
  type AudioTrackDescriptor,
} from "../media/audioPlayback";
import { localMediaSource } from "../media/localMediaSource";
import {
  mentionTextForUser,
  type ComposerTextInsertion,
} from "../utils/composerInsertion";
import { loadMessageActionPermissions } from "../utils/messageActionPermissions";
import { layoutMediaAlbum } from "../utils/mediaAlbumLayout";
import { mediaAlbumCaptionMessage, mediaAlbumMessagesFor } from "../utils/mediaAlbums";
import { isEditableMessageContent, messageContentText } from "../telegram/messageContent";
import { MessageRichText } from "./MessageRichText";
import { openExternalLink } from "../utils/externalLinks";
import {
  localBlockedMessageGroups,
  replySenderId,
} from "../utils/localBlockedMessages";

const EMPTY_ATTENTION_MESSAGE_IDS: string[] = [];
const MESSAGE_TARGET_HIGHLIGHT_INSET_PX = 4;
// Keep the first frame responsive on cold conversations while retaining enough
// nearby rows for smooth short scrolls and anchor correction.
const MESSAGE_VIEWPORT_PREFETCH = { top: 640, bottom: 192 } as const;
type DiscussionThreadState = {
  loading: boolean;
  error?: boolean;
  replyChatId?: string;
  replyMessageId?: string;
};

type MessageNavigationOptions = Pick<
  MessageConversationScrollRequest,
  "behavior" | "highlight" | "revealLocallyBlocked"
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
    aria-label={translate("跳转到消息原位置：{{value0}}", { value0: messageSummary(message.content) })}
    title={translate("跳转到消息原位置")}
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

const EmptyMessageList = () => <div className="messages-empty">{translate("没有匹配的消息")}</div>;
const EmptyPinnedMessageList = () => <div className="messages-empty">{translate("当前没有置顶消息")}</div>;
const MessageListFooter = () => <div className="message-list-end-sentinel" aria-hidden="true" />;

const SponsoredMessageCard = ({
  message,
  onClick,
}: {
  message: SponsoredMessage;
  onClick: () => void;
}) => {
  const contentText = messageContentText(message.content).trim();
  return (
    <article className="sponsored-message-card" data-sponsored-message-id={message.id}>
      <div className="sponsored-message-header">
        <Avatar avatar={message.sponsor.avatar} size="small" />
        <div className="sponsored-message-heading">
          <strong>{message.title}</strong>
          <span>{message.isRecommended ? translate("推荐") : translate("赞助")}</span>
        </div>
        <span className="sponsored-message-mark" aria-hidden="true">AD</span>
      </div>
      {contentText && <p>{contentText}</p>}
      {message.sponsor.info && <small className="sponsored-message-info">{message.sponsor.info}</small>}
      <button
        className="sponsored-message-action"
        type="button"
        onClick={() => {
          onClick();
          if (message.sponsor.url) void openExternalLink(message.sponsor.url).catch(() => undefined);
        }}
      >
        <span>{message.buttonText}</span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </button>
      {message.additionalInfo && <small className="sponsored-message-additional">{message.additionalInfo}</small>}
    </article>
  );
};

const messageListComponents: Components<VirtualMessageBlock> = {
  EmptyPlaceholder: EmptyMessageList,
  Footer: MessageListFooter,
  List: VirtualMessageListContent,
};

const pinnedMessageListComponents: Components<VirtualMessageBlock> = {
  EmptyPlaceholder: EmptyPinnedMessageList,
  Footer: MessageListFooter,
  List: VirtualMessageListContent,
};

interface ConversationProps {
  chat?: Chat;
  topic?: ForumTopic;
  topics: ForumTopic[];
  onSelectTopic: (topicId: string) => void;
  scrollScope: string;
  scrollRequest?: ConversationScrollRequest;
  messages: Message[];
  sponsoredMessages?: SponsoredMessage[];
  sponsoredMessagesBetween?: number;
  chatMessages: Message[];
  forwardTargets: Chat[];
  forumTopics: Map<string, ForumTopic[]>;
  users: Map<string, User>;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  queuedAttachmentCount: number;
  failedAttachmentCount: number;
  typingUserIds: string[];
  chatListId: string;
  chatManagementPending: boolean;
  onSendMessage: (
    text: string,
    replyToMessageId?: string,
    replyQuote?: MessageReplyQuote,
    entities?: MessageTextEntity[],
    disableNotification?: boolean,
  ) => Promise<boolean>;
  onEditMessage: (
    messageId: string,
    text: string,
    entities?: MessageTextEntity[],
    chatId?: string,
  ) => Promise<boolean>;
  onDeleteMessage: (messageId: string, revoke: boolean, chatId?: string) => Promise<boolean>;
  onDraftChange: (
    chatId: string,
    text: string,
    replyToMessageId?: string,
    replyQuote?: MessageReplyQuote,
    entities?: MessageTextEntity[],
  ) => void;
  onTypingChange: (chatId: string, typing: boolean) => Promise<void>;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
    toTopicId?: string,
    description?: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  onLoadForumTopics: (chatId: string) => Promise<import("../telegram/types").ForumTopicPage | undefined>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
    force?: boolean,
  ) => Promise<MessagePermissions | undefined>;
  onLoadRawMessage: (chatId: string, messageId: string) => Promise<string | undefined>;
  onSetMessageReaction: (messageId: string, emoji: string, chosen: boolean, chatId?: string) => Promise<void>;
  onGetMessageReactionSenders: (
    messageId: string,
    type: MessageReactionType,
    offset?: string,
    chatId?: string,
  ) => Promise<MessageReactionSenderPage>;
  onSetPollAnswer: (messageId: string, optionPositions: number[], chatId?: string) => Promise<boolean>;
  onBotCallback: (messageId: string, data: string, chatId?: string) => Promise<import("../telegram/types").CallbackQueryAnswer | undefined>;
  onLoadPinnedMessages: (chatId: string) => Promise<Message[]>;
  onPinMessage: (
    messageId: string,
    disableNotification: boolean,
    onlyForSelf: boolean,
    chatId?: string,
  ) => Promise<boolean>;
  onUnpinMessage: (messageId: string, chatId?: string) => Promise<boolean>;
  onSetChatMessageAutoDeleteTime: (chatId: string, seconds: number) => Promise<boolean>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onCancelFileDownload: (fileId: number) => Promise<void>;
  onRecoverFile: (fileId: number, priority?: number) => Promise<boolean>;
  onOpenFile: (sourcePath: string, fileId?: number) => Promise<boolean>;
  onSaveFileToDownloads: (sourcePath: string, fileName: string) => Promise<void>;
  onSaveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  onOpenDownloadDirectory: () => Promise<void>;
  onStreamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendFileStream: (fileId: number) => Promise<void>;
  onRetryMessage: (messageId: string, chatId?: string) => Promise<void>;
  onSendFiles: (
    attachments: import("../telegram/types").OutgoingAttachment[],
    caption?: string,
    captionEntities?: MessageTextEntity[],
    replyToMessageId?: string,
    replyQuote?: MessageReplyQuote,
    disableNotification?: boolean,
  ) => Promise<boolean>;
  onCancelFileUpload: (messageId: string, chatId?: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onOpenProfile: () => void;
  onViewportReady?: (identity: string) => void;
  onOpenMessage: (
    chatId: string,
    messageId: string,
    options?: MessageNavigationOptions,
  ) => void;
  onOpenMessageSearch: (senderId?: string, chatId?: string) => void;
  onOpenChat: (chatId: string) => void;
  onOpenSenderProfile: (senderId: string) => void;
  onOpenMention: (username?: string, userId?: string) => void;
  onSearchHashtag: (hashtag: string, chatId?: string) => void;
  onOpenStickerSet: (stickerSetId: string) => void;
  onClickSponsoredMessage?: (chatId: string, messageId: string, isMediaClick?: boolean) => Promise<void>;
  onStartPrivateChat: (senderId: string) => void;
  onSetChatPinned: (pinned: boolean) => Promise<boolean>;
  onSetChatMuted: (muted: boolean) => Promise<boolean>;
  onSetChatArchived: (archived: boolean) => Promise<boolean>;
  discussionPostId?: string;
  onOpenDiscussion: (postId: string) => void;
  onCloseDiscussion: () => void;
  onBack: () => void;
  onGetBotCommands: (query?: string, botUsername?: string) => Promise<import("../telegram/types").BotCommandSuggestion[]>;
  onGetInlineResults: (botUsername: string, query: string, offset?: string) => Promise<import("../telegram/types").InlineQueryResultPage | undefined>;
  onSendInlineResult: (botUserId: string, queryId: string, resultId: string, replyToMessageId?: string) => Promise<boolean>;
  onSendBotStart: (botUserId: string, parameter?: string) => Promise<boolean>;
  botStartPending: boolean;
  botStartSending: boolean;
  onConfirmBotStart: () => Promise<boolean>;
  onGetReportOptions: (chatId: string, messageIds: string[]) => Promise<import("../telegram/types").ChatReportOptions | undefined>;
  onReportChat: (input: import("../telegram/types").ReportChatInput) => Promise<boolean>;
  mobileViewport?: boolean;
  mobileChatOpen?: boolean;
}

export function Conversation({
  chat,
  topic,
  topics,
  onSelectTopic,
  scrollScope,
  scrollRequest,
  messages,
  sponsoredMessages = [],
  sponsoredMessagesBetween = 0,
  chatMessages,
  forwardTargets,
  forumTopics,
  users,
  historyLoading,
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
  onGetMessageReactionSenders,
  onSetPollAnswer,
  onBotCallback,
  onLoadPinnedMessages,
  onPinMessage,
  onUnpinMessage,
  onSetChatMessageAutoDeleteTime,
  onDownloadFile,
  onCancelFileDownload,
  onRecoverFile,
  onOpenFile,
  onSaveFileToDownloads,
  onSaveFileAs,
  onOpenDownloadDirectory,
  onStreamFile,
  onSuspendFileStream,
  onRetryMessage,
  onSendFiles,
  onCancelFileUpload,
  onLoadOlder,
  onOpenProfile,
  onViewportReady,
  onOpenMessage,
  onOpenMessageSearch,
  onOpenChat,
  onOpenSenderProfile,
  onOpenMention,
  onSearchHashtag,
  onOpenStickerSet,
  onClickSponsoredMessage,
  onStartPrivateChat,
  onSetChatPinned,
  onSetChatMuted,
  onSetChatArchived,
  discussionPostId,
  onOpenDiscussion,
  onCloseDiscussion,
  onBack,
  onGetBotCommands,
  onGetInlineResults,
  onSendInlineResult,
  onSendBotStart,
  botStartPending,
  botStartSending,
  onConfirmBotStart,
  onGetReportOptions,
  onReportChat,
  mobileViewport = false,
  mobileChatOpen = false,
}: ConversationProps) {
  const conversationIdentity = chat
    ? topic ? `${chat.id}:topic:${topic.id}` : chat.id
    : undefined;
  const activeAccountId = useTelegramStore((state) => state.activeAccountId);
  const localBlockedUsers = useLocalUserBlocks((state) => state.users);
  const localBlockedUsersById = useMemo(() => new Map(
    chat?.kind === "group"
      ? localBlockedUsers
          .filter((user) => user.accountId === activeAccountId)
          .map((user) => [user.userId, user] as const)
      : [],
  ), [activeAccountId, chat?.kind, localBlockedUsers]);
  const localBlockedUserIds = useMemo(
    () => new Set(localBlockedUsersById.keys()),
    [localBlockedUsersById],
  );
  const localBlockedReactionUserIds = useMemo(
    () => new Set(localBlockedUsers
      .filter((user) => user.accountId === activeAccountId)
      .map((user) => user.userId)),
    [activeAccountId, localBlockedUsers],
  );
  const [revealedLocalBlockMessages, setRevealedLocalBlockMessages] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [revealedLocalBlockGroups, setRevealedLocalBlockGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const seenRevealedMessagesRef = useRef(new Set<string>());
  const seenRevealedGroupsRef = useRef(new Set<string>());
  const handledLocalBlockRevealRequestRef = useRef<number | undefined>(undefined);
  const mobileViewHidden = mobileViewport && !mobileChatOpen;
  useConversationActivityTracker(activeAccountId, chat?.id, !mobileViewHidden);
  const knownNonBotUsernames = useMemo(() => {
    const usernames = new Set<string>();
    for (const user of users.values()) {
      if (user.isBot === true) continue;
      const username = user.username?.trim().replace(/^@/, "");
      const displayTokens = [
        user.displayName,
        user.firstName,
        user.lastName,
        ...(user.displayName.match(/[A-Za-z0-9_]{1,32}/g) ?? []),
      ];
      for (const value of [username, ...displayTokens]) {
        if (value && /^[A-Za-z0-9_]{1,32}$/.test(value)) {
          usernames.add(value.toLocaleLowerCase());
        }
      }
    }
    return usernames;
  }, [users]);
  const mentionableUsers = useMemo(
    () => [...users.values()].filter((user) => user.isBot !== true),
    [users],
  );
  const mentionUsers = chat?.kind === "group" ? mentionableUsers : [];
  const recentMentionUserIds = useMemo(
    () => recentMentionUserIdsFor(messages),
    [messages],
  );
  const currentUserId = useTelegramStore((state) => state.currentUserId);
  const storedMessages = useTelegramStore((state) => state.messages);
  const loadMessageThreadHistory = useTelegramStore((state) => state.loadMessageThreadHistory);
  const sendMessageToThread = useTelegramStore((state) => state.sendMessageToThread);
  const sendFilesToThread = useTelegramStore((state) => state.sendFilesToThread);
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
    replyQuote?: MessageReplyQuote;
    keyboardNavigation?: boolean;
  }>();
  const [actionForwardTargets, setActionForwardTargets] = useState<Chat[]>([]);
  const [senderMenu, setSenderMenu] = useState<{
    senderId: string;
    senderName: string;
    x: number;
    y: number;
  }>();
  const [composerTextInsertion, setComposerTextInsertion] = useState<ComposerTextInsertion>();
  const composerTextInsertionIdRef = useRef(0);
  const consumeComposerTextInsertion = useCallback((id: string) => {
    setComposerTextInsertion((current) => current?.id === id ? undefined : current);
  }, []);
  const [actionLoadingId, setActionLoadingId] = useState<string>();
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [replyQuote, setReplyQuote] = useState<MessageReplyQuote>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [discussionPost, setDiscussionPost] = useState<Message>();
  const [discussionThreads, setDiscussionThreads] = useState<Record<string, DiscussionThreadState>>({});
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  const storedMessagesRef = useRef(storedMessages);
  storedMessagesRef.current = storedMessages;
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
  const chatAdministratorLabels = useTelegramStore((state) => state.chatAdministratorLabels);
  const loadChatManagement = useTelegramStore((state) => state.loadChatManagement);
  const loadChatAdministratorLabels = useTelegramStore((state) => state.loadChatAdministratorLabels);
  const draftReplyToMessageId = useTelegramStore((state) =>
    chat ? state.drafts.get(topic ? `${chat.id}:topic:${topic.id}` : chat.id)?.replyToMessageId : undefined,
  );
  const draftReplyQuote = useTelegramStore((state) =>
    chat ? state.drafts.get(topic ? `${chat.id}:topic:${topic.id}` : chat.id)?.replyQuote : undefined,
  );
  const cacheFile = useTelegramStore((state) => state.cacheFile);
  const autoplayAnimations = usePreferencesStore((state) => autoplayAllowed(
    state.autoplayAnimations,
    state,
  ));
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
  const [visibleMessageDay, setVisibleMessageDay] = useState<string>();
  const [dateIndicatorVisible, setDateIndicatorVisible] = useState(false);
  const dateIndicatorFrameRef = useRef<number | undefined>(undefined);
  const dateIndicatorHideTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
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
    if (chat.management?.canOpenManagement) {
      void loadChatManagement(chat.id);
    } else {
      void loadChatAdministratorLabels(chat.id, true);
    }
  }, [chat?.id, chat?.kind, chat?.management?.canOpenManagement, loadChatAdministratorLabels, loadChatManagement]);
  const memberLabels = useMemo(() => new Map(
    Object.entries(chat ? chatAdministratorLabels.get(chat.id) ?? {} : {}),
  ), [chat, chatAdministratorLabels]);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const selectionMessageRef = useRef<HTMLElement | null>(null);
  const selectionPointerRef = useRef<SelectionPointerPosition | undefined>(undefined);
  const selectionClampActiveRef = useRef(false);
  const selectionDragRef = useRef<{
    anchorIndex: number;
    pointerId: number;
    moved: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | undefined>(undefined);
  const suppressSelectionClickRef = useRef(false);
  const selectionAutoScrollFrameRef = useRef<number | undefined>(undefined);
  const selectionCopyResetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const [selectionCopying, setSelectionCopying] = useState(false);
  const [selectionCopied, setSelectionCopied] = useState(false);
  const selectedReplyQuoteSnapshotRef = useRef<{
    messageId: string;
    quote: MessageReplyQuote;
  } | undefined>(undefined);
  const chatMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [messageListScrolling, setMessageListScrolling] = useState(false);
  const [historyScrollbarSettling, setHistoryScrollbarSettling] = useState(false);
  const performanceTraceId = chat && scrollRequest?.chatId === chat.id
    ? scrollRequest.performanceTraceId
    : undefined;

  useEffect(() => () => {
    if (selectionCopyResetTimerRef.current !== undefined) {
      globalThis.clearTimeout(selectionCopyResetTimerRef.current);
    }
  }, []);

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
        : chat?.kind === "channel"
          ? displayMessages
              .filter((message) => message.isChannelPost === true ||
                message.content.kind === "service" || message.content.kind === "unsupported")
              .map((message) => message.mediaAlbumId
                ? { ...message, mediaAlbumId: undefined }
                : message)
          : displayMessages;
      return source;
    },
    [allPinnedMessages, chat?.kind, displayMessages, pinnedViewOpen],
  );
  const renderedMessagesRef = useRef(renderedMessages);
  renderedMessagesRef.current = renderedMessages;
  const renderedMessageIndexes = useMemo(
    () => new Map(renderedMessages.map((message, index) => [message.id, index])),
    [renderedMessages],
  );
  const localBlockGroupByMessageId = useMemo(
    () => localBlockedMessageGroups(
      renderedMessages,
      localBlockedUserIds,
      !pinnedViewOpen,
    ),
    [localBlockedUserIds, pinnedViewOpen, renderedMessages],
  );
  const revealLocalBlockedMessage = useCallback((messageId: string) => {
    seenRevealedMessagesRef.current.add(messageId);
    setRevealedLocalBlockMessages((current) => current.has(messageId)
      ? current
      : new Set([...current, messageId]));
  }, []);
  const revealLocalBlockedGroup = useCallback((groupId: string) => {
    seenRevealedGroupsRef.current.add(groupId);
    setRevealedLocalBlockGroups((current) => current.has(groupId)
      ? current
      : new Set([...current, groupId]));
  }, []);

  useEffect(() => {
    setRevealedLocalBlockMessages(new Set());
    setRevealedLocalBlockGroups(new Set());
    seenRevealedMessagesRef.current.clear();
    seenRevealedGroupsRef.current.clear();
  }, [conversationIdentity, localBlockedUserIds, pinnedViewOpen]);

  useEffect(() => {
    if (
      scrollRequest?.kind !== "message" ||
      scrollRequest.revealLocallyBlocked !== true ||
      handledLocalBlockRevealRequestRef.current === scrollRequest.requestId ||
      !localBlockGroupByMessageId.has(scrollRequest.messageId)
    ) return;
    handledLocalBlockRevealRequestRef.current = scrollRequest.requestId;
    setRevealedLocalBlockMessages((current) => current.has(scrollRequest.messageId)
      ? current
      : new Set([...current, scrollRequest.messageId]));
  }, [localBlockGroupByMessageId, scrollRequest]);
  const attentionMessageIdsToObserve = useMemo(() => {
    if (pinnedViewOpen) return EMPTY_ATTENTION_MESSAGE_IDS;
    const messageIds = new Set(attentionMessageIds);
    for (const message of renderedMessages) {
      if (message.containsUnreadMention || message.containsUnreadReaction) messageIds.add(message.id);
    }
    return [...messageIds];
  }, [attentionMessageIds, pinnedViewOpen, renderedMessages]);
  const focusComposer = useCallback(() => {
    globalThis.setTimeout(() => composerInputRef.current?.focus(), 0);
  }, []);

  const messageProjection = useMemo(() => {
    const startedAt = performance.now();
    const blocks = virtualizeMessageTimeline(
      renderedMessages,
      pinnedViewOpen ? [] : sponsoredMessages,
      { messagesBetween: sponsoredMessagesBetween },
      undefined,
      chat?.kind !== "channel",
    );
    return { blocks, durationMs: performance.now() - startedAt };
  }, [chat?.kind, pinnedViewOpen, renderedMessages, sponsoredMessages, sponsoredMessagesBetween]);
  const visibleMessageBlocks = messageProjection.blocks;
  const messageItemIndexes = useMemo(
    () => indexMessagesByVirtualBlock(visibleMessageBlocks),
    [visibleMessageBlocks],
  );
  const discussionViewerMessages = useMemo(() => {
    if (!discussionPost) return [];
    const renderedPost = storedMessages.get(discussionPost.chatId)?.find(
      (message) => message.id === discussionPost.id,
    ) ?? discussionPost;
    return channelDiscussionProjection(renderedPost, storedMessages)?.comments ?? [];
  }, [discussionPost, storedMessages]);
  const viewerPhotos = useMemo(() => {
    const source = pinnedViewOpen
      ? allPinnedMessages
      : [...displayMessages, ...discussionViewerMessages];
    const uniqueMessages = new Map<string, Message>();
    for (const message of source) {
      uniqueMessages.set(`${message.chatId}:${message.id}`, message);
    }
    return photoMessages([...uniqueMessages.values()]);
  }, [allPinnedMessages, discussionViewerMessages, displayMessages, pinnedViewOpen]);
  const openMediaViewer = useCallback((messageId: string, chatId?: string) => {
    const activeIndex = viewerPhotos.findIndex((message) =>
      message.id === messageId && (!chatId || message.chatId === chatId),
    );
    if (activeIndex < 0) return;
    const activeContent = viewerPhotos[activeIndex].content;
    const nearbyPhotos = photoThumbnailWindow(viewerPhotos, messageId);
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
    }, onDownloadFile, onSaveFileToDownloads, () => {
      globalThis.setTimeout(() => composerInputRef.current?.focus({ preventScroll: true }), 0);
    });
    if (
      activeContent.fileId !== undefined &&
      activeContent.canDownload !== false &&
      !activeContent.isDownloading &&
      !activeContent.isDownloaded
    ) {
      void onDownloadFile(activeContent.fileId, activeContent.fileName);
    }
  }, [cacheFile, colorTheme, onDownloadFile, onSaveFileToDownloads, viewerPhotos]);

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
    const timer = globalThis.setTimeout(
      () => setHistoryScrollbarSettling(false),
      motionLifecycleTiming.historyScrollbarSettle,
    );
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

  const forwardTargetsById = useMemo(
    () => new Map(forwardTargets.map((target) => [target.id, target])),
    [forwardTargets],
  );
  const messagesById = useMemo(() => new Map(
    [...displayMessages, ...allPinnedMessages, ...renderedMessages].map((message) => [message.id, message]),
  ), [allPinnedMessages, displayMessages, renderedMessages]);
  const messagesByIdRef = useRef(messagesById);
  messagesByIdRef.current = messagesById;
  const attentionMessagesById = useMemo(() => new Map(
    (chat ? storedMessages.get(chat.id) ?? [] : []).map((message) => [message.id, message]),
  ), [chat, storedMessages]);
  const hasPrimaryAttention = useMemo(() => attentionMessageIds.some((messageId) => {
    const message = attentionMessagesById.get(messageId);
    if (!message || message.containsUnreadMention) return Boolean(message);
    const reply = message.replyTo?.kind === "message" ? message.replyTo : undefined;
    if (!reply) return false;
    return reply.outgoing === true || Boolean(
      reply.messageId && storedMessages.get(reply.chatId ?? message.chatId)
        ?.some((candidate) => candidate.id === reply.messageId && candidate.outgoing),
    );
  }), [attentionMessageIds, attentionMessagesById, storedMessages]);
  const replyPreviewForMessage = useCallback((message: Message) => {
    if (!chat) return undefined;
    const preview = replyPreviewFor(
      message,
      messagesById,
      users,
      chat,
      forwardTargetsById,
      currentUserId,
    );
    if (!preview) return undefined;
    const repliedSenderId = replySenderId(message, messagesById);
    const blockedReplyUser = localBlockedUsersById.get(repliedSenderId ?? "");
    return blockedReplyUser
      ? {
          ...preview,
          author: blockedReplyUser.alias,
          concealed: true,
        }
      : {
          ...preview,
          isAdministrator: Boolean(repliedSenderId && memberLabels.has(repliedSenderId)),
        };
  }, [chat, currentUserId, forwardTargetsById, localBlockedUsersById, memberLabels, messagesById, users]);
  const audioPlaybackNeighborsByMessage = useMemo(() => {
    const audioMessages = renderedMessages.filter((message) =>
      message.content.kind === "media" && ["audio", "voice"].includes(message.content.mediaType)
    );
    return new Map(audioMessages.map((message, index) => [message.id, {
      previousId: index > 0
        ? `${audioMessages[index - 1].chatId}:${audioMessages[index - 1].id}`
        : undefined,
      nextId: index < audioMessages.length - 1
        ? `${audioMessages[index + 1].chatId}:${audioMessages[index + 1].id}`
        : undefined,
    }]));
  }, [renderedMessages]);
  const audioTrackQueue = useMemo<AudioTrackDescriptor[]>(() => renderedMessages.flatMap((message) => {
    const content = message.content;
    if (content.kind !== "media" || !["audio", "voice"].includes(content.mediaType)) return [];
    const neighbors = audioPlaybackNeighborsByMessage.get(message.id);
    const canDownload = content.fileId !== undefined &&
      content.canDownload !== false &&
      !content.isDownloaded &&
      !content.isDownloading;
    const canCancelDownload = content.fileId !== undefined && content.isDownloading === true;
    return [{
      id: `${message.chatId}:${message.id}`,
      label: content.fileName,
      source: localMediaSource(content.localPath),
      fileId: content.fileId,
      size: content.size,
      mimeType: content.mimeType,
      durationHint: content.duration,
      previousId: neighbors?.previousId,
      nextId: neighbors?.nextId,
      downloadProgress: content.progress,
      onRequestStream: onStreamFile,
      onSuspendStream: content.fileId !== undefined
        ? () => { void onSuspendFileStream(content.fileId!); }
        : undefined,
      onDownload: canDownload && content.fileId !== undefined
        ? () => { void onDownloadFile(content.fileId!, content.fileName); }
        : undefined,
      onCancelDownload: canCancelDownload && content.fileId !== undefined
        ? () => { void onCancelFileDownload(content.fileId!); }
        : undefined,
    }];
  }), [
    audioPlaybackNeighborsByMessage,
    onCancelFileDownload,
    onDownloadFile,
    onStreamFile,
    onSuspendFileStream,
    renderedMessages,
  ]);

  useEffect(() => {
    audioPlaybackController.registerTracks(audioTrackQueue);
  }, [audioTrackQueue]);

  const getForwardTargetsSnapshot = useCallback(
    () => sortChatsByConversationActivity(
      forwardTargets,
      activeAccountId,
      getConversationActivityRecords(),
    ),
    [activeAccountId, forwardTargets],
  );

  const forwarding = useMessageForwarding({
    chatId: chat?.id,
    conversationIdentity,
    messages: renderedMessages,
    messagesById,
    targets: forwardTargets,
    getTargetsSnapshot: getForwardTargetsSnapshot,
    onLoadMessageProperties,
    onForwardMessages,
  });
  const {
    selectedIds: selectedMessageIds,
    loadingIds: selectionLoadingIds,
    selectionMode,
    dialogOpen: forwardDialogOpen,
    forwardMessageIds,
    initialTargetId: initialForwardTargetId,
    query: forwardQuery,
    pending: forwardPending,
    pendingTargetId: forwardPendingTargetId,
    filteredTargets: filteredForwardTargets,
    selectMessages,
    clearSelection,
  } = forwarding;
  const selectMessagesRef = useRef(selectMessages);
  selectMessagesRef.current = selectMessages;
  const pinnedBannerVisible = !pinnedViewOpen && !selectionMode &&
    (chat?.kind === "group" || chat?.kind === "channel") &&
    allPinnedMessages.length > 0;
  const hideDateIndicator = useCallback(() => {
    if (dateIndicatorFrameRef.current !== undefined) {
      cancelAnimationFrame(dateIndicatorFrameRef.current);
      dateIndicatorFrameRef.current = undefined;
    }
    if (dateIndicatorHideTimerRef.current !== undefined) {
      globalThis.clearTimeout(dateIndicatorHideTimerRef.current);
      dateIndicatorHideTimerRef.current = undefined;
    }
    setDateIndicatorVisible(false);
  }, []);
  const handleConversationUserScroll = useCallback(({
    element,
    direction,
    atBottom,
  }: {
    element: HTMLDivElement;
    direction: "up" | "down";
    atBottom: boolean;
  }) => {
    if (pinnedViewOpen || direction !== "up" || atBottom) {
      hideDateIndicator();
      return;
    }
    if (dateIndicatorFrameRef.current !== undefined) return;
    dateIndicatorFrameRef.current = requestAnimationFrame(() => {
      dateIndicatorFrameRef.current = undefined;
      const listBounds = element.getBoundingClientRect();
      const firstVisible = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .filter((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
        })
        .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
      const message = firstVisible?.dataset.messageId
        ? messagesById.get(firstVisible.dataset.messageId)
        : undefined;
      if (!message) {
        setDateIndicatorVisible(false);
        return;
      }
      setVisibleMessageDay(formatMessageDay(message.sentAt));
      setDateIndicatorVisible(true);
      if (dateIndicatorHideTimerRef.current !== undefined) {
        globalThis.clearTimeout(dateIndicatorHideTimerRef.current);
      }
      dateIndicatorHideTimerRef.current = globalThis.setTimeout(() => {
        dateIndicatorHideTimerRef.current = undefined;
        setDateIndicatorVisible(false);
      }, motionLifecycleTiming.transientIndicatorHold);
    });
  }, [hideDateIndicator, messagesById, pinnedViewOpen]);
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
    virtuosoFirstItemIndex,
    restoreStateFrom,
    highlightedMessageId,
    newMessageNotice,
    awayFromLatest,
    jumpHistoryCount,
    rememberJumpOrigin,
    returnFromJump,
    jumpToLatest,
    pinFollowingMessageMount,
    appendMountMessageId,
    collapseExpandedQuote,
    reconcileBottomViewport,
    onTotalListHeightChanged,
    onInitialRangeChanged,
    onInitialAtBottomStateChange,
    messageListHandlers,
  } = useConversationScroll({
    scope: pinnedViewOpen ? `${scrollScope}:pinned` : scrollScope,
    chatId: chat?.id,
    request: pinnedViewOpen ? undefined : scrollRequest,
    visibleMessages: renderedMessages,
    messageItemIndexes,
    virtualItemCount: visibleMessageBlocks.length,
    search: pinnedViewOpen ? "" : "",
    historyLoading: pinnedViewOpen ? false : historyLoading,
    hasOlderMessages: pinnedViewOpen ? false : hasOlderMessages,
    messageCount: pinnedViewOpen ? renderedMessages.length : messages.length,
    onLoadOlder: pinnedViewOpen ? async () => undefined : onLoadOlder,
    onUserScroll: handleConversationUserScroll,
  });
  const messageTargetHighlightRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const highlight = messageTargetHighlightRef.current;
    const list = messageListElement;
    if (!highlight || !list || !highlightedMessageId) return;
    const shell = list.closest<HTMLElement>(".message-list-shell");
    const target = [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => row.dataset.messageId === highlightedMessageId);
    if (!shell || !target) return;

    let measurementFrame: number | undefined;
    const measure = () => {
      measurementFrame = undefined;
      if (!target.isConnected || !list.contains(target)) {
        highlight.style.visibility = "hidden";
        return;
      }
      const shellBounds = shell.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      highlight.style.left = `${listBounds.left - shellBounds.left}px`;
      highlight.style.top = `${targetBounds.top - shellBounds.top - MESSAGE_TARGET_HIGHLIGHT_INSET_PX}px`;
      highlight.style.width = `${listBounds.width}px`;
      highlight.style.height = `${targetBounds.height + MESSAGE_TARGET_HIGHLIGHT_INSET_PX * 2}px`;
      highlight.style.visibility = "visible";
    };
    const scheduleMeasurement = () => {
      if (measurementFrame !== undefined) return;
      measurementFrame = requestAnimationFrame(measure);
    };
    measure();
    list.addEventListener("scroll", scheduleMeasurement, { passive: true });
    const content = list.querySelector<HTMLElement>(".message-list-content");
    const stopObservingTarget = observeLayout(target, scheduleMeasurement);
    const stopObservingList = observeLayout(list, scheduleMeasurement);
    const stopObservingContent = content
      ? observeLayout(content, scheduleMeasurement)
      : undefined;
    return () => {
      list.removeEventListener("scroll", scheduleMeasurement);
      stopObservingTarget();
      stopObservingList();
      stopObservingContent?.();
      if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame);
    };
  }, [highlightedMessageId, messageListElement, virtuosoKey]);
  const showPinnedLoading = useStableVisibility(
    pinnedViewOpen && pinnedMessagesLoading && allPinnedMessages.length === 0,
  );
  const showHistoryLoading = useStableVisibility(!pinnedViewOpen && historyLoading, {
    minimumVisible: 220,
  });
  useEffect(() => {
    setVisibleMessageDay(undefined);
    hideDateIndicator();
    return hideDateIndicator;
  }, [chat?.id, hideDateIndicator, pinnedViewOpen]);
  useEffect(() => {
    if (!messageListElement) return;
    let frame: number | undefined;
    const resetRevealsOutsideViewport = () => {
      frame = undefined;
      if (messageListElement.classList.contains("is-jump-transitioning")) {
        scheduleReset();
        return;
      }
      const rootBounds = messageListElement.getBoundingClientRect();
      const visibleMessageIds = new Set<string>();
      const visibleGroupIds = new Set<string>();
      for (const row of messageListElement.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom <= rootBounds.top + 1 || bounds.top >= rootBounds.bottom - 1) continue;
        if (row.dataset.messageId) visibleMessageIds.add(row.dataset.messageId);
        if (row.dataset.localBlockGroup) visibleGroupIds.add(row.dataset.localBlockGroup);
      }
      setRevealedLocalBlockMessages((current) => {
        let changed = false;
        const next = new Set(current);
        for (const messageId of current) {
          if (visibleMessageIds.has(messageId)) {
            seenRevealedMessagesRef.current.add(messageId);
          } else if (seenRevealedMessagesRef.current.has(messageId)) {
            next.delete(messageId);
            seenRevealedMessagesRef.current.delete(messageId);
            changed = true;
          }
        }
        return changed ? next : current;
      });
      setRevealedLocalBlockGroups((current) => {
        let changed = false;
        const next = new Set(current);
        for (const groupId of current) {
          if (visibleGroupIds.has(groupId)) {
            seenRevealedGroupsRef.current.add(groupId);
          } else if (seenRevealedGroupsRef.current.has(groupId)) {
            next.delete(groupId);
            seenRevealedGroupsRef.current.delete(groupId);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    };
    const scheduleReset = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(resetRevealsOutsideViewport);
    };
    scheduleReset();
    messageListElement.addEventListener("scroll", scheduleReset, { passive: true });
    globalThis.addEventListener("resize", scheduleReset);
    const mutationObserver = new MutationObserver(scheduleReset);
    mutationObserver.observe(messageListElement, { childList: true, subtree: true });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      messageListElement.removeEventListener("scroll", scheduleReset);
      globalThis.removeEventListener("resize", scheduleReset);
      mutationObserver.disconnect();
    };
  }, [messageListElement, revealedLocalBlockGroups, revealedLocalBlockMessages]);
  useEffect(() => {
    if (!messageListElement) return;
    const hideAtBottom = () => {
      const distance = messageListElement.scrollHeight -
        messageListElement.clientHeight - messageListElement.scrollTop;
      if (distance <= 1) hideDateIndicator();
    };
    hideAtBottom();
    messageListElement.addEventListener("scroll", hideAtBottom, { passive: true });
    return () => messageListElement.removeEventListener("scroll", hideAtBottom);
  }, [hideDateIndicator, messageListElement]);
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
    rememberJumpOrigin(messageId);
    onOpenMessage(chatId, messageId, { behavior: "smooth", highlight: true });
  }, [onOpenMessage, rememberJumpOrigin]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (
      pinnedViewOpen || !chat || !messageListElement ||
      !conversation || attentionMessageIdsToObserve.length === 0
    ) return;
    const attentionIds = new Set(attentionMessageIdsToObserve);
    const visibleIds = new Set<string>();
    const observedRows = new Set<Element>();
    const consumeVisibleAttention = () => {
      if (
        !document.hasFocus() ||
        document.visibilityState !== "visible" ||
        !conversation.contains(document.activeElement)
      ) return;
      const visibleAttentionIds = [...visibleIds]
        .filter((messageId) => attentionIds.has(messageId));
      if (visibleAttentionIds.length > 0) {
        dismissMessageAttention(chat.id, visibleAttentionIds);
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
    attentionMessageIdsToObserve,
    chat,
    dismissMessageAttention,
    messageListElement,
    pinnedViewOpen,
  ]);
  const actionMessage = actionMenu
    ? messagesById.get(actionMenu.messageId)
    : undefined;
  const actionAlbumMessageIds = actionMessage
    ? mediaAlbumMessagesFor(renderedMessages, actionMessage).map((message) => message.id)
    : [];
  const preservePositioningFrame = Boolean(
    !pinnedViewOpen &&
    renderedMessages.length > 0 &&
    messageListRef.current?.dataset.conversationVirtuosoKey === virtuosoKey &&
    Boolean(messageListRef.current?.querySelector("[data-message-id]")) &&
    (
      scrollRequest?.chatId === chat?.id
    )
  );
  const showPositioning = useStableVisibility(
    !pinnedViewOpen && positioning && renderedMessages.length === 0 && !preservePositioningFrame,
  );

  useLayoutEffect(() => {
    if (!conversationIdentity || pinnedViewOpen || positioning) return;
    onViewportReady?.(conversationIdentity);
  }, [conversationIdentity, onViewportReady, pinnedViewOpen, positioning]);

  const sendMessageAndFollowLatest = useCallback(async (
    text: string,
    replyToMessageId?: string,
    selectedReplyQuote?: MessageReplyQuote,
    entities?: MessageTextEntity[],
    disableNotification?: boolean,
  ) => {
    jumpToLatest("auto");
    return onSendMessage(text, replyToMessageId, selectedReplyQuote, entities, disableNotification);
  }, [jumpToLatest, onSendMessage]);

  const sendFilesAndFollowLatest = useCallback(async (
    attachments: import("../telegram/types").OutgoingAttachment[],
    caption?: string,
    captionEntities?: MessageTextEntity[],
    replyToMessageId?: string,
    selectedReplyQuote?: MessageReplyQuote,
    disableNotification?: boolean,
  ) => {
    jumpToLatest("auto");
    return onSendFiles(
      attachments,
      caption,
      captionEntities,
      replyToMessageId,
      selectedReplyQuote,
      disableNotification,
    );
  }, [jumpToLatest, onSendFiles]);

  useEffect(() => {
    const selectionSurface = (node: Node | null) => node instanceof Element
      ? node.closest<HTMLElement>(".message-rich-text")
      : node?.parentElement?.closest<HTMLElement>(".message-rich-text");
    const selectedMessageSurface = (selection: Selection | null) => {
      if (!selection || selection.isCollapsed) return undefined;
      const anchorSurface = selectionSurface(selection.anchorNode);
      const focusSurface = selectionSurface(selection.focusNode);
      return anchorSurface && anchorSurface === focusSurface &&
        conversationRef.current?.contains(anchorSurface)
        ? anchorSurface
        : undefined;
    };
    const clearSelectionSurface = () => {
      conversationRef.current?.classList.remove("is-message-text-selecting");
      selectionMessageRef.current?.classList.remove("is-selection-origin");
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (selectionMode) {
        clearSelectionSurface();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const surface = target?.closest<HTMLElement>(".message-rich-text") ?? null;
      const selection = globalThis.getSelection();
      const selectedSurface = selectedMessageSurface(selection);
      if (selectedSurface && selectedSurface !== surface) selection?.removeAllRanges();
      clearSelectionSurface();
      selectedReplyQuoteSnapshotRef.current = undefined;
      selectionMessageRef.current = surface && conversationRef.current?.contains(surface)
        ? surface
        : null;
      if (selectionMessageRef.current) {
        conversationRef.current?.classList.add("is-message-text-selecting");
        selectionMessageRef.current.classList.add("is-selection-origin");
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      const boundary = selectionMessageRef.current;
      if (!boundary || (event.buttons & 1) === 0) return;
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const target = event.target instanceof Node ? event.target : null;
      if (target && (target === boundary || boundary.contains(target))) return;
      const selection = globalThis.getSelection();
      if (!selection || selection.isCollapsed) return;
      event.preventDefault();
      clampSelectionToMessageText(selection, boundary, selectionPointerRef.current, true);
    };
    const onSelectionChange = () => {
      const selection = globalThis.getSelection();
      const selectedSurface = selectedMessageSurface(selection);
      const boundary = selectedSurface ?? selectionMessageRef.current;
      if (!selection || selection.isCollapsed || !boundary || selectionClampActiveRef.current) return;
      selectionMessageRef.current = boundary;
      selectionClampActiveRef.current = true;
      try {
        clampSelectionToMessageText(selection, boundary, selectionPointerRef.current);
      } finally {
        selectionClampActiveRef.current = false;
      }
      const messageElement = boundary.closest<HTMLElement>("[data-message-id], [data-caption-message-id]");
      const messageId = messageElement?.dataset.messageId ?? messageElement?.dataset.captionMessageId;
      const message = messageId ? messagesByIdRef.current.get(messageId) : undefined;
      const sourceText = message?.content.kind === "text"
        ? message.content.text
        : message?.content.kind === "media" || message?.content.kind === "file"
          ? message.content.caption
          : undefined;
      const sourceEntities = message?.content.kind === "text"
        ? message.content.entities
        : message?.content.kind === "media" || message?.content.kind === "file"
          ? message.content.captionEntities
          : undefined;
      const quote = sourceText
        ? replyQuoteFromSelection(selection, boundary, sourceText, sourceEntities)
        : undefined;
      if (messageId && quote) selectedReplyQuoteSnapshotRef.current = { messageId, quote };
    };
    const onPointerUp = () => {
      // Keep the origin's selectable surface while a native Range is still
      // active. Removing the class synchronously at pointerup changes
      // user-select on the subtree and can make Chromium clear a valid drag
      // selection, especially for a single-line message.
      if (globalThis.getSelection()?.isCollapsed !== false) clearSelectionSurface();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", clearSelectionSurface, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", clearSelectionSurface, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      clearSelectionSurface();
      selectionMessageRef.current = null;
      selectionPointerRef.current = undefined;
    };
  }, [selectionMode]);

  useEffect(() => {
    if (!selectionMode || pinnedViewOpen || !messageListElement) return;
    const list = messageListElement;
    const drag = selectionDragRef;
    const findMessageIndex = (target: EventTarget | null) => {
      const element = target instanceof Element
        ? target.closest<HTMLElement>("[data-message-id]")
        : null;
      const id = element?.dataset.messageId;
      if (!id) return undefined;
      const message = messagesByIdRef.current.get(id);
      if (!message || message.content.kind === "service" || message.content.kind === "unsupported") return undefined;
      const index = renderedMessagesRef.current.findIndex((candidate) => candidate.id === id);
      return index >= 0 ? index : undefined;
    };
    const selectBetween = (index: number) => {
      const anchor = drag.current;
      if (!anchor) return;
      const start = Math.min(anchor.anchorIndex, index);
      const end = Math.max(anchor.anchorIndex, index);
      void selectMessagesRef.current(renderedMessagesRef.current.slice(start, end + 1));
    };
    const updateFromPoint = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y);
      const index = findMessageIndex(target);
      if (index !== undefined) selectBetween(index);
    };
    const stopAutoScroll = () => {
      if (selectionAutoScrollFrameRef.current !== undefined) {
        cancelAnimationFrame(selectionAutoScrollFrameRef.current);
        selectionAutoScrollFrameRef.current = undefined;
      }
    };
    const scheduleAutoScroll = () => {
      if (selectionAutoScrollFrameRef.current !== undefined) return;
      const tick = () => {
        selectionAutoScrollFrameRef.current = undefined;
        const active = drag.current;
        if (!active) return;
        const bounds = list.getBoundingClientRect();
        const outsideTop = Math.max(0, bounds.top - active.lastY);
        const outsideBottom = Math.max(0, active.lastY - bounds.bottom);
        const distance = Math.max(outsideTop, outsideBottom);
        if (distance <= 0) return;
        const direction = outsideTop > 0 ? -1 : 1;
        const speed = Math.min(28, Math.max(2, distance * 0.28));
        list.scrollTop += direction * speed;
        updateFromPoint(active.lastX, Math.min(bounds.bottom - 2, Math.max(bounds.top + 2, active.lastY)));
        selectionAutoScrollFrameRef.current = requestAnimationFrame(tick);
      };
      selectionAutoScrollFrameRef.current = requestAnimationFrame(tick);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      const index = findMessageIndex(event.target);
      if (index === undefined) return;
      const element = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-message-id]")
        : null;
      if (element?.closest("button, a, input, textarea, select, video, audio, [role='button']")) return;
      drag.current = {
        anchorIndex: index,
        pointerId: event.pointerId,
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId || (event.buttons & 1) === 0) return;
      active.lastX = event.clientX;
      active.lastY = event.clientY;
      active.moved = active.moved || Math.hypot(
        event.clientX - active.startX,
        event.clientY - active.startY,
      ) > 3;
      if (active.moved) event.preventDefault();
      if (!active.moved) return;
      const index = findMessageIndex(event.target);
      if (index !== undefined) selectBetween(index);
      scheduleAutoScroll();
    };
    const onPointerUp = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (active.moved) {
        suppressSelectionClickRef.current = true;
      }
      drag.current = undefined;
      stopAutoScroll();
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressSelectionClickRef.current) return;
      suppressSelectionClickRef.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("click", onClick, true);
    return () => {
      drag.current = undefined;
      suppressSelectionClickRef.current = false;
      stopAutoScroll();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [messageListElement, pinnedViewOpen, selectionMode]);

  useLayoutEffect(() => {
    if (
      !chat ||
      pinnedViewOpen ||
      positioning ||
      historyLoading ||
      selectionMode
    ) return;
    const selection = globalThis.getSelection();
    if (selection && !selection.isCollapsed) return;
    const active = document.activeElement;
    if (active === composerInputRef.current) return;
    const activeChatRow = active instanceof Element && Boolean(active.closest(".chat-row"));
    if (active && active !== document.body && active !== document.documentElement &&
      active !== composerInputRef.current &&
      (!activeChatRow || window.matchMedia("(forced-colors: active)").matches)) return;
    composerInputRef.current?.focus({ preventScroll: true });
  }, [conversationIdentity, historyLoading, pinnedViewOpen, positioning, selectionMode]);

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
    setActionForwardTargets([]);
    setActionLoadingId(undefined);
    setComposerTextInsertion(undefined);
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    selectedReplyQuoteSnapshotRef.current = undefined;
    setEditingMessage(undefined);
    setDeleteTarget(undefined);
    setDeletePending(false);
    setDiscussionPost(undefined);
  }, [conversationIdentity]);

  useEffect(() => {
    if (editingMessage) return;
    const replyToMessageId = draftReplyToMessageId;
    if (!replyToMessageId) {
      setReplyingTo(undefined);
      setReplyQuote(undefined);
      return;
    }
    const target = messagesById.get(replyToMessageId);
    if (target) {
      // Once a reply is opened locally, its selected quote is authoritative.
      // TDLib may echo a draft without the quote while it is normalizing it;
      // replacing the local quote with that echo makes the composer fall back
      // to the complete source message and sends a whole-message reply.
      if (replyingTo?.id !== target.id) {
        setReplyingTo(target);
        setReplyQuote(draftReplyQuote);
      }
    }
  }, [conversationIdentity, draftReplyQuote, draftReplyToMessageId, editingMessage, messagesById, replyingTo?.id]);

  useEffect(() => {
    if (actionMenu && !messagesById.has(actionMenu.messageId)) setActionMenu(undefined);
    if (replyingTo && !messagesById.has(replyingTo.id)) {
      setReplyingTo(undefined);
      setReplyQuote(undefined);
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

  const openChannelDiscussion = useCallback((post: Message) => {
    if (!channelDiscussionAvailable(post)) return;
    setDiscussionPost(post);
    const threadKey = `${post.chatId}:${post.id}`;
    const cachedDiscussion = channelDiscussionProjection(post, storedMessagesRef.current);
    setDiscussionThreads((current) => {
      const previous = current[threadKey];
      return {
        ...current,
        [threadKey]: {
          loading: true,
          error: undefined,
          replyChatId: cachedDiscussion.replyChatId ?? previous?.replyChatId,
          replyMessageId: cachedDiscussion.replyMessageId ?? previous?.replyMessageId,
        },
      };
    });
    void loadMessageThreadHistory(
      post.chatId,
      post.id,
      Math.max(100, post.interaction?.replyCount ?? 0),
    ).then((thread) => {
      setDiscussionThreads((current) => {
        const previous = current[threadKey];
        if (!previous) return current;
        const root = thread?.find((message) =>
          message.id === post.id || (
            message.forwardInfo?.origin?.kind === "channel" &&
            message.forwardInfo.origin.chatId === post.chatId &&
            message.forwardInfo.origin.messageId === post.id
          )
        );
        const directReply = thread?.find((message) =>
          message.replyTo?.kind === "message" && message.replyTo.messageId
        );
        const directReplyTarget = directReply?.replyTo?.kind === "message"
          ? directReply.replyTo
          : undefined;
        const replyChatId = root?.chatId ?? directReplyTarget?.chatId ??
          directReply?.chatId ?? previous.replyChatId;
        const replyMessageId = root?.id ?? directReplyTarget?.messageId ?? previous.replyMessageId;
        return {
          ...current,
          [threadKey]: {
            loading: false,
            error: !thread,
            replyChatId,
            replyMessageId,
          },
        };
      });
    });
  }, [loadMessageThreadHistory]);

  useLayoutEffect(() => {
    if (!discussionPostId) {
      setDiscussionPost(undefined);
      return;
    }
    if (discussionPost?.id === discussionPostId) return;
    const post = chatMessagesRef.current.find((message) => message.id === discussionPostId);
    if (post) openChannelDiscussion(post);
  }, [discussionPost?.id, discussionPostId, openChannelDiscussion]);

  const repeatMessage = useCallback(async (message: Message) => {
    if (
      !chat ||
      chat.kind !== "group" ||
      topic?.isClosed === true ||
      message.outgoing ||
      message.permissions?.canForward !== true
    ) return;
    closeActionMenu(false);
    await onForwardMessages(chat.id, [message.id], chat.id, topic?.id);
  }, [chat, closeActionMenu, onForwardMessages, topic?.id]);

  const discussionThreadKey = discussionPost
    ? `${discussionPost.chatId}:${discussionPost.id}`
    : undefined;
  const discussionState = discussionThreadKey ? discussionThreads[discussionThreadKey] : undefined;
  const renderedDiscussionPost = discussionPost
    ? storedMessages.get(discussionPost.chatId)?.find((message) => message.id === discussionPost.id) ?? discussionPost
    : undefined;
  const renderedDiscussion = useMemo(
    () => renderedDiscussionPost
      ? channelDiscussionProjection(renderedDiscussionPost, storedMessages)
      : undefined,
    [renderedDiscussionPost, storedMessages],
  );
  const channelDiscussionComments = renderedDiscussion?.comments ?? [];

  if (!chat) {
    return (
      <section
        className="conversation empty-conversation"
        aria-hidden={mobileViewHidden ? true : undefined}
        inert={mobileViewHidden ? true : undefined}
      >
        <div className="conversation-empty-mark">N</div>
        <h2>{translate("选择一个对话")}</h2>
      </section>
    );
  }

  const isChannelConversation = chat.kind === "channel";
  const canPostChannel = isChannelConversation && chat.management?.status === "owner";
  const reloadChannelDiscussion = async (post: Message) => {
    openChannelDiscussion(post);
  };
  const sendDiscussionComment = async (
    text: string,
    replyToMessageId?: string,
    selectedReplyQuote?: MessageReplyQuote,
    entities?: MessageTextEntity[],
  ) => {
    const replyChatId = renderedDiscussion?.replyChatId ?? discussionState?.replyChatId;
    const replyMessageId = renderedDiscussion?.replyMessageId ?? discussionState?.replyMessageId;
    if (!discussionPost || !replyChatId || !replyMessageId) return false;
    const sent = await sendMessageToThread(
      replyChatId,
      replyToMessageId ?? replyMessageId,
      text,
      entities,
      selectedReplyQuote,
    );
    if (sent) await reloadChannelDiscussion(discussionPost);
    return sent;
  };
  const sendDiscussionFiles = async (
    attachments: import("../telegram/types").OutgoingAttachment[],
    caption?: string,
    captionEntities?: MessageTextEntity[],
    replyToMessageId?: string,
    selectedReplyQuote?: MessageReplyQuote,
  ) => {
    const replyChatId = renderedDiscussion?.replyChatId ?? discussionState?.replyChatId;
    const replyMessageId = renderedDiscussion?.replyMessageId ?? discussionState?.replyMessageId;
    if (!discussionPost || !replyChatId || !replyMessageId) return false;
    const sent = await sendFilesToThread(
      replyChatId,
      replyToMessageId ?? replyMessageId,
      attachments,
      caption,
      captionEntities,
      selectedReplyQuote,
    );
    if (sent) await reloadChannelDiscussion(discussionPost);
    return sent;
  };

  const composerContextTitle = editingMessage
    ? translate("编辑消息")
    : replyingTo
      ? translate("回复")
      : undefined;
  const composerContextSubject = replyingTo
    ? senderNameForMessage(replyingTo, users, chat, forwardTargetsById)
    : undefined;
  const composerContextSubjectIsAdministrator = Boolean(
    replyingTo &&
    !localBlockedUsersById.has(replyingTo.senderId) &&
    memberLabels.has(replyingTo.senderId),
  );
  const typingNames = typingUserIds.map((userId) =>
    localBlockedUsersById.get(userId)?.alias ?? users.get(userId)?.displayName ?? translate("成员")
  );
  const typingStatus = typingUserIds.length === 0 || chat.kind === "saved" || chat.kind === "channel"
    ? undefined
    : chat.kind === "direct"
      ? translate("正在输入...")
      : typingUserIds.length === 1
        ? translate("{{value0}} 正在输入...", { value0: typingNames[0] })
        : typingUserIds.length === 2
          ? translate("{{value0}} 正在输入...", { value0: typingNames.join("、") })
          : translate("{{value0}} 等 {{value1}} 人正在输入...", { value0: typingNames.slice(0, 2).join("、"), value1: typingUserIds.length });
  const headerStatus = conversationHeaderStatus({
    chat,
    peer: chat.peerId ? users.get(chat.peerId) : undefined,
    typingStatus: topic?.isClosed ? translate("话题已关闭") : typingStatus,
    memberCount: groupManagement?.chatId === chat.id
      ? groupManagement.memberCount ?? chat.memberCount
      : chat.memberCount,
  });

  const openActionMenu = useCallback(async (
    message: Message,
    left: number,
    top: number,
    returnFocus?: HTMLElement,
    capturedReplyQuote?: MessageReplyQuote,
    keyboardNavigation = false,
  ) => {
    const sourceText = message.content.kind === "text"
      ? message.content.text
      : message.content.kind === "media" || message.content.kind === "file"
        ? message.content.caption
        : undefined;
    const selection = globalThis.getSelection();
    const selectedSurface = sourceText && returnFocus
      ? [...returnFocus.querySelectorAll<HTMLElement>(".message-rich-text")]
          .find((surface) => {
            const anchor = selection?.anchorNode;
            const focus = selection?.focusNode;
            return Boolean(
              anchor && focus &&
              (anchor === surface || surface.contains(anchor)) &&
              (focus === surface || surface.contains(focus)),
            );
          })
      : undefined;
    const sourceEntities = message.content.kind === "text"
      ? message.content.entities
      : message.content.kind === "media" || message.content.kind === "file"
        ? message.content.captionEntities
        : undefined;
    const selectedReplyQuote = capturedReplyQuote ?? (sourceText && selectedSurface
      ? replyQuoteFromSelection(selection, selectedSurface, sourceText, sourceEntities)
      : undefined) ?? (selectedReplyQuoteSnapshotRef.current?.messageId === message.id
        ? selectedReplyQuoteSnapshotRef.current.quote
        : undefined);
    setActionForwardTargets(quickForwardChatsAt(
      forwardTargets,
      activeAccountId,
      getConversationActivityRecords(),
    ));
    setActionMenu({
      messageId: message.id,
      left,
      top,
      returnFocus,
      replyQuote: selectedReplyQuote,
      keyboardNavigation,
    });
    if (actionLoadingId === message.id) return;
    setActionLoadingId(message.id);
    await loadMessageActionPermissions({
      chatId: message.chatId,
      messageId: message.id,
      initialMessage: message,
      // Read Zustand directly here: a live TDLib update may have replaced the
      // message before React commits the render that updates messagesByIdRef.
      getCurrentMessage: () => telegramStore.getState().messages
        .get(message.chatId)
        ?.find((candidate) => candidate.id === message.id),
      load: onLoadMessageProperties,
    });
    setActionLoadingId((current) => current === message.id ? undefined : current);
  }, [actionLoadingId, activeAccountId, forwardTargets, onLoadMessageProperties]);

  const copyMessage = async (message: Message) => {
    try {
      await copyMessageContent(message);
      closeActionMenu(false);
    } catch {
      // Keep the menu open so the user can retry or download an unavailable image.
    }
  };

  const copySelectedMessages = useCallback(async () => {
    if (!chat || selectedMessageIds.size === 0 || selectionCopying) return;
    const ordered = renderedMessages.filter((message) => selectedMessageIds.has(message.id));
    if (ordered.length === 0) return;
    setSelectionCopying(true);
    try {
      const text = formatSelectedMessages(ordered, users, chat, forwardTargetsById, messagesById);
      await writeClipboardText(text);
      setSelectionCopied(true);
      if (selectionCopyResetTimerRef.current !== undefined) {
        globalThis.clearTimeout(selectionCopyResetTimerRef.current);
      }
      selectionCopyResetTimerRef.current = globalThis.setTimeout(() => {
        selectionCopyResetTimerRef.current = undefined;
        setSelectionCopied(false);
      }, 1600);
      clearSelection();
    } catch {
      setSelectionCopied(false);
    } finally {
      setSelectionCopying(false);
    }
  }, [chat, clearSelection, forwardTargetsById, messagesById, renderedMessages, selectedMessageIds, selectionCopying, users]);

  useEffect(() => {
    if (!selectionMode) return;
    const onCopyShortcut = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "c" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (selectedMessageIds.size === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void copySelectedMessages();
    };
    document.addEventListener("keydown", onCopyShortcut, true);
    return () => document.removeEventListener("keydown", onCopyShortcut, true);
  }, [copySelectedMessages, selectedMessageIds.size, selectionMode]);

  const cancelEditing = () => {
    setEditingMessage(undefined);
    focusComposer();
  };

  const cancelReply = () => {
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    const currentDraft = telegramStore.getState().drafts.get(topic ? `${chat.id}:topic:${topic.id}` : chat.id);
    if (currentDraft?.replyToMessageId) {
      onDraftChange(chat.id, currentDraft.text, undefined, undefined);
    }
    focusComposer();
  };

  const startReply = (message: Message, selectedReplyQuote?: MessageReplyQuote) => {
    if (editingMessage) {
      setEditingMessage(undefined);
    }
    // Persist the reply target immediately. Message updates can replace the
    // `messagesById` map before the composer debounce runs; without a draft
    // target the sync effect treats that update as a cancelled reply.
    const currentDraft = telegramStore.getState().drafts.get(
      topic ? `${chat.id}:topic:${topic.id}` : chat.id,
    );
    onDraftChange(chat.id, currentDraft?.text ?? "", message.id, selectedReplyQuote);
    setReplyingTo(message);
    setReplyQuote(selectedReplyQuote);
    setActionMenu(undefined);
    focusComposer();
  };

  const startEditing = (message: Message) => {
    if (!isEditableMessageContent(message.content)) return;
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    setEditingMessage(message);
    setActionMenu(undefined);
    focusComposer();
  };

  const confirmDelete = async (revoke: boolean) => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    const deleted = await onDeleteMessage(deleteTarget.id, revoke, deleteTarget.chatId);
    setDeletePending(false);
    if (deleted) setDeleteTarget(undefined);
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
    rememberJumpOrigin(messageId);
    onOpenMessage(chatId, messageId);
  };

  const confirmPin = async (disableNotification: boolean, onlyForSelf: boolean) => {
    if (!pinTarget || pinPending) return;
    setPinPending(true);
    const succeeded = await onPinMessage(pinTarget.id, disableNotification, onlyForSelf);
    setPinPending(false);
    if (succeeded) setPinTarget(undefined);
  };

  const openPinDialog = async (message: Message) => {
    if (pinPending) return;
    setActionMenu(undefined);
    setPinPending(true);
    const permissions = await onLoadMessageProperties(message.chatId, message.id, true);
    setPinPending(false);
    if (permissions?.canPin === true) {
      setPinTarget({ ...message, permissions });
    }
  };

  const unpinFromMenu = async (message: Message) => {
    if (pinnedUnpinId || pinPending) return;
    setActionMenu(undefined);
    setPinPending(true);
    const permissions = await onLoadMessageProperties(message.chatId, message.id, true);
    setPinPending(false);
    if (permissions?.canPin !== true) return;
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

  const openForwardDialog = (messageIds: Iterable<string>) => {
    if (editingMessage) {
      setEditingMessage(undefined);
    }
    setActionMenu(undefined);
    forwarding.openDialogForMessages(messageIds);
  };

  const toggleMessageSelection = forwarding.toggleSelection;
  const confirmForward = forwarding.confirm;

  return (
    <section
      ref={conversationRef}
      className={`conversation ${isChannelConversation ? "is-channel-conversation" : ""} ${topic && !selectionMode && !pinnedViewOpen ? "has-forum-topic-strip" : ""} ${selectionMode ? "is-selecting-messages" : ""} ${pinnedViewOpen ? "is-pinned-messages-view" : ""}`}
      aria-hidden={mobileViewHidden ? true : undefined}
      inert={mobileViewHidden ? true : undefined}
      onPointerUp={(event) => {
        if (event.button !== 0 || selectionMode || pinnedViewOpen) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
        const selection = globalThis.getSelection();
        if (selection && !selection.isCollapsed) return;
        composerInputRef.current?.focus({ preventScroll: true });
      }}
      aria-label={translate("{{value0}} 对话", {
        value0: topic ? translate("{{value0}} 话题", { value0: topic.name }) : chat.title,
      })}
    >
      <header className={`conversation-header ${selectionMode ? "is-selection-header" : ""}`}>
        {selectionMode ? (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label={translate("取消选择")}
              title={translate("取消选择")}
              onClick={forwarding.clearSelection}
            >
              <X size={20} strokeWidth={2} />
            </button>
            <div className="message-selection-title">
              <strong>{translate("已选择 {{value0}} 条", { value0: selectedMessageIds.size })}</strong>
              <span>{translate("最多可同时转发 100 条消息")}</span>
            </div>
            <div className="conversation-actions">
              <button
                ref={chatMenuButtonRef}
                className={`icon-button ${chatMenuOpen ? "is-active" : ""}`}
                type="button"
                aria-label={translate("更多操作")}
                title={translate("更多操作")}
                aria-haspopup="menu"
                aria-expanded={chatMenuOpen}
                disabled={chatManagementPending}
                onClick={() => setChatMenuOpen((open) => !open)}
              >
                <MoreVertical size={20} strokeWidth={1.8} />
              </button>
              <MotionPresence present={chatMenuOpen} variant="popover">
                {chatMenuOpen ? (
                  <ChatActionMenu
                    chat={chat}
                    chatListId={chatListId}
                    pending={chatManagementPending}
                    canSetAutoDelete={chat.kind === "direct" || chat.management?.canChangeInfo === true}
                    onSetPinned={onSetChatPinned}
                    onSetMuted={onSetChatMuted}
                    onSetArchived={onSetChatArchived}
                    onOpenPinned={() => {
                      forwarding.clearSelection();
                      openPinnedMessages();
                    }}
                    onOpenMessageSearch={() => {
                      forwarding.clearSelection();
                      onOpenMessageSearch();
                    }}
                    onStartSelection={() => forwarding.startSelection()}
                    onOpenAutoDelete={() => {
                      setChatMenuOpen(false);
                      forwarding.clearSelection();
                      setAutoDeleteDialogOpen(true);
                    }}
                    onClose={() => closeChatMenu(true)}
                  />
                ) : null}
              </MotionPresence>
            </div>
          </>
        ) : pinnedViewOpen ? (
          <>
            <button
              className="icon-button pinned-messages-back"
              type="button"
              aria-label={translate("返回会话")}
              title={translate("返回会话")}
              onClick={closePinnedMessages}
            >
              <ChevronLeft size={21} strokeWidth={2} />
            </button>
            <span className="pinned-view-heading-icon" aria-hidden="true">
              <Pin size={18} strokeWidth={1.9} />
            </span>
            <div className="pinned-view-title">
              <strong>{translate("置顶消息")}</strong>
              <span>{pinnedMessagesLoading ? translate("正在读取") : translate("{{value0}} 条消息", { value0: allPinnedMessages.length })}</span>
            </div>
          </>
        ) : (
          <>
            {!topic && (
              <button
                className="mobile-back icon-button"
                type="button"
                aria-label={translate("返回会话列表")}
                title={translate("返回会话列表")}
                onClick={onBack}
              >
                <ChevronLeft size={21} strokeWidth={2} />
              </button>
            )}
            <button
              className="conversation-profile-trigger"
              type="button"
              aria-label={translate("查看 {{value0}} 资料", { value0: chat.title })}
              title={translate("查看资料")}
              onClick={onOpenProfile}
            >
              <span className="conversation-title">
                <strong>{chat.title}</strong>
                <span className={`conversation-header-status ${typingStatus || topic?.isClosed ? "is-typing" : ""}`} role={typingStatus || topic?.isClosed ? "status" : undefined}>
                  {headerStatus}
                </span>
              </span>
            </button>
            <div className="conversation-actions">
              <button
                ref={chatMenuButtonRef}
                className={`icon-button ${chatMenuOpen ? "is-active" : ""}`}
                type="button"
                aria-label={translate("更多操作")}
                title={translate("更多操作")}
                aria-haspopup="menu"
                aria-expanded={chatMenuOpen}
                disabled={chatManagementPending}
                onClick={() => setChatMenuOpen((open) => !open)}
              >
                <MoreVertical size={20} strokeWidth={1.8} />
              </button>
              <MotionPresence present={chatMenuOpen} variant="popover">
                {chatMenuOpen ? (
                  <ChatActionMenu
                    chat={chat}
                    chatListId={chatListId}
                    pending={chatManagementPending}
                    canSetAutoDelete={chat.kind === "direct" || chat.management?.canChangeInfo === true}
                    onSetPinned={onSetChatPinned}
                    onSetMuted={onSetChatMuted}
                    onSetArchived={onSetChatArchived}
                    onOpenPinned={() => openPinnedMessages()}
                    onOpenMessageSearch={() => onOpenMessageSearch()}
                    onStartSelection={() => forwarding.startSelection()}
                    onOpenAutoDelete={() => {
                      setChatMenuOpen(false);
                      setAutoDeleteDialogOpen(true);
                    }}
                    onClose={() => closeChatMenu(true)}
                  />
                ) : null}
              </MotionPresence>
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
        <MotionPresence present={showPinnedLoading} variant="status">
          {showPinnedLoading ? <div className="pinned-messages-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>{translate("正在读取置顶消息")}</span>
          </div> : null}
        </MotionPresence>
        <MotionPresence present={showPositioning} variant="status">
          {showPositioning ? <div
            className={`message-positioning-placeholder ${renderedMessages.length > 0 ? "is-warm" : ""}`}
            role="status"
          >
            <LoaderCircle className="spin" size={18} />
            <span>{translate("正在加载消息")}</span>
          </div> : null}
        </MotionPresence>
        <MotionPresence present={showHistoryLoading} variant="status">
          {showHistoryLoading ? <div className="history-loading" aria-label={translate("正在加载更早消息")}>
            <LoaderCircle className="spin" size={16} />
          </div> : null}
        </MotionPresence>
        {!pinnedViewOpen && visibleMessageDay && (
          <div
            className={`conversation-date-indicator ${dateIndicatorVisible ? "is-visible" : ""}`}
            aria-hidden="true"
          >
            {visibleMessageDay}
          </div>
        )}
        {highlightedMessageId && (
          <div
            key={highlightedMessageId}
            ref={messageTargetHighlightRef}
            className="message-target-highlight"
            data-highlight-message-id={highlightedMessageId}
            aria-hidden="true"
          />
        )}
        <Virtuoso
          key={virtuosoKey}
          className={`message-list ${messageListScrolling ? "is-scrolling" : ""} ${!pinnedViewOpen && (historyLoading || historyScrollbarSettling) ? "is-history-adjusting" : ""}`}
          ref={virtuosoRef}
          scrollerRef={setMessageListRef}
          isScrolling={setMessageListScrolling}
          role="log"
          aria-label={pinnedViewOpen ? translate("置顶消息列表") : translate("消息列表")}
          aria-busy={
            positioning ||
            (pinnedViewOpen && pinnedMessagesLoading) ||
            (!pinnedViewOpen && historyLoading)
          }
          tabIndex={0}
          alignToBottom={initialAlignToBottom}
          firstItemIndex={virtuosoFirstItemIndex}
          components={pinnedViewOpen ? pinnedMessageListComponents : messageListComponents}
          computeItemKey={(_, block) => block.id}
          data={visibleMessageBlocks}
          defaultItemHeight={52}
          rangeChanged={onInitialRangeChanged}
          atBottomThreshold={0}
          atBottomStateChange={onInitialAtBottomStateChange}
          initialTopMostItemIndex={restoreStateFrom ? undefined : initialTopMostItemIndex}
          restoreStateFrom={restoreStateFrom}
          totalListHeightChanged={onTotalListHeightChanged}
          increaseViewportBy={MESSAGE_VIEWPORT_PREFETCH}
          minOverscanItemCount={{ top: 2, bottom: 2 }}
          {...messageListHandlers}
          itemContent={(_, groupModel) => {
            if (groupModel.sponsoredMessage) {
              const sponsored = groupModel.sponsoredMessage;
              return (
                <SponsoredMessageCard
                  message={sponsored}
                  onClick={() => {
                    void onClickSponsoredMessage?.(chat?.id ?? sponsored.chatId, sponsored.id, false);
                  }}
                />
              );
            }
            const { firstMessage, messages: messageGroup, positions, startsNewDay } = groupModel;
            const reserveSenderAvatar = !isChannelConversation && firstMessage.content.kind !== "service" &&
              firstMessage.content.kind !== "unsupported" &&
              !firstMessage.outgoing && chat.kind !== "direct";
            const showSenderAvatar = reserveSenderAvatar && !groupModel.continuesAfter &&
              messageGroup.some((message) => !message.isRemoving);
            const sender = users.get(firstMessage.senderId);
            const senderChat = senderChatId(firstMessage.senderId);
            const senderChatDetails = senderChat ? forwardTargetsById.get(senderChat) : undefined;
            const realSenderName = sender?.displayName ??
              senderChatDetails?.title ??
              (chat.kind === "direct" ? chat.title : translate("Telegram 用户"));
            const realSenderAvatar = sender?.avatar ??
              senderChatDetails?.avatar ??
              (chat.kind === "direct" ? chat.avatar : undefined);
            const localBlockedUser = localBlockedUsersById.get(firstMessage.senderId);
            const localBlockGroup = localBlockGroupByMessageId.get(firstMessage.id);
            const localBlockGroupRevealed = Boolean(
              localBlockGroup && revealedLocalBlockGroups.has(localBlockGroup.id)
            );
            const senderName = localBlockedUser && !localBlockGroupRevealed
              ? localBlockedUser.alias
              : realSenderName;
            const senderAvatar = localBlockedUser && !localBlockGroupRevealed
              ? localBlockedUser.aliasAvatar
              : realSenderAvatar;
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
                        className={`message-sender-avatar ${localBlockedUser && !localBlockGroupRevealed
                          ? "is-local-block-alias"
                          : ""}`}
                        type="button"
                        aria-label={localBlockedUser && !localBlockGroupRevealed
                          ? translate("显示 {{value0}} 的连续消息和真实身份", { value0: localBlockedUser.alias })
                          : translate("查看 {{value0}} 资料", { value0: senderName })}
                        title={localBlockedUser && !localBlockGroupRevealed
                          ? translate("临时显示这个消息组")
                          : translate("查看资料")}
                        onClick={() => {
                          if (localBlockedUser && localBlockGroup && !localBlockGroupRevealed) {
                            revealLocalBlockedGroup(localBlockGroup.id);
                            return;
                          }
                          onOpenSenderProfile(firstMessage.senderId);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (localBlockedUser && !localBlockGroupRevealed) return;
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
                          if (localBlockedUser && !localBlockGroupRevealed) return;
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
                      const gateEntranceAtBottom = message.id === appendMountMessageId || Boolean(
                        entrance && message.id === renderedMessages.at(-1)?.id,
                      );
                      const forwardSource = forwardSourceFor(message, users, forwardTargetsById);
                      const forwardNavigation = forwardSource?.navigation;
                      const blockedUser = localBlockedUsersById.get(message.senderId);
                      const blockedGroup = localBlockGroupByMessageId.get(message.id);
                      const blockedGroupRevealed = Boolean(
                        blockedGroup && revealedLocalBlockGroups.has(blockedGroup.id)
                      );
                      const locallyConcealed = Boolean(
                        blockedUser &&
                        !blockedGroupRevealed &&
                        !revealedLocalBlockMessages.has(message.id)
                      );
                      const displayedForwardLabel = locallyConcealed && forwardSource?.label
                        ? translate("转发自 受限来源")
                        : forwardSource?.label;
                      const displayedSenderName = blockedUser && !blockedGroupRevealed
                        ? blockedUser.alias
                        : senderName;
                      const senderIsAdministrator = (!blockedUser || blockedGroupRevealed) &&
                        memberLabels.has(message.senderId);
                      const messageIndex = renderedMessageIndexes.get(message.id) ?? -1;
                      const previousMessage = renderedMessages[messageIndex - 1];
                      const selected = selectedMessageIds.has(message.id);
                      const selectionPending = selectionLoadingIds.has(message.id);
                      const selectionHighlighted = selected || selectionPending;
                      const joinsSelectionBefore = selectionHighlighted && Boolean(
                        previousMessage &&
                        localDateKey(previousMessage.sentAt) === localDateKey(message.sentAt) &&
                        (selectedMessageIds.has(previousMessage.id) || selectionLoadingIds.has(previousMessage.id)),
                      );
                      const isChannelPost = isChannelConversation && message.isChannelPost === true;
                      const bubble = <RichMessageBubble
                        key={message.renderKey ?? message.id}
                        message={message}
                        entrance={entrance}
                        senderName={isChannelConversation ? chat.title : displayedSenderName}
                        senderLabel={blockedUser && !blockedGroupRevealed
                          ? undefined
                          : message.senderTag || memberLabels.get(message.senderId)}
                        senderIsAdministrator={senderIsAdministrator}
                        senderProfileAvailable={
                          !message.outgoing &&
                          message.senderId !== "unknown" &&
                          (!blockedUser || blockedGroupRevealed)
                        }
                        channelAuthor={channelAuthorFor(message)}
                        showChannelMetadata={displaysChannelMetadata(message)}
                        channelPost={isChannelPost}
                        channelDiscussionAction={!selectionMode && !pinnedViewOpen && channelDiscussionAvailable(message) ? (
                          <button
                            className="channel-post-discussion"
                            type="button"
                            aria-label={message.interaction?.replyCount
                              ? translate("{{value0}} 条评论", { value0: message.interaction.replyCount })
                              : translate("查看留言")}
                            onClick={() => {
                              openChannelDiscussion(message);
                              onOpenDiscussion(message.id);
                            }}
                          >
                            <MessageCircle size={16} strokeWidth={2} aria-hidden="true" />
                            <span>{message.interaction?.replyCount
                              ? translate("{{value0}}条评论", { value0: message.interaction.replyCount })
                              : translate("留言")}</span>
                            <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />
                          </button>
                        ) : undefined}
                        serviceMembers={message.content.kind === "service"
                          ? message.content.memberUserIds?.map((userId) => {
                              const blockedMember = localBlockedUsersById.get(userId);
                              return {
                                id: userId,
                                name: blockedMember?.alias ?? users.get(userId)?.displayName ?? translate("Telegram 用户"),
                                profileAvailable: !blockedMember && users.has(userId),
                              };
                            })
                          : undefined}
                        groupPosition={positions.get(message.id) ?? "single"}
                        replyPreview={replyPreviewForMessage(message)}
                        forwardLabel={displayedForwardLabel}
                        onOpenForwardSource={!selectionMode && !locallyConcealed && forwardNavigation ? () => {
                          if (forwardNavigation.kind === "message") {
                            openMessageInHistory(forwardNavigation.chatId, forwardNavigation.messageId);
                          } else if (forwardNavigation.kind === "chat") {
                            onOpenChat(forwardNavigation.chatId);
                          } else {
                            onOpenSenderProfile(forwardNavigation.userId);
                          }
                        } : undefined}
                        selectionMode={selectionMode}
                        selected={selected}
                        highlighted={highlightedMessageId === message.id}
                        selectionPending={selectionPending}
                        joinsSelectionBefore={joinsSelectionBefore}
                        selectionLimitReached={selectedMessageIds.size >= 100}
                        onToggleSelection={toggleMessageSelection}
                        onOpenActions={openActionMenu}
                        onLoadRawMessage={onLoadRawMessage}
                        onDownload={onDownloadFile}
                        onCancelDownload={onCancelFileDownload}
                        onRecoverFile={onRecoverFile}
                        onOpenFile={onOpenFile}
                        onSaveFileAs={onSaveFileAs}
                        onOpenDownloadDirectory={onOpenDownloadDirectory}
                        onStream={onStreamFile}
                        onSuspendStream={onSuspendFileStream}
                        onRetry={onRetryMessage}
                        onCancelUpload={onCancelFileUpload}
                        onReaction={onSetMessageReaction}
                        onLoadReactionSenders={onGetMessageReactionSenders}
                        onPollAnswer={onSetPollAnswer}
                        onBotCallback={onBotCallback}
                        onCollapseQuote={collapseExpandedQuote}
                        onMount={gateEntranceAtBottom
                          ? pinFollowingMessageMount
                          : undefined}
                        deferUntilPinned={gateEntranceAtBottom}
                        previousAudioPlaybackId={audioPlaybackNeighborsByMessage.get(message.id)?.previousId}
                        nextAudioPlaybackId={audioPlaybackNeighborsByMessage.get(message.id)?.nextId}
                        onOpenReply={openMessageInHistory}
                        onOpenSenderProfile={onOpenSenderProfile}
                        users={users}
                        senderChats={forwardTargetsById}
                        onOpenMention={onOpenMention}
                        onSearchHashtag={onSearchHashtag}
                        onOpenMedia={selectionMode ? undefined : openMediaViewer}
                        onOpenStickerSet={selectionMode ? undefined : onOpenStickerSet}
                        cornerAction={!selectionMode && pinnedViewOpen ? (
                          <MessageSourceLocateButton
                            message={message}
                            onLocate={openMessageInHistory}
                          />
                        ) : undefined}
                        albumItem={albumItem}
                        autoplayAnimations={autoplayAnimations}
                        autoDownloadPolicy={autoDownloadPolicy}
                        locallyConcealed={locallyConcealed}
                        localBlockGroupId={blockedGroup?.id}
                        blockedReactionSenderIds={localBlockedReactionUserIds}
                        onRevealLocallyBlocked={blockedUser
                          ? () => revealLocalBlockedMessage(message.id)
                          : undefined}
                      />;
                      return bubble;
                    };
                    if (segment.kind === "message") return renderBubble(segment.message);

                    const albumReply = segment.messages.map(replyPreviewForMessage).find(Boolean);
                    const albumRows = layoutMediaAlbum(segment.messages);
                    const captionMessage = mediaAlbumCaptionMessage(segment.messages);
                    const captionBlock = captionMessage && localBlockGroupByMessageId.get(captionMessage.id);
                    const captionConcealed = captionMessage && localBlockedUsersById.has(captionMessage.senderId) &&
                      !(captionBlock && revealedLocalBlockGroups.has(captionBlock.id)) &&
                      !revealedLocalBlockMessages.has(captionMessage.id);
                    const albumCaption = captionMessage && !captionConcealed ? (
                      <div
                        className="media-album-caption"
                        data-caption-message-id={captionMessage.id}
                        tabIndex={0}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          void openActionMenu(captionMessage, event.clientX, event.clientY, event.currentTarget);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                          event.preventDefault();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          void openActionMenu(captionMessage, bounds.left, bounds.top, event.currentTarget, undefined, true);
                        }}
                      >
                        <MessageRichText
                          text={captionMessage.content.caption!}
                          entities={captionMessage.content.captionEntities}
                          onOpenMention={onOpenMention}
                          onSearchHashtag={onSearchHashtag}
                          onCollapseQuote={(collapse, pointerY, anchor) =>
                            collapseExpandedQuote(captionMessage.id, collapse, pointerY, anchor)}
                        />
                      </div>
                    ) : null;
                    return (
                      <div
                        className={`media-album ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"}`}
                        data-media-album-id={segment.albumId}
                        key={`album:${segment.albumId}:${segment.messages[0]?.renderKey ?? segment.messages[0]?.id}`}
                        role="group"
                        aria-label={translate("{{value0}} 项媒体相册", { value0: segment.messages.length })}
                      >
                        {albumReply && (
                          <button
                            className={`message-reply-preview media-album-reply ${albumReply.isCurrentUser ? "is-current-user" : ""} ${albumReply.concealed ? "is-local-block-concealed" : ""}`}
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
                        {captionMessage?.content.showCaptionAboveMedia ? albumCaption : null}
                        <div
                          className="media-album-grid"
                          data-count={segment.messages.length}
                          data-row-count={albumRows.length}
                        >
                          {albumRows.map((row, rowIndex) => (
                            <div
                              className="media-album-row"
                              data-row-index={rowIndex}
                              key={`row:${row.items[0]?.message.id ?? rowIndex}`}
                              style={{
                                "--media-album-row-ratio": row.aspectRatio,
                              } as CSSProperties}
                            >
                              {row.items.map((item) => (
                                <div
                                  className="media-album-tile"
                                  key={item.message.renderKey ?? item.message.id}
                                  style={{
                                    "--media-album-tile-weight": item.weight,
                                  } as CSSProperties}
                                >
                                  {renderBubble(item.message, true)}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                        {!captionMessage?.content.showCaptionAboveMedia ? albumCaption : null}
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
            className={`conversation-jump-button jump-to-attention ${!hasPrimaryAttention ? "has-reaction" : ""} ${awayFromLatest || jumpHistoryCount > 0 ? "is-stacked" : ""}`}
            type="button"
            aria-label={translate("{{value0}}，{{value1}} 条待查看", {
              value0: hasPrimaryAttention ? translate("跳到提及或引用") : translate("跳到回应"),
              value1: attentionMessageIds.length,
            })}
            title={hasPrimaryAttention ? translate("跳到提及或引用") : translate("跳到回应")}
            onClick={() => {
              const messageId = attentionMessageIds.at(-1);
              if (chat && messageId) {
                onOpenMessage(chat.id, messageId, {
                  behavior: "smooth",
                  highlight: true,
                  loadContext: true,
                });
              }
            }}
          >
            {hasPrimaryAttention ? <AtSign size={19} strokeWidth={2.1} /> : <Heart size={18} strokeWidth={2.1} />}
            <span>{formatUnreadCount(attentionMessageIds.length)}</span>
          </button>
        )}
        {!pinnedViewOpen && currentScrollKey && (jumpHistoryCount > 0 || awayFromLatest) && (
            <button
              className="conversation-jump-button jump-to-latest"
              type="button"
              aria-label={jumpHistoryCount > 0
                ? translate("返回跳转前位置，可回退 {{value0}} 次", { value0: jumpHistoryCount })
                : newMessageNotice?.key === currentScrollKey && newMessageNotice.count > 0
                  ? translate("跳到最新消息，{{value0}} 条新消息", { value0: newMessageNotice.count })
                  : translate("跳到最新消息")}
              title={jumpHistoryCount > 0 ? translate("返回跳转前位置") : translate("跳到最新消息")}
              onClick={() => {
                if (jumpHistoryCount === 0 || !returnFromJump()) {
                  jumpToLatest("smooth", true);
                }
              }}
            >
              <ArrowDown size={19} strokeWidth={2.1} />
              {newMessageNotice?.key === currentScrollKey && newMessageNotice.count > 0 && (
                <span>{formatUnreadCount(newMessageNotice.count)}</span>
              )}
            </button>
          )}
      </div>

      {discussionPost && renderedDiscussionPost && isChannelConversation && (
        <ChannelDiscussionPanel
          post={renderedDiscussionPost}
          channel={chat}
          comments={channelDiscussionComments}
          users={users}
          mentionUsers={mentionableUsers}
          knownNonBotUsernames={knownNonBotUsernames}
          forwardTargets={forwardTargets}
          forumTopics={forumTopics}
          currentUserId={currentUserId ?? "self"}
          connectionStatus={connectionStatus}
          loading={(discussionState?.loading ?? false) && !renderedDiscussion?.cached}
          loadError={!renderedDiscussion?.cached && discussionState?.error}
          onRetry={() => openChannelDiscussion(discussionPost)}
          onClose={onCloseDiscussion}
          onSend={sendDiscussionComment}
          onSendFiles={sendDiscussionFiles}
          onEditMessage={onEditMessage}
          onDeleteMessage={onDeleteMessage}
          onForwardMessages={onForwardMessages}
          onLoadMessageProperties={onLoadMessageProperties}
          onLoadForumTopics={onLoadForumTopics}
          onTypingChange={onTypingChange}
          onOpenMessage={onOpenMessage}
          onOpenChat={onOpenChat}
          onOpenSenderProfile={onOpenSenderProfile}
          onOpenMention={onOpenMention}
          onSearchHashtag={onSearchHashtag}
          onOpenMessageSearch={onOpenMessageSearch}
          onStartPrivateChat={onStartPrivateChat}
          onGetReportOptions={onGetReportOptions}
          onReportChat={onReportChat}
          onPinMessage={onPinMessage}
          onUnpinMessage={onUnpinMessage}
          messagePreviewOptions={{
            autoplayAnimations,
            autoDownloadPolicy,
            onLoadRawMessage,
            onDownload: onDownloadFile,
            onCancelDownload: onCancelFileDownload,
            onRecoverFile,
            onOpenFile,
            onSaveFileAs,
            onOpenDownloadDirectory,
            onStream: onStreamFile,
            onSuspendStream: onSuspendFileStream,
            onRetry: onRetryMessage,
            onCancelUpload: onCancelFileUpload,
            onReaction: onSetMessageReaction,
            onLoadReactionSenders: onGetMessageReactionSenders,
            onPollAnswer: onSetPollAnswer,
            onBotCallback,
            onOpenMedia: openMediaViewer,
            onOpenStickerSet,
            blockedReactionSenderIds: localBlockedReactionUserIds,
          }}
        />
      )}

      {actionMenu && actionMessage && (
        <MessageActionMenu
          position={actionMenu}
          message={actionMessage}
          loading={actionLoadingId === actionMessage.id}
          keyboardNavigation={actionMenu.keyboardNavigation}
          onReply={() => startReply(actionMessage, actionMenu.replyQuote)}
          onEdit={() => startEditing(actionMessage)}
          onForward={() => openForwardDialog([actionMessage.id])}
          forwardTargets={actionForwardTargets}
          onQuickForward={(target) => {
            closeActionMenu(false);
            void forwarding.quickForward([actionMessage.id], target);
          }}
          onForwardAlbum={actionAlbumMessageIds.length > 1
            ? () => openForwardDialog(actionAlbumMessageIds)
            : undefined}
          onQuickForwardAlbum={actionAlbumMessageIds.length > 1
            ? (target) => {
                closeActionMenu(false);
                void forwarding.quickForward(actionAlbumMessageIds, target);
              }
            : undefined}
          onRepeat={chat.kind === "group" && topic?.isClosed !== true && !actionMessage.outgoing
            ? () => void repeatMessage(actionMessage)
            : undefined}
          onDelete={() => {
            setDeleteTarget(actionMessage);
            setActionMenu(undefined);
          }}
          onPin={actionMessage.permissions?.canPin ? () => { void openPinDialog(actionMessage); } : undefined}
          onUnpin={actionMessage.permissions?.canPin ? () => { void unpinFromMenu(actionMessage); } : undefined}
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
          onSelect={() => {
            forwarding.startSelection(actionMessage);
            setActionMenu(undefined);
          }}
          onReport={() => { setReportTarget(actionMessage); setActionMenu(undefined); }}
          onDismiss={() => closeActionMenu(false)}
          onClose={() => closeActionMenu(true)}
        />
      )}

      {senderMenu && (
        <SenderActionMenu
          position={senderMenu}
          senderName={senderMenu.senderName}
          onMention={!senderMenu.senderId.startsWith("chat:") && senderMenu.senderId !== "unknown"
            ? () => {
                const sender = users.get(senderMenu.senderId);
                if (!sender) return;
                composerTextInsertionIdRef.current += 1;
                setComposerTextInsertion({
                  id: `${sender.id}:${composerTextInsertionIdRef.current}`,
                  text: mentionTextForUser(sender),
                  draftKey: conversationIdentity ?? chat.id,
                  userId: sender.id,
                });
              }
            : undefined}
          onPrivateChat={!senderMenu.senderId.startsWith("chat:") && senderMenu.senderId !== "unknown"
            ? () => onStartPrivateChat(senderMenu.senderId)
            : undefined}
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
        <div className="message-selection-bar" role="toolbar" aria-label={translate("消息选择操作")}>
          <span>{selectedMessageIds.size > 0 ? translate("复制或转发所选消息") : translate("点击或拖动选择消息")}</span>
          <div className="message-selection-actions">
            <button
              className={`icon-button ${selectionCopied ? "is-confirmed" : ""}`}
              type="button"
              aria-label={translate("复制已选消息")}
              title={selectionCopied ? translate("已复制") : translate("复制文本")}
              disabled={selectedMessageIds.size === 0 || selectionCopying}
              onClick={() => void copySelectedMessages()}
            >
              {selectionCopied ? <Check size={18} strokeWidth={2.2} /> : <Copy size={18} strokeWidth={1.9} />}
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={translate("转发已选消息")}
              title={translate("转发")}
              disabled={selectedMessageIds.size === 0}
              onClick={forwarding.openSelectedDialog}
            >
              <Forward size={19} strokeWidth={1.9} />
            </button>
          </div>
        </div>
      ) : botStartPending ? (
        <div className="bot-start-bar">
          <button
            className="bot-start-button"
            type="button"
            aria-label={translate("启动机器人")}
            title={translate("启动机器人")}
            disabled={botStartSending || (connectionStatus !== "online" && connectionStatus !== "syncing")}
            onClick={() => void onConfirmBotStart()}
          >
            {botStartSending
              ? <LoaderCircle className="spin" size={18} strokeWidth={1.9} />
              : <Play size={17} strokeWidth={2} fill="currentColor" />}
            <span>{botStartSending ? translate("正在启动") : translate("开始")}</span>
          </button>
        </div>
      ) : (!isChannelConversation || canPostChannel) ? (
      <ConversationComposer
        key={topic ? `${chat.id}:${topic.id}` : chat.id}
        chatId={chat.id}
        draftKey={topic ? `${chat.id}:topic:${topic.id}` : chat.id}
        editingMessage={editingMessage}
        replyingTo={replyingTo}
        replyQuote={replyQuote}
        contextTitle={composerContextTitle}
        contextSubject={composerContextSubject}
        contextSubjectIsAdministrator={composerContextSubjectIsAdministrator}
        defaultBotUsername={chat.kind === "direct" && chat.peerId && users.get(chat.peerId)?.isBot
          ? users.get(chat.peerId)?.username
          : undefined}
        users={users}
        textInsertion={composerTextInsertion}
        knownNonBotUsernames={knownNonBotUsernames}
        mentionsEnabled={chat.kind === "group"}
        mentionUsers={mentionUsers}
        recentMentionUserIds={recentMentionUserIds}
        onTextInsertionApplied={consumeComposerTextInsertion}
        onGeometryChange={reconcileBottomViewport}
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
        enableSilentSending={canPostChannel}
      />
      ) : null}

      <MotionPresence present={Boolean(deleteTarget)}>
        {deleteTarget?.permissions ? <DeleteMessagesDialog
          count={1}
          preview={messageSummary(deleteTarget.content)}
          canDeleteOnlyForSelf={deleteTarget.permissions.canDeleteOnlyForSelf}
          canDeleteForAllUsers={deleteTarget.permissions.canDeleteForAllUsers}
          pending={deletePending}
          onConfirm={(revoke) => void confirmDelete(revoke)}
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

      <MotionPresence present={Boolean(forwardDialogOpen && forwardMessageIds.length > 0)}>
        {forwardDialogOpen && forwardMessageIds.length > 0 ? <ForwardMessagesDialog
          selectedCount={forwardMessageIds.length}
          targets={filteredForwardTargets}
          topicsByChat={forumTopics}
          currentChatId={chat.id}
          initialTargetId={initialForwardTargetId}
          query={forwardQuery}
          pending={forwardPending}
          pendingTargetId={forwardPendingTargetId}
          onQueryChange={forwarding.setQuery}
          onLoadTopics={onLoadForumTopics}
          onConfirm={(targets, description) => void confirmForward(targets, description)}
          onClose={forwarding.closeDialog}
        /> : null}
      </MotionPresence>
    </section>
  );
}
