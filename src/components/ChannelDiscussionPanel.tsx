import { ChevronLeft, LoaderCircle, RotateCcw } from "lucide-react";
import { useRef } from "react";
import type { ConnectionStatus, Message, MessageReplyQuote, MessageTextEntity, OutgoingAttachment, User } from "../telegram/types";
import { messageSummary } from "./conversationMessages";
import { ConversationComposer } from "./ConversationComposer";
import { Avatar } from "./Avatar";
import { MessageBubblePreview, type MessageBubblePreviewProps } from "./MessageBubble";

interface ChannelDiscussionPanelProps {
  post: Message;
  channelTitle: string;
  comments: Message[];
  users: ReadonlyMap<string, User>;
  currentUserId: string;
  connectionStatus: ConnectionStatus;
  loading: boolean;
  loadError?: boolean;
  onRetry: () => void;
  onClose: () => void;
  onSend: (
    text: string,
    replyToMessageId?: string,
    replyQuote?: MessageReplyQuote,
    entities?: MessageTextEntity[],
  ) => Promise<boolean>;
  onSendFiles: (
    attachments: OutgoingAttachment[],
    caption?: string,
    captionEntities?: MessageTextEntity[],
  ) => Promise<boolean>;
  messagePreviewOptions?: Partial<Omit<MessageBubblePreviewProps, "message" | "senderName" | "users">>;
}

const senderFor = (message: Message, users: ReadonlyMap<string, User>, currentUserId: string) => {
  if (message.senderId === currentUserId || message.outgoing) return "你";
  if (message.senderId.startsWith("chat:")) return "频道管理员";
  return users.get(message.senderId)?.displayName ?? "Telegram 用户";
};

const avatarFor = (message: Message, users: ReadonlyMap<string, User>, currentUserId: string) => {
  if (message.senderId === currentUserId || message.outgoing) {
    return users.get(currentUserId)?.avatar ?? { label: "我", color: "#d16f45" };
  }
  return users.get(message.senderId)?.avatar ?? { label: "?", color: "#73828c" };
};

export function ChannelDiscussionPanel({
  post,
  channelTitle,
  comments,
  users,
  currentUserId,
  connectionStatus,
  loading,
  loadError = false,
  onRetry,
  onClose,
  onSend,
  onSendFiles,
  messagePreviewOptions,
}: ChannelDiscussionPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const postText = messageSummary(post.content);

  return (
    <section className="channel-discussion-panel" aria-label={`${channelTitle} 的讨论`}>
      <header className="channel-discussion-header">
        <button className="icon-button" type="button" aria-label="返回频道" title="返回频道" onClick={onClose}>
          <ChevronLeft size={21} strokeWidth={2} />
        </button>
        <div className="channel-discussion-heading">
          <strong>{channelTitle}</strong>
        </div>
      </header>

      <div className="channel-discussion-messages" role="log" aria-label="留言列表">
        <div className="channel-discussion-stream">
          <div className="channel-discussion-post" title={postText || "媒体帖子"}>
            <MessageBubblePreview
              message={post}
              senderName={channelTitle}
              users={users}
              channelPost
              showChannelMetadata
              {...messagePreviewOptions}
            />
          </div>

          {loading && comments.length === 0 ? (
            <div className="channel-discussion-empty" role="status">
              <LoaderCircle className="spin" size={18} />
              正在加载留言
            </div>
          ) : loadError && comments.length === 0 ? (
            <div className="channel-discussion-empty channel-discussion-error" role="alert">
              <span>留言加载失败</span>
              <button className="text-button" type="button" onClick={onRetry}>
                <RotateCcw size={14} strokeWidth={2} />重试
              </button>
            </div>
          ) : comments.length === 0 ? (
            <div className="channel-discussion-empty">还没有留言</div>
          ) : comments.map((comment) => {
            const senderName = senderFor(comment, users, currentUserId);
            return (
              <div className={`channel-discussion-message ${comment.outgoing ? "is-outgoing" : "is-incoming"}`} key={comment.id}>
                <Avatar avatar={avatarFor(comment, users, currentUserId)} size="small" />
                <div className="channel-discussion-message-main">
                  <MessageBubblePreview
                    message={comment}
                    senderName={senderName}
                    users={users}
                    {...messagePreviewOptions}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="channel-discussion-composer">
        <ConversationComposer
          chatId={post.chatId}
          draftKey={`${post.chatId}:discussion:${post.id}`}
          knownNonBotUsernames={new Set()}
          inputRef={inputRef}
          connectionStatus={connectionStatus}
          queuedMessageCount={0}
          failedQueuedMessageCount={0}
          queuedAttachmentCount={0}
          failedAttachmentCount={0}
          onSendMessage={onSend}
          onEditMessage={async () => false}
          onDraftChange={() => undefined}
          onTypingChange={async () => undefined}
          onSendFiles={onSendFiles}
          onCancelEditing={() => undefined}
          onCancelReply={() => undefined}
          onGetBotCommands={async () => []}
          onGetInlineResults={async () => undefined}
          onSendInlineResult={async () => false}
          onSendBotStart={async () => false}
        />
      </div>
    </section>
  );
}
