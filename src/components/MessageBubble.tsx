import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  AlertCircle,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  CircleArrowRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Forward,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Pin,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useVisibleFile } from "../hooks/useVisibleFile";
import type { Message, MessageReaction } from "../telegram/types";
import { formatMessageTime } from "../utils/formatters";
import { fitMediaLayout } from "../utils/mediaLayout";
import { isGroupFirst, type MessageGroupPosition } from "../utils/messageGrouping";
import { writeClipboardText } from "../utils/clipboard";
import { TgsSticker } from "./TgsSticker";
import { VideoPlayer } from "./VideoPlayer";
import { MessageRichText } from "./MessageRichText";
import { RichMessageContent } from "./RichMessageContent";
import { AudioPlayer } from "./AudioPlayer";
import {
  nextVisibleMediaFileId,
  shouldAutoDownload,
  type AutoDownloadPolicy,
} from "../media/autoDownload";
import { consumeMessageEntrance, type MessageEntrance } from "../utils/messageEntrance";
import { isLargeEmojiText } from "../utils/largeEmoji";
import { channelPostTargetFor } from "./conversationMessages";
import { MediaProgressRing } from "./MediaProgressRing";
import { PollMessage } from "./PollMessage";
import { InlineKeyboard } from "./InlineKeyboard";
import type { CallbackQueryAnswer } from "../telegram/types";
import { usePreferencesStore } from "../store/preferencesStore";

const MEDIA_PREFETCH_ROOT_MARGIN = "1200px 0px 360px 0px";
const INLINE_META_LOWERING_PX = 2.5;

export interface ReplyPreview {
  author: string;
  text: string;
  chatId?: string;
  messageId?: string;
}

interface MessageBubbleProps {
  message: Message;
  entrance?: MessageEntrance;
  senderName: string;
  senderLabel?: string;
  senderProfileAvailable: boolean;
  groupPosition: MessageGroupPosition;
  replyPreview?: ReplyPreview;
  forwardLabel?: string;
  selectionMode: boolean;
  selected: boolean;
  highlighted: boolean;
  selectionPending: boolean;
  selectionLimitReached: boolean;
  onToggleSelection: (message: Message) => Promise<void>;
  onOpenActions: (
    message: Message,
    left: number,
    top: number,
    returnFocus?: HTMLElement,
  ) => Promise<void>;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onCancelDownload: (fileId: number) => Promise<void>;
  onOpenFile: (sourcePath: string) => Promise<void>;
  onSaveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
  onOpenDownloadDirectory: () => Promise<void>;
  onStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
  onCancelUpload: (messageId: string) => Promise<void>;
  onReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  onPollAnswer: (messageId: string, optionPositions: number[]) => Promise<boolean>;
  onBotCallback: (messageId: string, data: string) => Promise<CallbackQueryAnswer | undefined>;
  onExpandLongText: (messageId: string) => void;
  nextAudioPlaybackId?: string;
  onOpenReply: (chatId: string, messageId: string) => void;
  onOpenSenderProfile: (senderId: string) => void;
  onOpenMedia?: (messageId: string) => void;
  albumItem?: boolean;
  autoplayAnimations: boolean;
  autoDownloadPolicy: AutoDownloadPolicy;
  developerMode: boolean;
}

const localSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};

const reactionLabel = (reaction: MessageReaction) => {
  if (reaction.type.kind === "emoji") return reaction.type.emoji;
  if (reaction.type.kind === "paid") return "★";
  return "◇";
};

