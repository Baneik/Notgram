import { translate } from "../i18n";
import { List } from "lucide-react";
import type { Message } from "../telegram/types";
import { messageSummary } from "./conversationMessages";

interface PinnedMessageBannerProps {
  messages: Message[];
  message?: Message;
  onOpenAll: (messages: Message[]) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

export function PinnedMessageBanner({
  messages,
  message,
  onOpenAll,
  onOpenMessage,
}: PinnedMessageBannerProps) {
  if (!message) return null;

  return (
    <div className="pinned-message-banner" aria-label={translate("置顶消息")}>
      <button
        className="pinned-message-preview"
        type="button"
        title={translate("定位到这条置顶消息")}
        onClick={() => onOpenMessage(message.chatId, message.id)}
      >
        <span className="pinned-message-marker" aria-hidden="true" />
        <span className="pinned-message-copy">
          <strong>{translate("置顶消息")}</strong>
          <span>{messageSummary(message.content)}</span>
        </span>
      </button>
      <button
        className="pinned-message-entry"
        type="button"
        aria-label={translate("查看全部置顶消息")}
        title={translate("查看全部置顶消息")}
        onClick={() => onOpenAll(messages)}
      >
        <List size={17} strokeWidth={1.9} />
        <span>{translate("全部")}</span>
      </button>
    </div>
  );
}
