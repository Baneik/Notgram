import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  AlertCircle,
  AudioLines,
  Check,
  CheckCheck,
  Download,
  FileText,
  Forward,
  Image as ImageIcon,
  LoaderCircle,
  MoreHorizontal,
  Play,
  RotateCcw,
  SmilePlus,
  X,
} from "lucide-react";
import { useState } from "react";
import type { Message, MessageReaction, User } from "../telegram/types";
import { formatMessageTime } from "../utils/formatters";
import { isGroupFirst, type MessageGroupPosition } from "../utils/messageGrouping";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "👏", "😮"];

export interface ReplyPreview {
  author: string;
  text: string;
}

interface MessageBubbleProps {
  message: Message;
  sender?: User;
  senderName: string;
  groupPosition: MessageGroupPosition;
  replyPreview?: ReplyPreview;
  forwardLabel?: string;
  selectionMode: boolean;
  selected: boolean;
  selectionPending: boolean;
  selectionLimitReached: boolean;
  onToggleSelection: (message: Message) => Promise<void>;
  onOpenActions: (message: Message, left: number, top: number) => Promise<void>;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
  onCancelUpload: (messageId: string) => Promise<void>;
  onReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  autoplayAnimations: boolean;
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

export function MessageBubble({
  message,
  sender,
  senderName,
  groupPosition,
  replyPreview,
  forwardLabel,
  selectionMode,
  selected,
  selectionPending,
  selectionLimitReached,
  onToggleSelection,
  onOpenActions,
  onDownload,
  onRetry,
  onCancelUpload,
  onReaction,
  autoplayAnimations,
}: MessageBubbleProps) {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [reactionPending, setReactionPending] = useState<string>();
  const content = message.content;
  const isVisual = content.kind === "media" &&
    ["photo", "video", "videoNote", "animation", "sticker"].includes(content.mediaType);
  const hasCaption = content.kind === "media" && Boolean(content.caption);
  const showSender = !message.outgoing && isGroupFirst(groupPosition);
  const fullMediaSource = content.kind === "media" ? localSource(content.localPath) : undefined;
  const previewSource = content.kind === "media"
    ? localSource(content.thumbnailPath) ?? content.previewDataUrl
    : undefined;
  const fileProgress = content.kind !== "text" && content.progress !== undefined
    ? `${Math.round(content.progress * 100)}%`
    : undefined;
  const downloadFileId = content.kind !== "text" ? content.fileId : undefined;
  const downloadFileName = content.kind !== "text" ? content.fileName : "";
  const canDownload = content.kind !== "text" &&
    downloadFileId !== undefined &&
    content.canDownload !== false &&
    !content.isDownloaded &&
    !content.isDownloading;
  const canCancelUpload = content.kind !== "text" && content.isUploading === true;
  const selectionDisabled = selectionPending ||
    message.permissions?.canForward === false ||
    (selectionLimitReached && !selected);
  const reactions = message.interaction?.reactions ?? [];

  const toggleReaction = async (emoji: string, chosen: boolean) => {
    if (reactionPending) return;
    setReactionPending(emoji);
    try {
      await onReaction(message.id, emoji, chosen);
      setReactionPickerOpen(false);
    } finally {
      setReactionPending(undefined);
    }
  };

  return (
    <article
      className={`message-row group-${groupPosition} ${message.outgoing ? "is-outgoing" : "is-incoming"} ${selected ? "is-selected" : ""}`}
      data-message-id={message.id}
    >
      {selectionMode && (
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
        className="message-bubble-shell"
        onContextMenu={(event) => {
          event.preventDefault();
          if (selectionMode) void onToggleSelection(message);
          else void onOpenActions(message, event.clientX, event.clientY);
        }}
      >
        <div className={`message-bubble ${isVisual ? "is-photo" : ""} ${hasCaption ? "has-caption" : ""}`}>
          {forwardLabel && (
            <span className="message-forward-label">
              <Forward size={12} strokeWidth={2} />
              {forwardLabel}
            </span>
          )}
          {showSender && <span className="message-sender">{sender?.displayName ?? senderName}</span>}
          {replyPreview && (
            <span className="message-reply-preview">
              <strong>{replyPreview.author}</strong>
              <small>{replyPreview.text}</small>
            </span>
          )}
          {content.kind === "text" ? (
            <p>{content.text}</p>
          ) : isVisual && content.kind === "media" ? (
            <div className={`photo-message media-${content.mediaType}`} data-media-type={content.mediaType}>
              <div
                className="photo-preview"
                style={content.width && content.height
                  ? { aspectRatio: `${content.width} / ${content.height}` }
                  : undefined}
              >
                {fullMediaSource && ["video", "videoNote"].includes(content.mediaType) ? (
                  <video src={fullMediaSource} poster={previewSource} controls preload="metadata" playsInline />
                ) : fullMediaSource && content.mediaType === "animation" ? (
                  <video
                    src={fullMediaSource}
                    poster={previewSource}
                    autoPlay={autoplayAnimations}
                    loop
                    muted
                    playsInline
                  />
                ) : fullMediaSource || previewSource ? (
                  <img
                    src={fullMediaSource ?? previewSource}
                    alt={content.caption || content.fileName}
                  />
                ) : (
                  <span className="photo-placeholder" aria-label="媒体正在加载">
                    <ImageIcon size={28} strokeWidth={1.6} />
                  </span>
                )}
                {canDownload && (
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
                    <span>{content.progress === undefined
                      ? <LoaderCircle className="spin" size={15} />
                      : `${Math.round(content.progress * 100)}%`}</span>
                    {canCancelUpload && (
                      <button type="button" aria-label={`取消上传 ${downloadFileName}`} title="取消上传" onClick={() => void onCancelUpload(message.id)}>
                        <X size={14} strokeWidth={2.2} />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {content.caption && <p className="photo-caption">{content.caption}</p>}
            </div>
          ) : content.kind === "media" && ["audio", "voice"].includes(content.mediaType) ? (
            <div className="audio-message">
              <span className="file-icon"><AudioLines size={19} strokeWidth={1.8} /></span>
              <span className="file-copy">
                <strong>{content.fileName}</strong>
                <small>{content.caption || content.sizeLabel}</small>
              </span>
              {fullMediaSource ? (
                <audio src={fullMediaSource} controls preload="metadata" />
              ) : canDownload ? (
                <button className="file-download" type="button" aria-label={`下载 ${content.fileName}`} title="下载音频" onClick={() => void onDownload(downloadFileId!, downloadFileName)}>
                  <Download size={16} strokeWidth={2} />
                </button>
              ) : content.isDownloading ? <LoaderCircle className="spin" size={16} /> : null}
            </div>
          ) : (
            <div className="file-message">
              <span className="file-icon"><FileText size={19} strokeWidth={1.8} /></span>
              <span className="file-copy">
                <strong>{content.fileName}</strong>
                <small>{content.isUploading ? `上传中 ${fileProgress ?? ""}` : content.isDownloading ? `下载中 ${fileProgress ?? ""}` : message.delivery === "failed" ? "发送失败" : content.isDownloaded ? `已缓存 · ${content.sizeLabel}` : content.sizeLabel}</small>
              </span>
              {(canDownload || canCancelUpload) && (
                <button
                  className="file-download"
                  type="button"
                  aria-label={canCancelUpload ? `取消上传 ${content.fileName}` : `下载 ${content.fileName}`}
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
        {!selectionMode && (
          <div className={`message-reactions ${reactions.length === 0 ? "is-empty" : ""}`}>
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
            <div className="reaction-picker-wrap">
              <button
                type="button"
                className="reaction-add"
                aria-label="添加表情回应"
                title="添加表情回应"
                aria-expanded={reactionPickerOpen}
                onClick={() => setReactionPickerOpen((open) => !open)}
              >
                <SmilePlus size={14} />
              </button>
              {reactionPickerOpen && (
                <div className="reaction-picker" role="menu" aria-label="选择表情回应">
                  {QUICK_REACTIONS.map((emoji) => {
                    const existing = reactions.find(
                      (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
                    );
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        key={emoji}
                        aria-label={`回应 ${emoji}`}
                        disabled={Boolean(reactionPending)}
                        onClick={() => void toggleReaction(emoji, !existing?.chosen)}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {!selectionMode && <button
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
        </button>}
      </div>
    </article>
  );
}
