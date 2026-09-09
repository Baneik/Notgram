import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { translate } from "../i18n";
import { useTranslation } from "react-i18next";
import {
  Check,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Forward,
  Image as ImageIcon,
  LoaderCircle,
  Save,
  X,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useVisibleFile } from "../hooks/useVisibleFile";
import type {
  Chat,
  Message,
  MessageReactionSenderPage,
  MessageReactionType,
  MessageReplyQuote,
  User,
} from "../telegram/types";
import { MessageMetadata } from "./MessageMetadata";
import { fitMediaLayout } from "../utils/mediaLayout";
import { isGroupFirst, type MessageGroupPosition } from "../utils/messageGrouping";
import { TgsSticker } from "./TgsSticker";
import { StickerPlaceholder } from "./StickerPlaceholder";
import { AutoplayVideo } from "./AutoplayVideo";
import { StableImage } from "./StableImage";
import { VideoPlayer } from "./VideoPlayer";
import { MessageRichText } from "./MessageRichText";
import { RichMessageContent } from "./RichMessageContent";
import { highlightedText } from "../utils/textHighlight";
import { AudioPlayer } from "./AudioPlayer";
import {
  nextVisibleMediaFileId,
  shouldAutoDownload,
  type AutoDownloadPolicy,
} from "../media/autoDownload";
import {
  consumeMessageEntrance,
  MESSAGE_ENTRANCE_LIFETIME_MS,
  type MessageEntrance,
} from "../utils/messageEntrance";
import { isLargeEmojiText } from "../utils/largeEmoji";
import { replyQuoteFromSelection } from "../utils/messageTextSelection";
import { MediaProgressRing } from "./MediaProgressRing";
import { PollMessage } from "./PollMessage";
import { InlineKeyboard } from "./InlineKeyboard";
import type { CallbackQueryAnswer } from "../telegram/types";
import { formatFileSize, isExecutableFile } from "../utils/fileTransfer";
import { localMediaSource } from "../media/localMediaSource";
import { observeLayout } from "../utils/layoutObservation";
import { MediaSpoiler } from "./Spoiler";
import { MessageReactions } from "./MessageReactions";
import { writeClipboardText } from "../utils/clipboard";
import { usePreferencesStore } from "../store/preferencesStore";
import { visibleMessageReactions } from "../utils/localBlockedReactions";

const MEDIA_PREFETCH_ROOT_MARGIN = "1200px 0px 360px 0px";
const INLINE_META_LOWERING_PX = 2.5;

export interface ReplyPreview {
  author: string;
  text: string;
  chatId?: string;
  messageId?: string;
  isCurrentUser?: boolean;
  isAdministrator?: boolean;
  concealed?: boolean;
}

export interface MessageBubbleProps {
  message: Message;
  entrance?: MessageEntrance;
  senderName: string;
  senderLabel?: string;
  senderIsAdministrator?: boolean;
  senderProfileAvailable: boolean;
  channelAuthor?: string;
  showChannelMetadata?: boolean;
  channelPost?: boolean;
  channelDiscussionAction?: ReactNode;
  serviceMembers?: Array<{ id: string; name: string; profileAvailable: boolean }>;
  groupPosition: MessageGroupPosition;
  replyPreview?: ReplyPreview;
  forwardLabel?: string;
  onOpenForwardSource?: () => void;
  selectionMode: boolean;
  selected: boolean;
  highlighted: boolean;
  searchQuery?: string;
  selectionPending: boolean;
  joinsSelectionBefore: boolean;
  selectionLimitReached: boolean;
  onToggleSelection: (message: Message) => Promise<void>;
  onOpenActions: (
    message: Message,
    left: number,
    top: number,
    returnFocus?: HTMLElement,
    replyQuote?: MessageReplyQuote,
    keyboardNavigation?: boolean,
  ) => Promise<void>;
  onLoadRawMessage: (chatId: string, messageId: string) => Promise<string | undefined>;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onCancelDownload: (fileId: number) => Promise<void>;
  onRecoverFile: (fileId: number, priority?: number) => Promise<boolean>;
  onOpenFile: (sourcePath: string, fileId?: number) => Promise<boolean>;
  onSaveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  onOpenDownloadDirectory: () => Promise<void>;
  onStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number) => Promise<void>;
  onRetry: (messageId: string, chatId?: string) => Promise<void>;
  onCancelUpload: (messageId: string, chatId?: string) => Promise<void>;
  onReaction: (messageId: string, emoji: string, chosen: boolean, chatId?: string) => Promise<void>;
  onLoadReactionSenders: (
    messageId: string,
    type: MessageReactionType,
    offset?: string,
    chatId?: string,
  ) => Promise<MessageReactionSenderPage>;
  onPollAnswer: (messageId: string, optionPositions: number[], chatId?: string) => Promise<boolean>;
  onBotCallback: (messageId: string, data: string, chatId?: string) => Promise<CallbackQueryAnswer | undefined>;
  onCollapseQuote: (
    messageId: string,
    collapse: () => void,
    pointerClientY: number,
    getCollapsedAnchor: () => Element | null,
  ) => void;
  onMount?: (onPinned?: () => void) => boolean;
  deferUntilPinned?: boolean;
  previousAudioPlaybackId?: string;
  nextAudioPlaybackId?: string;
  onOpenReply: (chatId: string, messageId: string) => void;
  onOpenSenderProfile: (senderId: string) => void;
  users: ReadonlyMap<string, User>;
  senderChats: ReadonlyMap<string, Chat>;
  onOpenMention: (username?: string, userId?: string) => void;
  onSearchHashtag: (hashtag: string) => void;
  onOpenMedia?: (messageId: string, chatId?: string) => void;
  onOpenStickerSet?: (stickerSetId: string) => void;
  cornerAction?: ReactNode;
  albumItem?: boolean;
  autoplayAnimations: boolean;
  autoDownloadPolicy: AutoDownloadPolicy;
  locallyConcealed?: boolean;
  localBlockGroupId?: string;
  onRevealLocallyBlocked?: () => void;
  blockedReactionSenderIds?: ReadonlySet<string>;
}

