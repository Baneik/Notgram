import {
  Check,
  CheckCheck,
  ChevronLeft,
  FileText,
  MoreVertical,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Message, User } from "../telegram/types";
import { formatMessageTime } from "../utils/formatters";
import { Avatar } from "./Avatar";

interface ConversationProps {
  chat?: Chat;
  messages: Message[];
  users: Map<string, User>;
  onSendMessage: (text: string) => Promise<void>;
  onSendFile: (file: File) => Promise<void>;
  onBack: () => void;
}

export function Conversation({
  chat,
  messages,
  users,
  onSendMessage,
  onSendFile,
  onBack,
}: ConversationProps) {
  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(() => {
    const query = messageSearch.trim().toLocaleLowerCase();
    if (!query) return messages;
    return messages.filter((message) => {
      if (message.content.kind === "file") {
        return message.content.fileName.toLocaleLowerCase().includes(query);
      }
      return message.content.text.toLocaleLowerCase().includes(query);
    });
  }, [messageSearch, messages]);

  useEffect(() => {
    if (messageListRef.current && !messageSearch) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages, messageSearch]);

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
    if (!draft.trim()) return;
    await onSendMessage(draft);
    setDraft("");
  };

  return (
    <section className="conversation" aria-label={`${chat.title} 对话`}>
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

      <div className="message-list" ref={messageListRef}>
        <div className="message-day">今天</div>
        {visibleMessages.length === 0 ? (
          <div className="messages-empty">没有匹配的消息</div>
        ) : (
          visibleMessages.map((message) => (
            <MessageBubble key={message.id} message={message} sender={users.get(message.senderId)} />
          ))
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
            disabled={!draft.trim()}
            onClick={submitMessage}
          >
            <Send size={19} strokeWidth={2} />
          </button>
        </div>
      </div>
    </section>
  );
}

function MessageBubble({ message, sender }: { message: Message; sender?: User }) {
  return (
    <article className={`message-row ${message.outgoing ? "is-outgoing" : ""}`}>
      <div className="message-bubble">
        {!message.outgoing && sender && <span className="message-sender">{sender.displayName}</span>}
        {message.content.kind === "text" ? (
          <p>{message.content.text}</p>
        ) : (
          <div className="file-message">
            <span className="file-icon"><FileText size={19} strokeWidth={1.8} /></span>
            <span className="file-copy"><strong>{message.content.fileName}</strong><small>{message.content.sizeLabel}</small></span>
          </div>
        )}
        <span className="message-meta">
          <time dateTime={message.sentAt}>{formatMessageTime(message.sentAt)}</time>
          {message.outgoing && (message.delivery === "read" ? <CheckCheck size={14} strokeWidth={2.2} /> : <Check size={14} strokeWidth={2.2} />)}
        </span>
      </div>
    </article>
  );
}