function MessageBubbleComponent({
  message,
  entrance,
  senderName,
  senderLabel,
  senderProfileAvailable,
  groupPosition,
  replyPreview,
  forwardLabel,
  selectionMode,
  selected,
  highlighted,
  selectionPending,
  selectionLimitReached,
  onToggleSelection,
  onOpenActions,
  onDownload,
  onCancelDownload,
  onOpenFile,
  onSaveFileAs,
  onOpenDownloadDirectory,
  onStream,
  onSuspendStream,
  onRetry,
  onCancelUpload,
  onReaction,
  onPollAnswer,
  onBotCallback,
  onExpandLongText,
  nextAudioPlaybackId,
  onOpenReply,
  onOpenSenderProfile,
  onOpenMedia,
  albumItem = false,
  autoplayAnimations,
  autoDownloadPolicy,
  developerMode,
}: MessageBubbleProps) {
  const entranceKindRef = useRef<MessageEntrance | undefined>(entrance);
  const rowRef = useRef<HTMLElement | null>(null);
  const [reactionPending, setReactionPending] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [failedMediaSources, setFailedMediaSources] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [measuredMedia, setMeasuredMedia] = useState<{
    source: string;
    width: number;
    height: number;
  }>();

  useLayoutEffect(() => {
    if (entrance) consumeMessageEntrance(message);
  }, [entrance, message.chatId, message.id]);
  const textFlowRef = useRef<HTMLDivElement>(null);
  const [metaWrapped, setMetaWrapped] = useState(false);
  const [metaInlineOffset, setMetaInlineOffset] = useState(0);
  const collapseThresholdLines = usePreferencesStore(
    (state) => state.messageCollapseThresholdLines,
  );
  const collapsedLines = usePreferencesStore((state) => state.messageCollapsedLines);
  const [textLineCount, setTextLineCount] = useState(0);
  const [collapsedTextHeight, setCollapsedTextHeight] = useState(0);
  const [textExpanded, setTextExpanded] = useState(false);
  const content = message.content;
  const textCollapsible = content.kind === "text" && textLineCount > collapseThresholdLines;
  const isService = content.kind === "service" || content.kind === "unsupported";
  const isVisual = content.kind === "media" &&
    ["photo", "video", "videoNote", "animation", "sticker"].includes(content.mediaType);
  const hasCaption = !albumItem && content.kind === "media" && Boolean(content.caption);
  const visualSizingText = hasCaption && !message.outgoing && content.kind === "media"
    ? content.caption
    : undefined;
  const showSender = !albumItem && !message.outgoing && isGroupFirst(groupPosition);
  const channelPostTarget = !albumItem ? channelPostTargetFor(message) : undefined;
  const fullMediaSource = content.kind === "media" ? localSource(content.localPath) : undefined;
  const previewSource = content.kind === "media"
    ? localSource(content.thumbnailPath) ?? content.previewDataUrl
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
  const mediaLayout = content.kind === "media" && isVisual
    ? fitMediaLayout(
        content.mediaType,
        measuredSize?.width ?? content.width,
        measuredSize?.height ?? content.height,
      )
    : undefined;

  useLayoutEffect(() => {
    setTextExpanded(false);
  }, [collapseThresholdLines, collapsedLines, content, message.id]);

  useLayoutEffect(() => {
    const flow = textFlowRef.current;
    if (content.kind !== "text" || !flow) {
      setTextLineCount(0);
      setCollapsedTextHeight(0);
      return;
    }
    const measure = () => {
      const text = flow.querySelector<HTMLElement>(".message-rich-text");
      if (!text) return;
      const computed = getComputedStyle(text);
      const parsedLineHeight = Number.parseFloat(computed.lineHeight);
      const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : Number.parseFloat(computed.fontSize) * 1.48;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((left, right) => left.top - right.top || left.left - right.left);
      const lineTops: number[] = [];
      for (const rect of rects) {
        if (!lineTops.some((top) => Math.abs(top - rect.top) < 1.5)) lineTops.push(rect.top);
      }
      const rectHeight = rects.length > 0
        ? Math.max(...rects.map((rect) => rect.bottom)) - Math.min(...rects.map((rect) => rect.top))
        : 0;
      const lineCount = Math.max(lineTops.length, Math.ceil(rectHeight / lineHeight));
      setTextLineCount((current) => current === lineCount ? current : lineCount);
      const nextHeight = lineHeight * collapsedLines;
      setCollapsedTextHeight((current) => Math.abs(current - nextHeight) < 0.25
        ? current
        : nextHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(flow);
    return () => observer.disconnect();
  }, [collapsedLines, content]);

  useLayoutEffect(() => {
    const flow = textFlowRef.current;
    const hasInlineCaption = isVisual && hasCaption;
    if ((content.kind !== "text" && !hasInlineCaption) || !flow) return;
    if (textCollapsible) {
      setMetaWrapped(true);
      setMetaInlineOffset(0);
      return;
    }

    const measure = () => {
      const text = flow.querySelector<HTMLElement>(".message-rich-text");
      const meta = flow.querySelector<HTMLElement>(".message-meta");
      if (!text || !meta) return;
      const range = document.createRange();
      range.selectNodeContents(text);
      const lastLine = [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1);
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
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(flow);
    return () => observer.disconnect();
  }, [content, hasCaption, isVisual, message.delivery, message.editedAt, message.sentAt, textCollapsible]);
  const visualShellStyle = mediaLayout
    ? {
        "--visual-media-width": `${mediaLayout.width}px`,
        "--visual-media-height": mediaLayout.height ? `${mediaLayout.height}px` : undefined,
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
  };
  const fileProgress = (content.kind === "file" || content.kind === "media") && content.progress !== undefined
    ? `${Math.round(content.progress * 100)}%`
    : undefined;
  const transferProgress = content.kind === "file" || content.kind === "media"
    ? content.progress ?? 0
    : 0;
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
    !content.isDownloading;
  const canCancelUpload = (content.kind === "file" || content.kind === "media") &&
    content.isUploading === true;
  const canCancelDownload = (content.kind === "file" || content.kind === "media") &&
    downloadFileId !== undefined && content.isDownloading === true;
  const localFilePath = content.kind === "file" || content.kind === "media"
    ? content.localPath
    : undefined;
  const canOpenFile = (content.kind === "file" || content.kind === "media") &&
    content.isDownloaded === true && Boolean(localFilePath);
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
    rowRef.current = element;
    lazyMediaRef.current = element;
  }, [lazyMediaRef]);

  const selectionDisabled = selectionPending ||
    message.permissions?.canForward === false ||
    (selectionLimitReached && !selected);
  const reactions = message.interaction?.reactions ?? [];

  const toggleReaction = async (emoji: string, chosen: boolean) => {
    if (reactionPending) return;
    setReactionPending(emoji);
    try {
      await onReaction(message.id, emoji, chosen);
    } finally {
      setReactionPending(undefined);
    }
  };

  const copyUnsupportedMessage = async () => {
    if (content.kind !== "unsupported") return;
    try {
      await writeClipboardText(content.raw);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const messageMeta = !isService ? (
    <span className="message-meta">
      {message.editedAt && <span>已编辑</span>}
      {message.isPinned && <Pin size={13} strokeWidth={2} aria-label="已置顶" />}
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
  ) : null;

  return (
    <article
      ref={setMessageRowRef}
      className={`message-row group-${groupPosition} ${message.outgoing ? "is-outgoing" : "is-incoming"} ${message.isRemoving ? "is-removing" : ""} ${entranceKindRef.current ? `is-entering-${entranceKindRef.current}` : ""} ${isService ? "is-service" : ""} ${content.kind === "unsupported" ? "is-unsupported" : ""} ${selected ? "is-selected" : ""} ${highlighted ? "is-notification-target" : ""} ${albumItem ? "is-album-item" : ""}`}
      data-message-id={message.id}
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName.startsWith("message-enter-") &&
          entranceKindRef.current
        ) {
          event.currentTarget.classList.remove(`is-entering-${entranceKindRef.current}`);
        }
      }}
    >
      {selectionMode && !isService && (
        <button
          className="message-selection-toggle"
          type="button"
          aria-label={selected ? "取消选择消息" : "选择消息"}
          aria-pressed={selected}
          title={message.permissions?.canForward === false ? "此消息不可转发" : selected ? "取消选择" : "选择消息"}
          disabled={selectionDisabled}
          onClick={() => void onToggleSelection(message)}
        >
          {selectionPending
            ? <LoaderCircle className="spin" size={15} />
            : selected && <Check size={15} strokeWidth={2.4} />}
        </button>
      )}
      <div
        className={`message-bubble-shell ${isVisual ? "is-visual-shell" : ""} ${visualSizingText ? "is-text-sized-visual" : ""} ${message.replyMarkup ? "has-inline-keyboard" : ""}`}
        style={visualShellStyle}
        data-visual-sizing-text={visualSizingText}
        tabIndex={!selectionMode && !isService ? 0 : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          if (isService) return;
          if (selectionMode) void onToggleSelection(message);
          else void onOpenActions(message, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (selectionMode || isService) return;
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const left = message.outgoing ? bounds.left - 184 : bounds.right + 4;
          void onOpenActions(message, left, bounds.top, event.currentTarget);
        }}
      >
        <div className={`message-bubble ${isVisual ? "is-photo" : ""} ${content.kind === "media" ? `media-bubble-${content.mediaType}` : ""} ${hasCaption ? "has-caption" : ""} ${content.kind === "text" || content.kind === "rich" ? "is-textual" : ""} ${content.kind === "text" && metaWrapped ? "has-wrapped-meta" : ""}`}>
          {!albumItem && !isService && forwardLabel && (
            <span className="message-forward-label">
              <Forward size={12} strokeWidth={2} />
              {forwardLabel}
            </span>
          )}
          {!isService && showSender && (
            <div className="message-sender-row">
              {senderProfileAvailable ? (
                <button
                  className="message-sender"
                  type="button"
                  onClick={() => onOpenSenderProfile(message.senderId)}
                >
                  <span>{senderName}</span>
                </button>
              ) : <span className="message-sender"><span>{senderName}</span></span>}
              {senderLabel && <small className="message-sender-label">{senderLabel}</small>}
            </div>
          )}
          {!albumItem && !isService && replyPreview && (
            <button
              className="message-reply-preview"
              type="button"
              disabled={!replyPreview.messageId}
              onClick={() => {
                if (replyPreview.chatId && replyPreview.messageId) {
                  onOpenReply(replyPreview.chatId, replyPreview.messageId);
                }
              }}
            >
              <strong>{replyPreview.author}</strong>
              <small>{replyPreview.text}</small>
            </button>
          )}
          {content.kind === "text" ? (
            <div
              ref={textFlowRef}
              className={`message-text-flow ${isLargeEmojiText(content.text) ? "is-large-emoji" : ""} ${metaWrapped ? "is-meta-wrapped" : ""} ${textCollapsible ? "is-text-collapsible" : ""} ${textCollapsible && !textExpanded ? "is-text-collapsed" : ""}`}
              data-message-line-count={textLineCount || undefined}
              style={{
                "--message-meta-inline-offset": `${metaInlineOffset}px`,
                "--collapsed-message-height": `${collapsedTextHeight}px`,
              } as CSSProperties}
            >
              <MessageRichText text={content.text} entities={content.entities} />
              {textCollapsible && !textExpanded && (
                <button
                  className="long-message-expand"
                  type="button"
                  onClick={() => {
                    setTextExpanded(true);
                    requestAnimationFrame(() => onExpandLongText(message.id));
                  }}
                >
                  <ChevronDown size={15} strokeWidth={2} />
                  展开全文
                </button>
              )}
              {messageMeta}
            </div>
          ) : content.kind === "rich" ? (
            <RichMessageContent
              blocks={content.blocks}
              isRtl={content.isRtl}
              isFull={content.isFull}
              messageId={message.id}
              onDownload={onDownload}
              onCancelDownload={onCancelDownload}
              onStream={onStream}
              onSuspendStream={onSuspendStream}
            />
          ) : content.kind === "service" ? (
            <p>{content.text}</p>
          ) : content.kind === "unsupported" ? (
            developerMode ? (
              <button
                className="unknown-message-copy"
                type="button"
                aria-label={`复制 ${content.type} 原始消息`}
                title="复制原始消息"
                onClick={() => void copyUnsupportedMessage()}
              >
                {copyState === "copied"
                  ? <Check size={13} strokeWidth={2.3} />
                  : copyState === "error"
                    ? <AlertCircle size={13} strokeWidth={2.1} />
                    : <Copy size={13} strokeWidth={2} />}
                <span>{copyState === "copied"
                  ? "已复制原始消息"
                  : copyState === "error" ? "复制失败，请重试" : content.text}</span>
              </button>
            ) : <p>{content.text}</p>
          ) : isVisual && content.kind === "media" ? (
            <div className={`photo-message media-${content.mediaType}`} data-media-type={content.mediaType}>
              <div
                className={`photo-preview ${mediaLayout?.aspectRatio ? "has-media-ratio" : ""} ${content.mediaType === "photo" && usablePreviewSource && !usableFullMediaSource ? "is-preview-only" : ""}`}
                style={mediaLayout?.aspectRatio
                  ? { aspectRatio: mediaLayout.aspectRatio }
                  : undefined}
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
                  <video
                    src={usableFullMediaSource}
                    poster={usablePreviewSource}
                    autoPlay={autoplayAnimations}
                    loop
                    muted
                    playsInline
                    aria-label={content.caption || content.fileName}
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
                    autoplay={autoplayAnimations}
                    onError={() => markMediaSourceFailed(usableFullMediaSource)}
                  />
                ) : usableFullMediaSource && content.mediaType === "animation" && /^video\//i.test(content.mimeType ?? "") ? (
                  <video
                    src={usableFullMediaSource}
                    poster={usablePreviewSource}
                    autoPlay={autoplayAnimations}
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
                  <img
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
                    aria-label={`查看图片 ${content.fileName}`}
                    onClick={() => onOpenMedia(message.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpenMedia(message.id);
                    }}
                  >
                    <img
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
                  <img
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
                ) : content.mediaType === "photo" && onOpenMedia ? (
                  <button
                    className="photo-open"
                    type="button"
                    aria-label={`查看图片 ${content.fileName}`}
                    onClick={() => onOpenMedia(message.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpenMedia(message.id);
                    }}
                  >
                    <span className="photo-placeholder" aria-label="媒体正在加载">
                      <ImageIcon size={28} strokeWidth={1.6} />
                    </span>
                  </button>
                ) : (
                  <span className="photo-placeholder" aria-label="媒体正在加载">
                    <ImageIcon size={28} strokeWidth={1.6} />
                  </span>
                )}
                {canDownload && !["video", "videoNote"].includes(content.mediaType) && (
                  <button
                    className="media-download"
                    type="button"
                    aria-label={`下载 ${downloadFileName}`}
                    title="下载媒体"
                    onClick={() => void onDownload(downloadFileId!, downloadFileName)}
                  >
                    {previewSource ? <Play size={19} fill="currentColor" /> : <Download size={19} />}
                  </button>
                )}
                {(content.isDownloading || content.isUploading) && (
                  <span
                    className="media-progress"
                    role="progressbar"
                    aria-label={`${content.isUploading ? "上传" : "下载"} ${downloadFileName}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(transferProgress * 100)}
                  >
                    {(canCancelUpload || canCancelDownload) && (
                      <button type="button" aria-label={`${canCancelUpload ? "取消上传" : "取消下载"} ${downloadFileName}`} title={canCancelUpload ? "取消上传" : "取消下载"} onClick={() => canCancelUpload ? void onCancelUpload(message.id) : void onCancelDownload(downloadFileId!)}>
                        <MediaProgressRing progress={transferProgress} size={30} />
                        <X className="media-progress-cancel" size={14} strokeWidth={2.2} />
                      </button>
                    )}
                    {!canCancelUpload && !canCancelDownload && (
                      <span><MediaProgressRing progress={transferProgress} /></span>
                    )}
                  </span>
                )}
              </div>
              {hasCaption && content.caption && (
                <div
                  ref={textFlowRef}
                  className={`message-text-flow photo-caption-flow ${metaWrapped ? "is-meta-wrapped" : ""}`}
                  style={{ "--message-meta-inline-offset": `${metaInlineOffset}px` } as CSSProperties}
                >
                  <MessageRichText
                    className="photo-caption"
                    text={content.caption}
                    entities={content.captionEntities}
                  />
                  {messageMeta}
                </div>
              )}
            </div>
          ) : content.kind === "poll" ? (
            <PollMessage poll={content} messageId={message.id} onAnswer={onPollAnswer} />
          ) : content.kind === "media" && ["audio", "voice"].includes(content.mediaType) ? (
            <div className="attachment-message">
              <div className="audio-message">
                <span className="file-icon"><AudioLines size={19} strokeWidth={1.8} /></span>
                <span className="file-copy">
                  <strong>{content.fileName}</strong>
                  <small>{content.sizeLabel}</small>
                </span>
                <AudioPlayer
                  source={fullMediaSource}
                  playbackId={`${message.chatId}:${message.id}`}
                  label={content.fileName}
                  fileId={content.fileId}
                  size={content.size}
                  mimeType={content.mimeType}
                  durationHint={content.duration}
                  nextPlaybackId={nextAudioPlaybackId}
                  downloadProgress={content.progress}
                  onRequestStream={onStream}
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
                  className="attachment-caption"
                  text={content.caption}
                  entities={content.captionEntities}
                />
              )}
            </div>
          ) : (
            <div className="attachment-message">
              <div className="file-message">
                <span className="file-icon"><FileText size={19} strokeWidth={1.8} /></span>
                <span className="file-copy">
                  <strong>{content.fileName}</strong>
                  <small>{content.isUploading ? `上传中 ${fileProgress ?? ""}` : content.isDownloading ? `下载中 ${fileProgress ?? ""}` : message.delivery === "failed" ? "发送失败" : content.isDownloaded ? `已缓存 · ${content.sizeLabel}` : content.sizeLabel}</small>
                </span>
                <span className="file-actions">
                  {canOpenFile && <button type="button" aria-label={`打开 ${content.fileName}`} title="打开文件" onClick={() => void onOpenFile(localFilePath!)}><ExternalLink size={15} /></button>}
                  {canOpenFile && <button type="button" aria-label={`另存为 ${content.fileName}`} title="另存为" onClick={() => void onSaveFileAs(localFilePath!, content.fileName)}><Save size={15} /></button>}
                  {canOpenFile && <button type="button" aria-label="打开下载目录" title="打开下载目录" onClick={() => void onOpenDownloadDirectory()}><FolderOpen size={15} /></button>}
                  {(canDownload || canCancelUpload || canCancelDownload) && (
                    <button
                      type="button"
                      aria-label={canCancelUpload ? `取消上传 ${content.fileName}` : canCancelDownload ? `取消下载 ${content.fileName}` : `下载 ${content.fileName}`}
                      title={canCancelUpload ? "取消上传" : canCancelDownload ? "取消下载" : "下载到 downloads"}
                      onClick={() => canCancelUpload ? void onCancelUpload(message.id) : canCancelDownload ? void onCancelDownload(downloadFileId!) : void onDownload(downloadFileId!, downloadFileName)}
                    >
                      {canCancelUpload || canCancelDownload ? <X size={16} strokeWidth={2.2} /> : <Download size={16} strokeWidth={2} />}
                    </button>
                  )}
                </span>
              </div>
              {content.caption && (
                <MessageRichText
                  className="attachment-caption"
                  text={content.caption}
                  entities={content.captionEntities}
                />
              )}
            </div>
          )}
          {content.kind !== "text" && !(isVisual && hasCaption) && messageMeta}
        </div>
        {!albumItem && !selectionMode && message.replyMarkup && (
          <InlineKeyboard
            messageId={message.id}
            markup={message.replyMarkup}
            onCallback={onBotCallback}
            onOpenUser={onOpenSenderProfile}
          />
        )}
        {!albumItem && !selectionMode && !isService && reactions.length > 0 && (
          <div className="message-reactions">
            {reactions.map((reaction) => {
              const label = reactionLabel(reaction);
              const emoji = reaction.type.kind === "emoji" ? reaction.type.emoji : undefined;
              return (
                <button
                  type="button"
                  className={reaction.chosen ? "is-chosen" : ""}
                  key={reaction.type.kind === "customEmoji"
                    ? reaction.type.customEmojiId
                    : `${reaction.type.kind}:${label}`}
                  aria-pressed={reaction.chosen}
                  aria-label={`${label}，${reaction.totalCount} 个回应`}
                  disabled={!emoji || reactionPending === emoji}
                  onClick={() => emoji && void toggleReaction(emoji, !reaction.chosen)}
                >
                  {reactionPending === emoji ? <LoaderCircle className="spin" size={12} /> : label}
                  <span>{reaction.totalCount}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {channelPostTarget && !selectionMode && !isService && (
        <button
          className="channel-post-jump"
          type="button"
          aria-label="前往频道原消息"
          title="前往频道原消息"
          onClick={() => onOpenReply(channelPostTarget.chatId, channelPostTarget.messageId)}
        >
          <CircleArrowRight size={22} strokeWidth={2.2} />
        </button>
      )}
    </article>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