function MessageBubbleComponent({
  message,
  entrance,
  senderName,
  senderLabel,
  senderIsAdministrator = false,
  senderProfileAvailable,
  channelAuthor,
  showChannelMetadata = false,
  channelPost = false,
  channelDiscussionAction,
  serviceMembers,
  groupPosition,
  replyPreview,
  forwardLabel,
  onOpenForwardSource,
  selectionMode,
  selected,
  highlighted,
  searchQuery,
  selectionPending,
  joinsSelectionBefore,
  selectionLimitReached,
  onToggleSelection,
  onOpenActions,
  onLoadRawMessage,
  onDownload,
  onCancelDownload,
  onRecoverFile,
  onOpenFile,
  onSaveFileAs,
  onOpenDownloadDirectory,
  onStream,
  onSuspendStream,
  onRetry,
  onCancelUpload,
  onReaction,
  onLoadReactionSenders,
  onPollAnswer,
  onBotCallback,
  onCollapseQuote,
  onMount,
  deferUntilPinned = false,
  previousAudioPlaybackId,
  nextAudioPlaybackId,
  onOpenReply,
  onOpenSenderProfile,
  users,
  senderChats,
  onOpenMention,
  onSearchHashtag,
  onOpenMedia,
  onOpenStickerSet,
  cornerAction,
  albumItem = false,
  autoplayAnimations,
  autoDownloadPolicy,
  locallyConcealed = false,
  localBlockGroupId,
  onRevealLocallyBlocked,
  blockedReactionSenderIds = new Set(),
}: MessageBubbleProps) {
  useTranslation();
  const entranceKindRef = useRef<MessageEntrance | undefined>(undefined);
  const entranceCleanupRef = useRef<(() => void) | undefined>(undefined);
  const rowRef = useRef<HTMLElement | null>(null);
  const [failedMediaSources, setFailedMediaSources] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const attemptedMediaRecoveryRef = useRef(new Set<string>());
  const [readyStickerSource, setReadyStickerSource] = useState<string>();
  const contextReplyQuoteRef = useRef<MessageReplyQuote | undefined>(undefined);
  const [measuredMedia, setMeasuredMedia] = useState<{
    source: string;
    width: number;
    height: number;
  }>();

  const textFlowRef = useRef<HTMLDivElement>(null);
  const [metaWrapped, setMetaWrapped] = useState(false);
  const [metaInlineOffset, setMetaInlineOffset] = useState(0);
  const content = message.content;
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const collapseQuote = useCallback(
    (
      collapse: () => void,
      pointerClientY: number,
      getCollapsedAnchor: () => Element | null,
    ) => onCollapseQuote(message.id, collapse, pointerClientY, getCollapsedAnchor),
    [message.id, onCollapseQuote],
  );
  const selectedReplyQuoteFor = (shell: HTMLElement) => {
    const sourceText = content.kind === "text"
      ? content.text
      : content.kind === "media" || content.kind === "file"
        ? content.caption
        : undefined;
    const sourceEntities = content.kind === "text"
      ? content.entities
      : content.kind === "media" || content.kind === "file"
        ? content.captionEntities
        : undefined;
    const selection = globalThis.getSelection();
    const surface = sourceText
      ? [...shell.querySelectorAll<HTMLElement>(".message-rich-text")]
          .find((candidate) => {
            const anchor = selection?.anchorNode;
            const focus = selection?.focusNode;
            return Boolean(
              anchor && focus &&
              (anchor === candidate || candidate.contains(anchor)) &&
              (focus === candidate || candidate.contains(focus)),
            );
          })
      : undefined;
    return sourceText && surface
      ? replyQuoteFromSelection(selection, surface, sourceText, sourceEntities)
      : undefined;
  };
  const isSticker = content.kind === "media" && content.mediaType === "sticker";
  const isService = content.kind === "service" || content.kind === "unsupported";
  const handleDeveloperCopyClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      !developerMode ||
      !event.ctrlKey ||
      event.button !== 0
    ) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, textarea, select, video, audio, [role='button']")) return;
    event.preventDefault();
    event.stopPropagation();
    void onLoadRawMessage(message.chatId, message.id)
      .then((raw) => raw ? writeClipboardText(raw) : undefined)
      .catch(() => undefined);
  }, [developerMode, message, onLoadRawMessage]);
  const isVisual = content.kind === "media" &&
    ["photo", "video", "videoNote", "animation", "sticker"].includes(content.mediaType);
  const hasCaption = !albumItem && content.kind === "media" && Boolean(content.caption);
  const showSender = !albumItem && !message.outgoing && (
    channelPost || (!isSticker && isGroupFirst(groupPosition))
  );
  const fullMediaSource = content.kind === "media" ? localMediaSource(content.localPath) : undefined;
  const localPreviewSource = content.kind === "media"
    ? localMediaSource(content.thumbnailPath)
    : undefined;
  const previewSource = content.kind === "media"
    ? localPreviewSource ?? content.previewDataUrl
    : undefined;
  const usableFullMediaSource = fullMediaSource && failedMediaSources.has(fullMediaSource)
    ? undefined
    : fullMediaSource;
  const usablePreviewSource = previewSource && failedMediaSources.has(previewSource)
    ? undefined
    : previewSource;
  const isVideoSticker = content.kind === "media" && content.mediaType === "sticker" && (
    content.mimeType === "video/webm" || /\.webm(?:$|[?#])/i.test(content.localPath ?? "")
  );
  const isTgsSticker = content.kind === "media" && content.mediaType === "sticker" && (
    content.mimeType === "application/x-tgsticker" || /\.tgs(?:$|[?#])/i.test(content.localPath ?? "")
  );
  const imageMediaSource = content.kind === "media" && (isVideoSticker || isTgsSticker)
    ? usablePreviewSource
    : usableFullMediaSource ?? usablePreviewSource;
  const activeMediaSource = usableFullMediaSource ?? usablePreviewSource;
  const measuredSize = measuredMedia && (
    measuredMedia.source === activeMediaSource || failedMediaSources.has(measuredMedia.source)
  ) ? measuredMedia : undefined;
  const declaredMediaSize = content.kind === "media" &&
    Number.isFinite(content.width) && (content.width ?? 0) > 0 &&
    Number.isFinite(content.height) && (content.height ?? 0) > 0
    ? { width: content.width, height: content.height }
    : undefined;
  const mediaLayout = content.kind === "media" && isVisual
    ? fitMediaLayout(
        content.mediaType,
        declaredMediaSize?.width ?? measuredSize?.width,
        declaredMediaSize?.height ?? measuredSize?.height,
        {
          hasReadableText: hasCaption || Boolean(replyPreview) || Boolean(forwardLabel),
        },
      )
    : undefined;
  const reactions = visibleMessageReactions(message, blockedReactionSenderIds);
  const showReactionFooter = !selectionMode && !isService && reactions.length > 0;

  useLayoutEffect(() => {
    const flow = textFlowRef.current;
    const hasInlineCaption = isVisual && hasCaption;
    if (channelPost || (content.kind !== "text" && !hasInlineCaption) || !flow) {
      if (channelPost) {
        setMetaWrapped(true);
        setMetaInlineOffset(0);
      }
      return;
    }

    const measure = () => {
      const text = flow.querySelector<HTMLElement>(".message-rich-text");
      const meta = flow.querySelector<HTMLElement>(".message-meta");
      if (!text) return;
      const isWrappedLayout = Boolean(meta) && flow.classList.contains("is-meta-wrapped");
      if (isWrappedLayout) flow.classList.remove("is-meta-wrapped");
      try {
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .sort((left, right) => left.top - right.top || left.left - right.left);
        const computed = getComputedStyle(text);
        const parsedLineHeight = Number.parseFloat(computed.lineHeight);
        const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight
          : Number.parseFloat(computed.fontSize) * 1.48;

        if (!meta) {
          setMetaWrapped(false);
          setMetaInlineOffset(0);
          return;
        }
        if (text.querySelector(".rich-blockquote.is-collapsed")) {
          setMetaWrapped(true);
          setMetaInlineOffset(0);
          return;
        }
        const lastLine = rects.at(-1);
        if (!lastLine) return;
        const metaBounds = meta.getBoundingClientRect();
        const transform = getComputedStyle(meta).transform;
        const translatedY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
        const wrapped = metaBounds.top - translatedY > lastLine.top + 4;
        setMetaWrapped((current) => current === wrapped ? current : wrapped);
        const inlineOffset = wrapped
          ? 0
          : lastLine.bottom - (metaBounds.bottom - translatedY) + INLINE_META_LOWERING_PX;
        setMetaInlineOffset((current) => Math.abs(current - inlineOffset) < 0.25
          ? current
          : inlineOffset);
      } finally {
        if (isWrappedLayout) flow.classList.add("is-meta-wrapped");
      }
    };

    measure();
    const stopObservingFlow = observeLayout(flow, measure);
    const bubbleShell = flow.closest<HTMLElement>(".message-bubble-shell");
    const stopObservingBubbleShell = bubbleShell
      ? observeLayout(bubbleShell, measure)
      : undefined;
    const layoutContainer = flow.closest<HTMLElement>(".message-group");
    let containerWidth = layoutContainer?.getBoundingClientRect().width;
    const measureWhenContainerWidthChanges = () => {
      if (!layoutContainer) return;
      const nextWidth = layoutContainer.getBoundingClientRect().width;
      if (containerWidth !== undefined && Math.abs(nextWidth - containerWidth) <= 0.5) return;
      containerWidth = nextWidth;
      measure();
    };
    const stopObservingContainer = layoutContainer
      ? observeLayout(layoutContainer, measureWhenContainerWidthChanges)
      : undefined;
    return () => {
      stopObservingFlow();
      stopObservingBubbleShell?.();
      stopObservingContainer?.();
    };
  }, [
    content,
    channelPost,
    hasCaption,
    isVisual,
    message.delivery,
    message.editedAt,
    message.sentAt,
    showReactionFooter,
  ]);
  const visualShellStyle = mediaLayout
    ? {
        "--visual-card-width": `${mediaLayout.width}px`,
      } as CSSProperties
    : undefined;
  const rememberMediaSize = (source: string | undefined, width: number, height: number) => {
    if (!source || width <= 0 || height <= 0) return;
    setMeasuredMedia((current) => current?.source === source &&
      current.width === width && current.height === height
      ? current
      : { source, width, height });
  };
  const markMediaSourceFailed = (source: string | undefined) => {
    if (!source) return;
    setFailedMediaSources((current) => {
      if (current.has(source)) return current;
      const next = new Set(current);
      next.add(source);
      return next;
    });
    if (attemptedMediaRecoveryRef.current.has(source) || content.kind !== "media") return;
    const fileId = source === fullMediaSource
      ? content.fileId
      : source === localPreviewSource ? content.thumbnailFileId : undefined;
    if (fileId === undefined) return;
    attemptedMediaRecoveryRef.current.add(source);
    void onRecoverFile(fileId, 32).then((recovered) => {
      if (!recovered) return;
      setFailedMediaSources((current) => {
        if (!current.has(source)) return current;
        const next = new Set(current);
        next.delete(source);
        return next;
      });
    });
  };
  const fileProgress = (content.kind === "file" || content.kind === "media") && content.progress !== undefined
    ? `${Math.round(content.progress * 100)}%`
    : undefined;
  const transferProgress = content.kind === "file" || content.kind === "media"
    ? content.progress ?? 0
    : 0;
  // Sticker outlines, thumbnails, and decoded media are all visual loading
  // surfaces. Keep transfer UI out of them; a stale TDLib file state must not
  // put a download button over a sticker that is already visible.
  const stickerVisualPending = isSticker && (
    !activeMediaSource || readyStickerSource !== activeMediaSource
  );
  const hideStickerDownloadControls = isSticker && (
    stickerVisualPending || Boolean(activeMediaSource)
  );
  const downloadFileId = content.kind === "file" || content.kind === "media"
    ? content.fileId
    : undefined;
  const downloadFileName = content.kind === "file" || content.kind === "media"
    ? content.fileName
    : "";
  const canDownload = (content.kind === "file" || content.kind === "media") &&
    downloadFileId !== undefined &&
    content.canDownload !== false &&
    !content.isDownloaded &&
    !content.isDownloading &&
    !hideStickerDownloadControls;
  const canCancelUpload = (content.kind === "file" || content.kind === "media") &&
    content.isUploading === true;
  const canCancelDownload = (content.kind === "file" || content.kind === "media") &&
    downloadFileId !== undefined && content.isDownloading === true;
  const renderMediaTransferProgress = () => content.kind === "media" &&
    (content.isDownloading || content.isUploading) &&
    (!hideStickerDownloadControls || content.isUploading === true) ? (
      <span
        className="media-progress"
        role="progressbar"
        aria-label={translate("{{value0}} {{value1}}", {
          value0: content.isUploading ? translate("上传") : translate("下载"),
          value1: downloadFileName,
        })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(transferProgress * 100)}
      >
        {(canCancelUpload || canCancelDownload) && (
          <button type="button" aria-label={translate("{{value0}} {{value1}}", {
            value0: canCancelUpload ? translate("取消上传") : translate("取消下载"),
            value1: downloadFileName,
          })} title={canCancelUpload ? translate("取消上传") : translate("取消下载")} onClick={() => canCancelUpload ? void onCancelUpload(message.id, message.chatId) : void onCancelDownload(downloadFileId!)}>
            <MediaProgressRing progress={transferProgress} size={30} />
            <X className="media-progress-cancel" size={14} strokeWidth={2.2} />
          </button>
        )}
        {!canCancelUpload && !canCancelDownload && (
          <span><MediaProgressRing progress={transferProgress} /></span>
        )}
      </span>
    ) : undefined;
  const localFilePath = content.kind === "file" || content.kind === "media"
    ? content.localPath
    : undefined;
  const canOpenFile = (content.kind === "file" || content.kind === "media") &&
    content.isDownloaded === true && Boolean(localFilePath);
  const executableFile = (content.kind === "file" || content.kind === "media") &&
    isExecutableFile(content.fileName, content.mimeType);
  const fileSizeLabel = content.kind === "file" || content.kind === "media"
    ? formatFileSize(content.size) ?? content.sizeLabel
    : undefined;
  const openOrDownloadFile = () => {
    if (canOpenFile) {
      if (executableFile) void onOpenDownloadDirectory();
      else void onOpenFile(localFilePath!, downloadFileId);
    } else if (canDownload) {
      void onDownload(downloadFileId!, downloadFileName);
    }
  };
  const previewFileId = content.kind === "media" && content.thumbnailFileId !== undefined &&
    content.thumbnailCanDownload === true && !content.thumbnailPath && !content.thumbnailIsDownloading
    ? content.thumbnailFileId
    : undefined;
  const automaticFileId = shouldAutoDownload(content, autoDownloadPolicy) &&
    (content.kind === "file" || content.kind === "media")
    ? content.fileId
    : undefined;
  // Full videos can take long enough to leave the player as an empty block.
  // Fetch their small TDLib thumbnail first, then let the next render enqueue
  // the full file. Photos and stickers still fetch their display asset directly.
  const lazyMediaFileId = nextVisibleMediaFileId(
    content,
    automaticFileId,
    previewFileId,
  );
  const lazyMediaIsThumbnail = content.kind === "media" &&
    lazyMediaFileId !== undefined && lazyMediaFileId === content.thumbnailFileId;
  const lazyMediaRef = useVisibleFile<HTMLElement>(
    lazyMediaFileId,
    lazyMediaFileId !== undefined &&
      (lazyMediaIsThumbnail || automaticFileId !== undefined),
    lazyMediaIsThumbnail ? 24 : 28,
    MEDIA_PREFETCH_ROOT_MARGIN,
  );
  const setMessageRowRef = useCallback((element: HTMLElement | null) => {
    const previousElement = rowRef.current;
    if (previousElement && previousElement !== element) {
      previousElement.classList.remove(
        "is-preparing-entrance-incoming",
        "is-preparing-entrance-outgoing",
      );
    }
    entranceCleanupRef.current?.();
    entranceCleanupRef.current = undefined;
    rowRef.current = element;
    lazyMediaRef.current = element;
    if (!element) return;
    const preparedEntrance = entrance ?? (deferUntilPinned
      ? message.outgoing ? "outgoing" : "incoming"
      : undefined);
    if (!preparedEntrance) {
      onMount?.();
      return;
    }
    const list = element.closest<HTMLElement>(".message-list");
    if (!list) return;
    // Virtuoso can mount a new block one frame before the bottom pin. Preserve
    // the keyframe's initial pose, but do not spend the animation offscreen.
    const preparingClass = `is-preparing-entrance-${preparedEntrance}`;
    element.classList.add(preparingClass);
    let observer: IntersectionObserver | undefined;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let visibleAtPinnedEdge = false;
    let bottomPinned = !deferUntilPinned || !onMount;
    const clearEntranceWait = () => {
      observer?.disconnect();
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      if (entranceCleanupRef.current === clearEntranceWait) {
        entranceCleanupRef.current = undefined;
      }
    };
    const startEntrance = () => {
      if (!element.isConnected || !list.isConnected) return;
      clearEntranceWait();
      const claimedEntrance = consumeMessageEntrance(message);
      element.classList.remove(preparingClass);
      if (claimedEntrance) {
        const reduceMotion = document.documentElement.classList.contains("reduce-motion") ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!reduceMotion) {
          entranceKindRef.current = claimedEntrance;
          void element.offsetWidth;
          element.classList.add(`is-entering-${claimedEntrance}`);
        }
      }
    };
    const startWhenReady = () => {
      if (visibleAtPinnedEdge && bottomPinned) startEntrance();
    };
    observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      const rootBounds = entry?.rootBounds;
      if (!entry?.isIntersecting || !rootBounds) {
        visibleAtPinnedEdge = false;
        return;
      }
      const rowBounds = entry.boundingClientRect;
      visibleAtPinnedEdge = rowBounds.height >= rootBounds.height
        ? rowBounds.top < rootBounds.bottom && rowBounds.bottom <= rootBounds.bottom + 1
        : entry.intersectionRect.height >= rowBounds.height - 1 &&
          rowBounds.top >= rootBounds.top - 1 && rowBounds.bottom <= rootBounds.bottom + 1;
      startWhenReady();
    }, { root: list, threshold: [0, 0.99, 1] });
    observer.observe(element);
    const willPinAtBottom = onMount?.(() => {
      bottomPinned = true;
      startWhenReady();
    });
    if (willPinAtBottom === false) {
      clearEntranceWait();
      element.classList.remove(preparingClass);
      consumeMessageEntrance(message);
      return;
    }
    timeout = globalThis.setTimeout(() => {
      clearEntranceWait();
      element.classList.remove(preparingClass);
      consumeMessageEntrance(message);
    }, MESSAGE_ENTRANCE_LIFETIME_MS);
    entranceCleanupRef.current = clearEntranceWait;
  }, [
    deferUntilPinned,
    entrance,
    lazyMediaRef,
    message.chatId,
    message.id,
    message.outgoing,
    onMount,
  ]);

  const selectionDisabled = selectionPending ||
    message.permissions?.canForward === false ||
    (selectionLimitReached && !selected);

  const messageMeta = isService ? null : albumItem && channelPost ? (
    (message.delivery === "failed" || message.delivery === "sending") ? (
      <span className="media-album-item-delivery">
        <MessageDeliveryStatus messages={[message]} channelPost onRetry={onRetry} />
      </span>
    ) : null
  ) : (
    <MessageMetadata message={message} channelPost={channelPost} showChannelMetadata={showChannelMetadata}
      channelAuthor={channelAuthor} onOpenAuthor={!forwardLabel ? onOpenForwardSource : undefined} onRetry={onRetry} />
  );

  const visualCaption = content.kind === "media" && hasCaption && content.caption ? (
    <div
      ref={textFlowRef}
      className={`message-text-flow photo-caption-flow ${metaWrapped ? "is-meta-wrapped" : ""}`}
      style={{ "--message-meta-inline-offset": `${metaInlineOffset}px` } as CSSProperties}
    >
      <MessageRichText
        chatId={message.chatId}
        className="photo-caption"
        text={content.caption}
        entities={content.captionEntities}
        highlightQuery={searchQuery}
        onOpenMention={onOpenMention}
        onSearchHashtag={onSearchHashtag}
        onCollapseQuote={collapseQuote}
      />
      {!showReactionFooter && messageMeta}
    </div>
  ) : null;

  return (
    <article
      ref={setMessageRowRef}
      className={`message-row group-${groupPosition} ${message.outgoing ? "is-outgoing" : "is-incoming"} ${message.isRemoving ? "is-removing" : ""} ${message.isLocallyDeleted ? "is-locally-deleted" : ""} ${isService ? "is-service" : ""} ${channelPost ? "is-channel-post" : ""} ${content.kind === "unsupported" ? "is-unsupported" : ""} ${selected ? "is-selected" : ""} ${selectionPending ? "is-selection-pending" : ""} ${joinsSelectionBefore ? "joins-selection-before" : ""} ${highlighted ? "is-notification-target" : ""} ${albumItem ? "is-album-item" : ""}`}
      data-message-id={message.id}
      data-local-block-group={localBlockGroupId}
      onClick={(event) => {
        if (!selectionMode || isService || selectionDisabled) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button, a, input, textarea, select, video, audio, [role='button']")) return;
        void onToggleSelection(message);
      }}
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName.startsWith("message-enter-") &&
          entranceKindRef.current
        ) {
          event.currentTarget.classList.remove(`is-entering-${entranceKindRef.current}`);
          entranceKindRef.current = undefined;
        }
      }}
    >
      <div
        className={`message-bubble-shell ${isVisual ? "is-visual-shell" : ""} ${isSticker ? "is-sticker-shell" : ""} ${channelPost ? "is-channel-post-shell" : ""} ${content.kind === "media" && ["audio", "voice"].includes(content.mediaType) ? "is-audio-shell" : ""} ${message.replyMarkup ? "has-inline-keyboard" : ""} ${cornerAction ? "has-corner-action" : ""} ${locallyConcealed ? "is-local-block-concealed" : ""}`}
        style={visualShellStyle}
        tabIndex={!locallyConcealed && !selectionMode && !isService ? 0 : undefined}
        onPointerDown={(event) => {
          contextReplyQuoteRef.current = event.button === 2
            ? selectedReplyQuoteFor(event.currentTarget)
            : undefined;
        }}
        onClick={handleDeveloperCopyClick}
        onContextMenu={(event) => {
          if (developerMode && event.ctrlKey && event.button === 2) return;
          event.preventDefault();
          if (isService) return;
          if (selectionMode) void onToggleSelection(message);
          else {
            const replyQuote = contextReplyQuoteRef.current ?? selectedReplyQuoteFor(event.currentTarget);
            contextReplyQuoteRef.current = undefined;
            void onOpenActions(message, event.clientX, event.clientY, event.currentTarget, replyQuote);
          }
        }}
        onKeyDown={(event) => {
          if (selectionMode || isService) return;
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const left = message.outgoing ? bounds.left - 160 : bounds.right + 4;
          void onOpenActions(message, left, bounds.top, event.currentTarget, undefined, true);
        }}
      >
        <div className={`message-bubble ${isVisual ? "is-photo" : ""} ${channelPost ? "is-channel-post-bubble" : ""} ${replyPreview ? "has-reply" : ""} ${content.kind === "media" ? `media-bubble-${content.mediaType}` : ""} ${hasCaption ? "has-caption" : ""} ${content.kind === "text" || content.kind === "rich" ? "is-textual" : ""} ${content.kind === "text" && metaWrapped ? "has-wrapped-meta" : ""} ${showReactionFooter ? "has-reactions" : ""}`}>
          {!albumItem && !isService && forwardLabel && (
            onOpenForwardSource ? (
              <button
                className="message-forward-label"
                type="button"
                aria-label={translate("打开{{value0}}", { value0: forwardLabel })}
                onClick={onOpenForwardSource}
              >
                <Forward size={12} strokeWidth={2} />
                {forwardLabel}
              </button>
            ) : (
              <span className="message-forward-label">
                <Forward size={12} strokeWidth={2} />
                {forwardLabel}
              </span>
            )
          )}
          {!isService && showSender && (
            <div className="message-sender-row">
              {senderProfileAvailable ? (
                <button
                  className={`message-sender ${senderIsAdministrator ? "is-administrator" : ""}`.trim()}
                  type="button"
                  onClick={() => onOpenSenderProfile(message.senderId)}
                >
                  <span>{senderName}</span>
                </button>
              ) : <span className={`message-sender ${senderIsAdministrator ? "is-administrator" : ""}`.trim()}><span>{senderName}</span></span>}
              {senderLabel && (
                <small className={`message-sender-label ${senderIsAdministrator ? "is-administrator" : ""}`.trim()}>
                  {senderLabel}
                </small>
              )}
            </div>
          )}
          {!albumItem && !isService && replyPreview && (
            <button
              className={`message-reply-preview ${replyPreview.isCurrentUser ? "is-current-user" : ""} ${replyPreview.concealed ? "is-local-block-concealed" : ""}`}
              type="button"
              disabled={!replyPreview.messageId}
              onClick={() => {
                if (replyPreview.chatId && replyPreview.messageId) {
                  onOpenReply(replyPreview.chatId, replyPreview.messageId);
                }
              }}
            >
              <strong className={replyPreview.isAdministrator ? "is-administrator" : undefined}>
                {replyPreview.author}
              </strong>
              <small>{replyPreview.text}</small>
            </button>
          )}
          {content.kind === "text" ? (
            <div
              ref={textFlowRef}
              className={`message-text-flow ${isLargeEmojiText(content.text) ? "is-large-emoji" : ""} ${metaWrapped ? "is-meta-wrapped" : ""}`}
              style={{
                "--message-meta-inline-offset": `${metaInlineOffset}px`,
              } as CSSProperties}
            >
              <MessageRichText
                chatId={message.chatId}
                text={content.text}
                entities={content.entities}
                highlightQuery={searchQuery}
                onOpenMention={onOpenMention}
                onSearchHashtag={onSearchHashtag}
                onCollapseQuote={collapseQuote}
              />
              {message.isPending && (
                content.text ? (
                  <span className="pending-message-caret" aria-label={translate("机器人仍在生成")}><span /></span>
                ) : (
                  <span className="pending-message-thinking" role="status">
                    <LoaderCircle className="spin" size={14} />{translate("正在生成")}</span>
                )
              )}
              {!showReactionFooter && messageMeta}
            </div>
          ) : content.kind === "rich" ? (
            <RichMessageContent
              blocks={content.blocks}
              isRtl={content.isRtl}
              isFull={content.isFull}
              messageId={message.id}
              highlightQuery={searchQuery}
              onDownload={onDownload}
              onCancelDownload={onCancelDownload}
              onRecoverFile={onRecoverFile}
              onStream={onStream}
              onSuspendStream={onSuspendStream}
              onSearchHashtag={onSearchHashtag}
            />
          ) : content.kind === "service" ? (
            <p className="message-service-content">
              {serviceMembers && serviceMembers.length > 0 ? (
                <>
                  {serviceMembers.map((member, index) => (
                    <Fragment key={member.id}>
                      {index > 0 && "、"}
                      {member.profileAvailable ? (
                        <button
                          type="button"
                          aria-label={translate("查看 {{value0}} 资料", { value0: member.name })}
                          onClick={() => onOpenSenderProfile(member.id)}
                        >
                          {member.name}
                        </button>
                      ) : member.name}
                    </Fragment>
                  ))}
                  <span>{translate(" 加入了群聊")}</span>
                </>
              ) : highlightedText(content.text, searchQuery)}
            </p>
          ) : content.kind === "unsupported" ? (
            <p>{highlightedText(content.text, searchQuery)}</p>
          ) : isVisual && content.kind === "media" ? (
            <div className={`photo-message media-${content.mediaType}`} data-media-type={content.mediaType}>
              {content.showCaptionAboveMedia && visualCaption}
              <div
                className={`photo-preview ${mediaLayout?.aspectRatio ? "has-media-ratio" : ""} ${content.mediaType === "photo" && usablePreviewSource && !usableFullMediaSource ? "is-preview-only" : ""}`}
                style={mediaLayout?.aspectRatio
                  ? { aspectRatio: mediaLayout.aspectRatio }
                  : undefined}
              >
                {isSticker && (!activeMediaSource || readyStickerSource !== activeMediaSource) && (
                  <StickerPlaceholder fileId={content.fileId} width={content.width} height={content.height} />
                )}
                <MediaSpoiler
                  active={content.hasSpoiler === true}
                  resetKey={`${message.chatId}:${message.id}`}
                  concealedOverlay={renderMediaTransferProgress()}
                >
                {["video", "videoNote"].includes(content.mediaType) ? (
                  <VideoPlayer
                    source={usableFullMediaSource}
                    poster={usablePreviewSource}
                    playbackId={`${message.chatId}:${message.id}`}
                    label={content.fileName}
                    fileId={content.fileId}
                    size={content.size}
                    mimeType={content.mimeType}
                    mediaWidth={content.width}
                    mediaHeight={content.height}
                    downloading={content.isDownloading === true}
                    downloadProgress={content.progress}
                    round={content.mediaType === "videoNote"}
                    canDownload={canDownload && downloadFileId !== undefined}
                    onDownload={canDownload && downloadFileId !== undefined
                      ? () => onDownload(downloadFileId, content.fileName)
                      : undefined}
                    onRequestStream={onStream}
                    onSuspendStream={onSuspendStream}
                    onLoadedMetadata={rememberMediaSize}
                    onError={markMediaSourceFailed}
                  />
                ) : usableFullMediaSource && isVideoSticker ? (
                  <AutoplayVideo
                    src={usableFullMediaSource}
                    poster={usablePreviewSource}
                    autoplay={autoplayAnimations}
                    loop
                    muted
                    playsInline
                    aria-label={content.caption || content.fileName}
                    onLoadedData={() => setReadyStickerSource(usableFullMediaSource)}
                    onLoadedMetadata={(event) => rememberMediaSize(
                      usableFullMediaSource,
                      event.currentTarget.videoWidth,
                      event.currentTarget.videoHeight,
                    )}
                    onError={() => markMediaSourceFailed(usableFullMediaSource)}
                  />
                ) : usableFullMediaSource && isTgsSticker ? (
                  <TgsSticker
                    src={usableFullMediaSource}
                    label={content.caption || content.fileName}
                    onReady={() => setReadyStickerSource(usableFullMediaSource)}
                    autoplay={autoplayAnimations}
                    onError={() => markMediaSourceFailed(usableFullMediaSource)}
                  />
                ) : usableFullMediaSource && content.mediaType === "animation" && /^video\//i.test(content.mimeType ?? "") ? (
                  <AutoplayVideo
                    src={usableFullMediaSource}
                    poster={usablePreviewSource}
                    autoplay={autoplayAnimations}
                    loop
                    muted
                    playsInline
                    onLoadedMetadata={(event) => rememberMediaSize(
                      usableFullMediaSource,
                      event.currentTarget.videoWidth,
                      event.currentTarget.videoHeight,
                    )}
                    onError={() => markMediaSourceFailed(usableFullMediaSource)}
                  />
                ) : imageMediaSource && content.mediaType === "animation" ? (
                  <StableImage
                    src={imageMediaSource}
                    alt={content.caption || content.fileName}
                    loading="lazy"
                    decoding="async"
                    onLoad={(event) => rememberMediaSize(
                      imageMediaSource,
                      event.currentTarget.naturalWidth,
                      event.currentTarget.naturalHeight,
                    )}
                    onError={() => markMediaSourceFailed(imageMediaSource)}
                  />
                ) : imageMediaSource && content.mediaType === "photo" && onOpenMedia ? (
                  <button
                    className="photo-open"
                    type="button"
                    aria-label={translate("查看图片 {{value0}}", { value0: content.fileName })}
                    onClick={() => onOpenMedia(message.id, message.chatId)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpenMedia(message.id, message.chatId);
                    }}
                  >
                    <StableImage
                      src={imageMediaSource}
                      alt={content.caption || content.fileName}
                      loading="lazy"
                      decoding="async"
                      onLoad={(event) => rememberMediaSize(
                        imageMediaSource,
                        event.currentTarget.naturalWidth,
                        event.currentTarget.naturalHeight,
                      )}
                      onError={() => markMediaSourceFailed(imageMediaSource)}
                    />
                  </button>
                ) : imageMediaSource ? (
                  <StableImage
                    src={imageMediaSource}
                    alt={content.caption || content.fileName}
                    loading="lazy"
                    decoding="async"
                    onReady={isSticker ? () => setReadyStickerSource(imageMediaSource) : undefined}
                    onLoad={(event) => rememberMediaSize(
                      imageMediaSource,
                      event.currentTarget.naturalWidth,
                      event.currentTarget.naturalHeight,
                    )}
                    onError={() => markMediaSourceFailed(imageMediaSource)}
                  />
                ) : content.mediaType === "photo" && onOpenMedia ? (
                  <button
                    className="photo-open"
                    type="button"
                    aria-label={translate("查看图片 {{value0}}", { value0: content.fileName })}
                    onClick={() => onOpenMedia(message.id, message.chatId)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpenMedia(message.id, message.chatId);
                    }}
                  >
                    <span className="photo-placeholder" aria-label={translate("媒体正在加载")}>
                      <ImageIcon size={28} strokeWidth={1.6} />
                    </span>
                  </button>
                ) : isSticker ? null : (
                  <span className="photo-placeholder" aria-label={translate("媒体正在加载")}>
                    <ImageIcon size={28} strokeWidth={1.6} />
                  </span>
                )}
                {canDownload && !["video", "videoNote"].includes(content.mediaType) && (
                  <button
                    className="media-download"
                    type="button"
                    aria-label={translate("下载 {{value0}}", { value0: downloadFileName })}
                    title={translate("下载媒体")}
                    onClick={() => void onDownload(downloadFileId!, downloadFileName)}
                  >
                    <Download size={19} />
                  </button>
                )}
                {renderMediaTransferProgress()}
                </MediaSpoiler>
                {isSticker && content.stickerSetId && onOpenStickerSet && !selectionMode && (
                  <button
                    className="sticker-set-open"
                    type="button"
                    aria-label={translate("查看贴纸包")}
                    title={translate("查看贴纸包")}
                    onClick={() => onOpenStickerSet(content.stickerSetId!)}
                  />
                )}
              </div>
              {!content.showCaptionAboveMedia && visualCaption}
            </div>
          ) : content.kind === "poll" ? (
            <PollMessage
              poll={content}
              messageId={message.id}
              chatId={message.chatId}
              highlightQuery={searchQuery}
              onAnswer={onPollAnswer}
              onSearchHashtag={onSearchHashtag}
            />
          ) : content.kind === "media" && ["audio", "voice"].includes(content.mediaType) ? (
            <div className="attachment-message">
              <div className="audio-message">
                <AudioPlayer
                  source={fullMediaSource}
                  playbackId={`${message.chatId}:${message.id}`}
                  label={content.fileName}
                  displayLabel={highlightedText(content.fileName, searchQuery)}
                  subtitle={content.sizeLabel}
                  fileId={content.fileId}
                  size={content.size}
                  mimeType={content.mimeType}
                  durationHint={content.duration}
                  previousPlaybackId={previousAudioPlaybackId}
                  nextPlaybackId={nextAudioPlaybackId}
                  downloadProgress={content.progress}
                  onRequestStream={onStream}
                  onRecoverFile={content.fileId !== undefined
                    ? () => onRecoverFile(content.fileId!, 32)
                    : undefined}
                  onSuspendStream={content.fileId !== undefined
                    ? () => { void onSuspendStream(content.fileId!); }
                    : undefined}
                  onDownload={canDownload && downloadFileId !== undefined
                    ? () => void onDownload(downloadFileId, downloadFileName)
                    : undefined}
                  onCancelDownload={canCancelDownload && downloadFileId !== undefined
                    ? () => void onCancelDownload(downloadFileId)
                    : undefined}
                />
              </div>
              {content.caption && (
                <MessageRichText
                  chatId={message.chatId}
                  className="attachment-caption"
                  text={content.caption}
                  entities={content.captionEntities}
                  highlightQuery={searchQuery}
                  onOpenMention={onOpenMention}
                  onSearchHashtag={onSearchHashtag}
                  onCollapseQuote={collapseQuote}
                />
              )}
            </div>
          ) : (
            <div className="attachment-message">
              <div className="file-message">
                <button
                  className="file-primary-action"
                  type="button"
                  disabled={!canOpenFile && !canDownload}
                  aria-label={canOpenFile
                    ? executableFile ? translate("打开下载目录 {{value0}}", { value0: content.fileName }) : translate("打开 {{value0}}", { value0: content.fileName })
                    : canDownload ? translate("下载 {{value0}}", { value0: content.fileName }) : content.fileName}
                  title={canOpenFile
                    ? executableFile ? translate("可执行文件已下载，打开下载目录") : translate("打开文件")
                    : canDownload ? translate("下载文件") : undefined}
                  onClick={openOrDownloadFile}
                >
                  <span className={`file-status-icon ${content.isDownloading ? "is-downloading" : content.isDownloaded ? "is-downloaded" : "is-pending"}`}>
                    {content.isDownloading
                      ? <MediaProgressRing progress={transferProgress} size={44} />
                      : content.isDownloaded
                        ? <FileText size={21} strokeWidth={1.8} />
                        : <Download size={21} strokeWidth={1.9} />}
                  </span>
                  <span className="file-copy">
                    <strong>{highlightedText(content.fileName, searchQuery)}</strong>
                    <small>{content.isUploading ? translate("上传中 {{value0}}", { value0: fileProgress ?? "" }) : content.isDownloading ? translate("下载中 {{value0}}", { value0: fileProgress ?? "" }) : message.delivery === "failed" ? translate("发送失败") : content.isDownloaded ? translate("已缓存 · {{value0}}", { value0: fileSizeLabel ?? translate("文件") }) : fileSizeLabel ?? translate("待下载")}</small>
                  </span>
                </button>
                <span className="file-actions">
                  {canOpenFile && !executableFile && <button type="button" aria-label={translate("打开 {{value0}}", { value0: content.fileName })} title={translate("打开文件")} onClick={() => void onOpenFile(localFilePath!, downloadFileId)}><ExternalLink size={15} /></button>}
                  {canOpenFile && <button type="button" aria-label={translate("另存为 {{value0}}", { value0: content.fileName })} title={translate("另存为")} onClick={() => void onSaveFileAs(localFilePath!, content.fileName)}><Save size={15} /></button>}
                  {canOpenFile && <button type="button" aria-label={translate("打开下载目录")} title={translate("打开下载目录")} onClick={() => void onOpenDownloadDirectory()}><FolderOpen size={15} /></button>}
                  {(canCancelUpload || canCancelDownload) && (
                    <button
                      type="button"
                      aria-label={canCancelUpload ? translate("取消上传 {{value0}}", { value0: content.fileName }) : translate("取消下载 {{value0}}", { value0: content.fileName })}
                      title={canCancelUpload ? translate("取消上传") : translate("取消下载")}
                      onClick={() => canCancelUpload ? void onCancelUpload(message.id, message.chatId) : void onCancelDownload(downloadFileId!)}
                    >
                      <X size={16} strokeWidth={2.2} />
                    </button>
                  )}
                </span>
              </div>
              {content.caption && (
                <MessageRichText
                  chatId={message.chatId}
                  className="attachment-caption"
                  text={content.caption}
                  entities={content.captionEntities}
                  highlightQuery={searchQuery}
                  onOpenMention={onOpenMention}
                  onSearchHashtag={onSearchHashtag}
                  onCollapseQuote={collapseQuote}
                />
              )}
            </div>
          )}
          {content.kind !== "text" && !(isVisual && hasCaption) && !showReactionFooter && messageMeta}
          {showReactionFooter && (
            <div className="message-reaction-footer">
              <MessageReactions
                messageId={message.id}
                chatId={message.chatId}
                reactions={reactions}
                canGetAddedReactions={message.interaction?.canGetAddedReactions}
                users={users}
                chats={senderChats}
                onReaction={onReaction}
                onLoadSenders={onLoadReactionSenders}
                onOpenSenderProfile={onOpenSenderProfile}
                hiddenSenderIds={blockedReactionSenderIds}
              />
              {messageMeta}
            </div>
          )}
          {channelDiscussionAction}
          {locallyConcealed && onRevealLocallyBlocked ? (
            <button
              className="local-block-message-reveal"
              type="button"
              aria-label={translate("显示一条来自{{value0}}的消息", { value0: senderName })}
              title={translate("临时显示这条消息")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRevealLocallyBlocked();
              }}
            />
          ) : null}
        </div>
        {!albumItem && !selectionMode && message.replyMarkup && (
          <InlineKeyboard
            messageId={message.id}
            chatId={message.chatId}
            markup={message.replyMarkup}
            onCallback={onBotCallback}
            onOpenUser={onOpenSenderProfile}
          />
        )}
        {cornerAction}
      </div>
    </article>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);

