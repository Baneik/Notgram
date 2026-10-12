import type { Chat } from "../telegram/types";

interface ForumUnreadCount {
  serverCount: number;
  unreadCount: number;
  readBoundaries: Map<string, string>;
}

interface TopicReadCount {
  chatId: string;
  topicId: string;
  messageId: string;
  unreadCount: number;
  serverCount: number;
  previousUnreadCount: number;
  owner: ForumUnreadCount;
}

/** Reconciles independent TDLib group counts with acknowledged topic reads. */
export class ForumUnreadState {
  private counts = new Map<string, ForumUnreadCount>();

  reset() {
    this.counts.clear();
  }

  discard(chatId: string) {
    this.counts.delete(chatId);
  }

  seedChat(chat: Chat) {
    if (!this.counts.has(chat.id)) this.observeChat(chat);
  }

  readBoundary(chatId: string, topicId: string) {
    return this.counts.get(chatId)?.readBoundaries.get(topicId);
  }

  observeChat(chat: Chat): Chat {
    if (!chat.isForum) {
      this.discard(chat.id);
      return chat;
    }
    const previous = this.counts.get(chat.id);
    if (!previous) {
      this.counts.set(chat.id, {
        serverCount: chat.unreadCount,
        unreadCount: chat.unreadCount,
        readBoundaries: new Map(),
      });
      return chat;
    }
    // Increases represent new unread messages. Decreases first absorb topic
    // reads already reflected locally, so a later group ack cannot deduct twice.
    previous.unreadCount = chat.unreadCount > previous.serverCount
      ? previous.unreadCount + chat.unreadCount - previous.serverCount
      : Math.min(previous.unreadCount, chat.unreadCount);
    previous.serverCount = chat.unreadCount;
    return previous.unreadCount === chat.unreadCount ? chat : { ...chat, unreadCount: previous.unreadCount };
  }

  captureRead(chatId: string, topicId: string, messageId: string, unreadCount: number,
    previousMessageId?: string, unreadMessages = 0): TopicReadCount | undefined {
    const owner = this.counts.get(chatId);
    if (!owner) return undefined;
    const alreadyRead = previousMessageId !== undefined && owner.readBoundaries.get(topicId) === previousMessageId;
    return { chatId, topicId, messageId, unreadCount: alreadyRead ? unreadMessages : unreadCount,
      serverCount: owner.serverCount, previousUnreadCount: owner.unreadCount, owner };
  }

  acknowledgeRead(read: TopicReadCount | undefined): number | undefined {
    if (!read || this.counts.get(read.chatId) !== read.owner) return undefined;
    const count = read.owner;
    if (count.readBoundaries.get(read.topicId) !== read.messageId) {
      const alreadyDeducted = Math.max(0,
        read.previousUnreadCount + Math.max(0, count.serverCount - read.serverCount) - count.unreadCount);
      count.unreadCount = Math.max(0, count.unreadCount - Math.max(0, read.unreadCount - alreadyDeducted));
      count.readBoundaries.set(read.topicId, read.messageId);
    }
    return count.unreadCount;
  }

  reconcileTopics(chatId: string, unreadCount: number): number | undefined {
    const count = this.counts.get(chatId);
    if (!count) return undefined;
    // Only a complete, unfiltered list can account for every unread topic.
    // A stale list must not restore counts already acknowledged during this session.
    count.unreadCount = Math.min(count.unreadCount, unreadCount);
    return count.unreadCount;
  }
}
