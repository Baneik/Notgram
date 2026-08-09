import { List } from "lucide-react";
import type { Message } from "../telegram/types";
import { messageSummary } from "./conversationMessages";

interface PinnedMessageBannerProps {
  messages: Message[];
  onOpenAll: (messages: Message[]) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

export function PinnedMessageBanner({
  messages,
  onOpenAll,
  onOpenMessage,
}: PinnedMessageBannerProps) {
  const latestMessage = messages.at(-1);
  if (!latestMessage) return null;

  return (
    <div className="pinned-message-banner" aria-label="最新置顶消息">
      <button
        className="pinned-message-preview"
        type="button"
        title="定位到这条置顶消息"
        onClick={() => onOpenMessage(latestMessage.chatId, latestMessage.id)}
      >
        <span className="pinned-message-marker" aria-hidden="true" />
        <span className="pinned-message-copy">
          <strong>置顶消息</strong>
          <span>{messageSummary(latestMessage.content)}</span>
        </span>
      </button>
      <button
        className="pinned-message-entry"
        type="button"
        aria-label="查看全部置顶消息"
        title="查看全部置顶消息"
        onClick={() => onOpenAll(messages)}
      >
        <List size={17} strokeWidth={1.9} />
        <span>全部</span>
      </button>
    </div>
  );
}