const previewNoop = async (..._args: any[]): Promise<void> => undefined;
const previewFalse = async (..._args: any[]): Promise<boolean> => false;
const previewReactionSenders = async (..._args: any[]): Promise<MessageReactionSenderPage> => ({
  totalCount: 0,
  senders: [],
});
const previewCallback = async (..._args: any[]): Promise<CallbackQueryAnswer | undefined> => undefined;
const previewCollapseQuote = (
  _messageId: string,
  collapse: () => void,
) => collapse();
const previewOpen = (..._args: any[]) => undefined;
const EMPTY_PREVIEW_POLICY: AutoDownloadPolicy = {
  images: false,
  videos: false,
  audio: false,
  files: false,
  limitMb: 1,
};

export interface MessageBubblePreviewProps {
  locallyConcealed?: boolean;
  onRevealLocallyBlocked?: () => void;
  previousAudioPlaybackId?: string;
  nextAudioPlaybackId?: string;
  message: Message;
  senderName: string;
  users: ReadonlyMap<string, User>;
  senderChats?: ReadonlyMap<string, Chat>;
  senderLabel?: string;
  senderIsAdministrator?: boolean;
  senderProfileAvailable?: boolean;
  channelAuthor?: string;
  channelPost?: boolean;
  showChannelMetadata?: boolean;
  serviceMembers?: MessageBubbleProps["serviceMembers"];
  replyPreview?: ReplyPreview;
  forwardLabel?: string;
  onOpenForwardSource?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
  highlighted?: boolean;
  selectionPending?: boolean;
  joinsSelectionBefore?: boolean;
  selectionLimitReached?: boolean;
  onToggleSelection?: MessageBubbleProps["onToggleSelection"];
  onOpenActions?: MessageBubbleProps["onOpenActions"];
  onLoadRawMessage?: MessageBubbleProps["onLoadRawMessage"];
  onOpenReply?: MessageBubbleProps["onOpenReply"];
  onOpenSenderProfile?: MessageBubbleProps["onOpenSenderProfile"];
  onOpenMention?: MessageBubbleProps["onOpenMention"];
  onSearchHashtag?: MessageBubbleProps["onSearchHashtag"];
  autoplayAnimations?: boolean;
  autoDownloadPolicy?: AutoDownloadPolicy;
  onDownload?: MessageBubbleProps["onDownload"];
  onCancelDownload?: MessageBubbleProps["onCancelDownload"];
  onRecoverFile?: MessageBubbleProps["onRecoverFile"];
  onOpenFile?: MessageBubbleProps["onOpenFile"];
  onSaveFileAs?: MessageBubbleProps["onSaveFileAs"];
  onOpenDownloadDirectory?: MessageBubbleProps["onOpenDownloadDirectory"];
  onStream?: MessageBubbleProps["onStream"];
  onSuspendStream?: MessageBubbleProps["onSuspendStream"];
  onRetry?: MessageBubbleProps["onRetry"];
  onCancelUpload?: MessageBubbleProps["onCancelUpload"];
  onReaction?: MessageBubbleProps["onReaction"];
  onLoadReactionSenders?: MessageBubbleProps["onLoadReactionSenders"];
  onPollAnswer?: MessageBubbleProps["onPollAnswer"];
  onBotCallback?: MessageBubbleProps["onBotCallback"];
  onOpenMedia?: MessageBubbleProps["onOpenMedia"];
  onOpenStickerSet?: MessageBubbleProps["onOpenStickerSet"];
  blockedReactionSenderIds?: ReadonlySet<string>;
}

