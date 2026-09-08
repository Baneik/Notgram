import { Eye, Forward, Pin } from "lucide-react";
import { translate } from "../i18n";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import "./messageMetadata.css";
import type { Message } from "../telegram/types";
import { formatCompactCount, formatMessageTime } from "../utils/formatters";

interface MessageMetadataProps {
  message: Message;
  channelPost?: boolean;
  showChannelMetadata?: boolean;
  channelAuthor?: string;
  onOpenAuthor?: () => void;
  deliveryMessages?: readonly Message[];
  onRetry: (messageId: string, chatId?: string) => Promise<void>;
}

/** Owns metadata semantics and color; hosts control only placement and spacing. */
export function MessageMetadata({ message, channelPost, showChannelMetadata, channelAuthor, onOpenAuthor, deliveryMessages, onRetry }: MessageMetadataProps) {
  const context = channelPost ? "channel" : message.outgoing ? "outgoing" : "incoming";
  return (
    <span className={`message-meta ${channelPost ? "is-channel-meta" : ""}`} data-context={context}>
      <span className="message-meta-stats">
        {showChannelMetadata && message.interaction && <>
          <span className="message-meta-stat" aria-label={translate("转发 {{value0}} 次", { value0: message.interaction.forwardCount })}>
            <Forward size={12} strokeWidth={2} />{formatCompactCount(message.interaction.forwardCount)}
          </span>
          <span className="message-meta-stat" aria-label={translate("{{value0}} 次观看", { value0: message.interaction.viewCount })}>
            <Eye size={13} strokeWidth={2} />{formatCompactCount(message.interaction.viewCount)}
          </span>
        </>}
        {showChannelMetadata && channelAuthor && (onOpenAuthor ? (
          <button className="message-channel-author" type="button"
            aria-label={translate("打开频道原消息：{{value0}}", { value0: channelAuthor })} onClick={onOpenAuthor}>
            {channelAuthor}
          </button>
        ) : <span className="message-channel-author">{channelAuthor}</span>)}
      </span>
      <span className="message-meta-status">
        {message.editedAt && <span>{translate("已编辑")}</span>}
        {message.isPinned && <Pin size={13} strokeWidth={2} aria-label={translate("已置顶")} />}
        <time dateTime={message.sentAt}>{formatMessageTime(message.sentAt)}</time>
        <MessageDeliveryStatus messages={deliveryMessages ?? [message]} channelPost={channelPost} onRetry={onRetry} />
      </span>
    </span>
  );
}
