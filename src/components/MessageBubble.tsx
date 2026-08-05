import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  AlertCircle,
  AudioLines,
  Check,
  CheckCheck,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Forward,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
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
import { shouldAutoDownload, type AutoDownloadPolicy } from "../media/autoDownload";
import type { MessageEntrance } from "../utils/messageEntrance";

const MEDIA_PREFETCH_ROOT_MARGIN = "1200px 0px 360px 0px";

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
  onOpenReply,
  onOpenSenderProfile,
  onOpenMedia,
  albumItem = false,
  autoplayAnimations,
  autoDownloadPolicy,
  developerMode,
}: MessageBubbleProps) {
  const [entering, setEntering] = useState(Boolean(entrance));
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
  const content = message.content;
  const isService = content.kind === "service" || content.kind === "unsupported";
  const isVisual = content.kind === "media" &&
    ["photo", "video", "videoNote", "animation", "sticker"].includes(content.mediaType);
  const hasCaption = !albumItem && content.kind === "media" && Boolean(content.caption);
  const showSender = !albumItem && !message.outgoing && isGroupFirst(groupPosition);
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
  const visualShellStyle = mediaLayout
    ? { "--visual-media-width": `${mediaLayout.width}px` } as CSSProperties
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
  const lazyMediaFileId = previewFileId ?? automaticFileId;
  const lazyMediaIsThumbnail = content.kind === "media" &&
    lazyMediaFileId !== undefined && lazyMediaFileId === content.thumbnailFileId;
  const lazyMediaRef = useVisibleFile<HTMLElement>(
    lazyMediaFileId,
    lazyMediaFileId !== undefined &&
      (lazyMediaIsThumbnail || automaticFileId !== undefined),
    lazyMediaIsThumbnail ? 20 : 18,
    MEDIA_PREFETCH_ROOT_MARGIN,
  );
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

  return (
    <article
      ref={lazyMediaRef}
      className={`message-row group-${groupPosition} ${message.outgoing ? "is-outgoing" : "is-incoming"} ${entering ? `is-entering-${entrance}` : ""} ${isService ? "is-service" : ""} ${content.kind === "unsupported" ? "is-unsupported" : ""} ${selected ? "is-selected" : ""} ${highlighted ? "is-notification-target" : ""} ${albumItem ? "is-album-item" : ""}`}
      data-message-id={message.id}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false);
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
        className={`message-bubble-shell ${isVisual ? "is-visual-shell" : ""}`}
        style={visualShellStyle}
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
        <div className={`message-bubble ${isVisual ? "is-photo" : ""} ${content.kind === "media" ? `media-bubble-${content.mediaType}` : ""} ${hasCaption ? "has-caption" : ""} ${content.kind === "text" || content.kind === "rich" ? "is-textual" : ""}`}>
          {!albumItem && !isService && forwardLabel && (
            <span className="message-forward-label">
              <Forward size={12} strokeWidth={2} />
              {forwardLabel}
            </span>
          )}
          {!isService && showSender && (
            senderProfileAvailable ? (
              <button
                className="message-sender"
                type="button"
                onClick={() => onOpenSenderProfile(message.senderId)}
              >
                {senderName}
              </button>
            ) : <span className="message-sender">{senderName}</span>
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
            <MessageRichText text={content.text} entities={content.entities} />
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
                className={`photo-preview ${mediaLayout?.aspectRatio ? "has-media-ratio" : ""} ${usablePreviewSource && !usableFullMediaSource ? "is-preview-only" : ""}`}
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
                ) : usableFullMediaSource && content.mediaType === "animation" ? (
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
                ) : imageMediaSource && content.mediaType === "photo" && onOpenMedia ? (
                  <button
                    className="photo-open"
                    type="button"
                    aria-label={`查看图片 ${content.fileName}`}
                    onClick={() => onOpenMedia(message.id)}
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
                  <span className="media-progress">
                    {(canCancelUpload || canCancelDownload) && (
                      <button type="button" aria-label={`${canCancelUpload ? "取消上传" : "取消下载"} ${downloadFileName}`} title={canCancelUpload ? "取消上传" : "取消下载"} onClick={() => canCancelUpload ? void onCancelUpload(message.id) : void onCancelDownload(downloadFileId!)}>
                        <LoaderCircle className="spin" size={30} strokeWidth={1.8} />
                        <X className="media-progress-cancel" size={14} strokeWidth={2.2} />
                      </button>
                    )}
                    {!canCancelUpload && !canCancelDownload && (
                      <span><LoaderCircle className="spin" size={28} strokeWidth={1.8} /></span>
                    )}
                  </span>
                )}
              </div>
              {hasCaption && content.caption && (
                <MessageRichText
                  className="photo-caption"
                  text={content.caption}
                  entities={content.captionEntities}
                />
              )}
            </div>
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
          {!isService && <span className="message-meta">
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
          </span>}
        </div>
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
    </article>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
