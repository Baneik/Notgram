import { AlertCircle, Check, CheckCheck, Clock3, LoaderCircle, RotateCcw } from "lucide-react";
import { translate } from "../i18n";
import { useStableVisibility } from "../hooks/useStableVisibility";
import type { Message } from "../telegram/types";
import { messageDeliveryState } from "../utils/messageMetadata";

interface Props {
  messages: readonly Message[];
  channelPost?: boolean;
  onRetry: (messageId: string, chatId?: string) => Promise<void>;
}

export function MessageDeliveryStatus({ messages, channelPost, onRetry }: Props) {
  const delivery = messageDeliveryState(messages, channelPost);
  const showSpinner = useStableVisibility(delivery === "sending", { minimumVisible: 220 });
  if (!delivery) return null;
  const failed = messages.filter(message => message.outgoing && message.delivery === "failed");
  const retryable = failed.filter(message => message.canRetry);
  const failure = failed[0];
  const failureTitle = failed.length > 1
    ? translate("{{value0}} 条消息发送失败", { value0: failed.length })
    : failure?.sendFailure?.needAnotherReplyQuote
    ? translate("引用内容已失效，请重新选择引用后发送")
    : failure?.sendFailure?.needDropReply
      ? translate("原回复目标已失效，请取消回复后重新发送")
      : failure?.sendFailure?.message || translate("发送失败");
  const label = delivery === "failed" ? failureTitle
    : delivery === "sending" ? translate("正在发送")
      : delivery === "read" ? translate("对方已读")
        : channelPost ? translate("帖子已发布") : translate("消息已发送");
  return (
    <span className="message-delivery-status" data-delivery={delivery} title={label} aria-label={label}
      role={delivery === "failed" ? undefined : "img"}>
      {delivery === "failed" ? (
        <button className="message-retry" type="button" disabled={!retryable.length} aria-label={translate("重试发送")}
          title={retryable.length ? translate("重试发送：{{value0}}", { value0: failureTitle }) : failureTitle}
          onClick={() => void Promise.allSettled(retryable.map(message => onRetry(message.id, message.chatId)))}>
          {retryable.length ? <RotateCcw size={13} strokeWidth={2.2} /> : <AlertCircle size={13} strokeWidth={2.2} />}
        </button>
      ) : delivery === "sending" ? (showSpinner
        ? <LoaderCircle className="spin" size={13} strokeWidth={2} />
        : <Clock3 size={13} strokeWidth={2} />)
        : delivery === "read" ? <CheckCheck size={14} strokeWidth={2.2} /> : <Check size={14} strokeWidth={2.2} />}
    </span>
  );
}