export function MessageBubblePreview({
  locallyConcealed,
  onRevealLocallyBlocked,
  previousAudioPlaybackId,
  nextAudioPlaybackId,
  message,
  senderName,
  users,
  senderChats = new Map(),
  senderLabel,
  senderIsAdministrator = false,
  senderProfileAvailable = false,
  channelAuthor,
  channelPost = false,
  showChannelMetadata = false,
  serviceMembers,
  replyPreview,
  forwardLabel,
  onOpenForwardSource,
  selectionMode = false,
  selected = false,
  highlighted = false,
  selectionPending = false,
  joinsSelectionBefore = false,
  selectionLimitReached = false,
  onToggleSelection = previewNoop,
  onOpenActions = previewNoop,
  onLoadRawMessage = async (..._args: any[]) => undefined,
  onOpenReply = previewOpen,
  onOpenSenderProfile = previewOpen,
  onOpenMention = previewOpen,
  onSearchHashtag = previewOpen,
  autoplayAnimations = false,
  autoDownloadPolicy = EMPTY_PREVIEW_POLICY,
  onDownload = previewNoop,
  onCancelDownload = previewNoop,
  onRecoverFile = previewFalse,
  onOpenFile = previewFalse,
  onSaveFileAs = previewNoop,
  onOpenDownloadDirectory = previewNoop,
  onStream = async (..._args: any[]) => undefined,
  onSuspendStream = previewNoop,
  onRetry = previewNoop,
  onCancelUpload = previewNoop,
  onReaction = previewNoop,
  onLoadReactionSenders = previewReactionSenders,
  onPollAnswer = previewFalse,
  onBotCallback = previewCallback,
  onOpenMedia,
  onOpenStickerSet,
  blockedReactionSenderIds,
}: MessageBubblePreviewProps) {
  return (
    <MessageBubbleComponent
      locallyConcealed={locallyConcealed}
      onRevealLocallyBlocked={onRevealLocallyBlocked}
      previousAudioPlaybackId={previousAudioPlaybackId}
      nextAudioPlaybackId={nextAudioPlaybackId}
      message={message}
      senderName={senderName}
      senderLabel={senderLabel}
      senderIsAdministrator={senderIsAdministrator}
      senderProfileAvailable={senderProfileAvailable}
      channelAuthor={channelAuthor}
      channelPost={channelPost}
      showChannelMetadata={showChannelMetadata}
      serviceMembers={serviceMembers}
      groupPosition="single"
      replyPreview={replyPreview}
      forwardLabel={forwardLabel}
      onOpenForwardSource={onOpenForwardSource}
      selectionMode={selectionMode}
      selected={selected}
      highlighted={highlighted}
      selectionPending={selectionPending}
      joinsSelectionBefore={joinsSelectionBefore}
      selectionLimitReached={selectionLimitReached}
      onToggleSelection={onToggleSelection}
      onOpenActions={onOpenActions}
      onLoadRawMessage={onLoadRawMessage}
      onDownload={onDownload}
      onCancelDownload={onCancelDownload}
      onRecoverFile={onRecoverFile}
      onOpenFile={onOpenFile}
      onSaveFileAs={onSaveFileAs}
      onOpenDownloadDirectory={onOpenDownloadDirectory}
      onStream={onStream}
      onSuspendStream={onSuspendStream}
      onRetry={onRetry}
      onCancelUpload={onCancelUpload}
      onReaction={onReaction}
      onLoadReactionSenders={onLoadReactionSenders}
      onPollAnswer={onPollAnswer}
      onBotCallback={onBotCallback}
      onCollapseQuote={previewCollapseQuote}
      onOpenReply={onOpenReply}
      onOpenSenderProfile={onOpenSenderProfile}
      users={users}
      senderChats={senderChats}
      onOpenMention={onOpenMention}
      onSearchHashtag={onSearchHashtag}
      onOpenMedia={onOpenMedia}
      onOpenStickerSet={onOpenStickerSet}
      blockedReactionSenderIds={blockedReactionSenderIds}
      autoplayAnimations={autoplayAnimations}
      autoDownloadPolicy={autoDownloadPolicy}
    />
  );
}
