import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronLeft,
  FileText,
  ImageIcon,
  Download,
  MoreVertical,
  LoaderCircle,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { Chat, Message, User } from "../telegram/types";
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
  onSendMessage: (text: string) => Promise<boolean>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onSendFile: (file: File) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onBack: () => void;
}

export function Conversation({
  chat,
  messages,
  users,
  historyLoading,
  hasOlderMessages,
  onSendMessage,
  onDownloadFile,
  onRetryMessage,
  onSendFile,
  onLoadOlder,
  onBack,
}: ConversationProps) {
  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
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

  const submitMessage = async () => {
    const submitted = draft.trim();
    if (!submitted || sending) return;
    setDraft("");
    setSending(true);
    const sent = await onSendMessage(submitted);
    setSending(false);
    if (!sent) {
      setDraft((current) => current ? `${submitted}\n${current}` : submitted);
    }
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
                      onDownload={onDownloadFile}
                      onRetry={onRetryMessage}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="composer-wrap">
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await onSendFile(file);
            event.target.value = "";
          }}
        />
        <div className="composer">
          <button className="icon-button" type="button" aria-label="表情" title="表情">
            <Smile size={21} strokeWidth={1.8} />
          </button>
          <button className="icon-button" type="button" aria-label="添加附件" title="添加附件" onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={20} strokeWidth={1.8} />
          </button>
          <textarea
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
            placeholder="写一条消息"
            aria-label="消息内容"
          />
          <button
            className="send-button icon-button"
            type="button"
            aria-label="发送消息"
            title="发送消息"
            disabled={!draft.trim() || sending}
            onClick={submitMessage}
          >
            <Send size={19} strokeWidth={2} />
          </button>
        </div>
      </div>
    </section>
  );
}

function MessageBubble({
  message,
  sender,
  senderName,
  groupPosition,
  onDownload,
  onRetry,
}: {
  message: Message;
  sender?: User;
  senderName: string;
  groupPosition: MessageGroupPosition;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
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
  return (
    <article className={`message-row group-${groupPosition} ${message.outgoing ? "is-outgoing" : "is-incoming"}`}>
      <div className={`message-bubble ${isPhoto ? "is-photo" : ""} ${hasCaption ? "has-caption" : ""}`}>
        {showSender && <span className="message-sender">{sender?.displayName ?? senderName}</span>}
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
              {message.content.isDownloading && (
                <span className="media-progress">
                  {message.content.progress === undefined
                    ? <LoaderCircle className="spin" size={15} />
                    : `${Math.round(message.content.progress * 100)}%`}
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
              <small>{message.content.isDownloading ? `下载中 ${fileProgress ?? ""}` : message.content.isDownloaded ? `已缓存 · ${message.content.sizeLabel}` : message.content.sizeLabel}</small>
            </span>
            {canDownload && (
              <button
                className="file-download"
                type="button"
                aria-label={`下载 ${message.content.fileName}`}
                title="下载到 downloads"
                onClick={() => void onDownload(downloadFileId!, downloadFileName)}
              >
                <Download size={16} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        <span className="message-meta">
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
    </article>
  );
}

const localSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};
