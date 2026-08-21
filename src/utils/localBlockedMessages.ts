import type { Message } from "../telegram/types";

export interface LocalBlockedMessageGroup {
  id: string;
  senderId: string;
  messageIds: string[];
}

export const localBlockedMessageGroups = (
  messages: readonly Message[],
  blockedUserIds: ReadonlySet<string>,
  groupAdjacent = true,
) => {
  const groupByMessageId = new Map<string, LocalBlockedMessageGroup>();
  let current: LocalBlockedMessageGroup | undefined;

  for (const message of messages) {
    if (message.outgoing || !blockedUserIds.has(message.senderId)) {
      current = undefined;
      continue;
    }
    if (!groupAdjacent || current?.senderId !== message.senderId) {
      current = {
        id: `${message.senderId}:${message.renderKey ?? message.id}`,
        senderId: message.senderId,
        messageIds: [],
      };
    }
    current.messageIds.push(message.id);
    groupByMessageId.set(message.id, current);
  }

  return groupByMessageId;
};

export const replySenderId = (
  message: Message,
  messagesById: ReadonlyMap<string, Message>,
) => {
  if (!message.replyTo || message.replyTo.kind !== "message") return undefined;
  const target = message.replyTo.messageId
    ? messagesById.get(message.replyTo.messageId)
    : undefined;
  return target?.senderId ?? message.replyTo.senderId;
};
