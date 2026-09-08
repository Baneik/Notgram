import { AlertCircle, Check, CheckCheck, Eye, Forward, LoaderCircle, Pin, RotateCcw } from "lucide-react";
import { translate } from "../i18n";
import { useStableVisibility } from "../hooks/useStableVisibility";
import type { Message } from "../telegram/types";
import { formatCompactCount, formatMessageTime } from "../utils/formatters";

interface MessageMetadataProps {
  message: Message;
  channelPost?: boolean;
  showChannelMetadata?: boolean;
  channelAuthor?: string;
  onOpenAuthor?: () => void;
  onRetry: (messageId: string, chatId?: string) => Promise<void>;
}

/** Shared by individual messages and the footer of a channel media album. */
export function MessageMetadata({ message, channelPost, showChannelMetadata, channelAuthor, onOpenAuthor, onRetry }: MessageMetadataProps) {
  const showDeliveryPending = useStableVisibility(message.delivery === "sending", { minimumVisible: 220 });
  const sendFailureTitle = message.sendFailure?.needAnotherReplyQuote
    ? translate("引用内容已失效，请重新选择引用后发送")
    : message.sendFailure?.needDropReply
      ? translate("原回复目标已失效，请取消回复后重新发送")
      : message.sendFailure?.message || translate("发送失败");
  return (
    <span className={`message-meta ${channelPost ? "is-channel-meta" : ""}`}>
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
        {message.outgoing && (message.delivery === "read" ? <CheckCheck size={14} strokeWidth={2.2} />
          : message.delivery === "sending" ? (showDeliveryPending ? <LoaderCircle className="spin" size={13} strokeWidth={2} /> : <Check size={14} strokeWidth={2.2} />)
          : message.delivery === "failed" ? (
            <button className="message-retry" type="button" disabled={!message.canRetry} aria-label={translate("重试发送")}
              title={message.canRetry ? translate("重试发送：{{value0}}", { value0: sendFailureTitle }) : sendFailureTitle}
              onClick={() => void onRetry(message.id, message.chatId)}>
              {message.canRetry ? <RotateCcw size={13} strokeWidth={2.2} /> : <AlertCircle size={13} strokeWidth={2.2} />}
            </button>
          ) : <Check size={14} strokeWidth={2.2} />)}
      </span>
    </span>
  );
}
