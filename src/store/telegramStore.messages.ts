import type { Message } from "../telegram/types";

const numericMessageId = (messageId: string) => {
  if (!/^-?\d+$/.test(messageId)) return undefined;
  try {
    return BigInt(messageId);
  } catch {
    return undefined;
  }
};

const compareMessages = (left: Message, right: Message) => {
  const leftTimestamp = Date.parse(left.sentAt);
  const rightTimestamp = Date.parse(right.sentAt);
  if (
    Number.isFinite(leftTimestamp) &&
    Number.isFinite(rightTimestamp) &&
    leftTimestamp !== rightTimestamp
  ) {
    return leftTimestamp - rightTimestamp;
  }

  const leftId = numericMessageId(left.id);
  const rightId = numericMessageId(right.id);
  if (leftId === undefined || rightId === undefined || leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
};

export const upsertMessages = (messages: Message[], incoming: Message[]) => {
  if (incoming.length === 0) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    // History/context responses started before deletion cannot replace a retained copy.
    // Its file state is updated explicitly through file.updated events.
    if (existing?.isLocallyDeleted && !message.isLocallyDeleted) continue;
    const renderKey = message.renderKey ?? existing?.renderKey;
    const discussionThread = message.discussionThread ?? existing?.discussionThread;
    const isLocallyDeleted = message.isLocallyDeleted ?? existing?.isLocallyDeleted;
    const locallyDeletedAt = message.locallyDeletedAt ?? existing?.locallyDeletedAt;
    byId.set(message.id, renderKey || discussionThread || isLocallyDeleted
      ? { ...message, renderKey, discussionThread, isLocallyDeleted, locallyDeletedAt }
      : message);
  }
  return [...byId.values()].sort(compareMessages);
};

export const upsertMessage = (messages: Message[], next: Message) =>
  upsertMessages(messages, [next]);

export const replaceMessage = (
  messages: Message[],
  oldMessageId: string,
  next: Message,
) => {
  const previous = messages.find((message) => message.id === oldMessageId);
  const replacement = previous
    ? { ...next, renderKey: previous.renderKey ?? previous.id }
    : next;
  return upsertMessage(
    messages.filter((message) => message.id !== oldMessageId && message.id !== next.id),
    replacement,
  );
};

export const withEmojiReaction = (
  message: Message,
  emoji: string,
  chosen: boolean,
  senderId?: string,
): Message => {
  const interaction = message.interaction ?? {
    viewCount: 0,
    forwardCount: 0,
    replyCount: 0,
    reactions: [],
  };
  const reactions = [...interaction.reactions];
  const index = reactions.findIndex(
    (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
  );
  if (index >= 0) {
    const current = reactions[index];
    if (current.chosen === chosen) return message;
    const totalCount = Math.max(0, current.totalCount + (chosen ? 1 : -1));
    if (totalCount === 0) reactions.splice(index, 1);
    else {
      const recentSenderIds = senderId
        ? [
            ...(chosen ? [senderId] : []),
            ...current.recentSenderIds.filter((id) => id !== senderId),
          ].slice(0, 3)
        : current.recentSenderIds;
      reactions[index] = { ...current, chosen, totalCount, recentSenderIds };
    }
  } else if (chosen) {
    reactions.push({
      type: { kind: "emoji", emoji },
      totalCount: 1,
      chosen: true,
      recentSenderIds: senderId ? [senderId] : [],
    });
  } else {
    return message;
  }
  return { ...message, interaction: { ...interaction, reactions } };
};

export const messageMapFrom = (messages: Message[]) => {
  const grouped = new Map<string, Message[]>();
  for (const message of messages) {
    const chatMessages = grouped.get(message.chatId) ?? [];
    chatMessages.push(message);
    grouped.set(message.chatId, chatMessages);
  }
  const result = new Map<string, Message[]>();
  for (const [chatId, chatMessages] of grouped) {
    result.set(chatId, [...chatMessages].sort(compareMessages));
  }
  return result;
};

export interface ChannelDiscussionProjection {
  root?: Message;
  comments: Message[];
  replyChatId?: string;
  replyMessageId?: string;
  cached: boolean;
}

export const channelDiscussionProjection = (
  post: Message,
  messages: ReadonlyMap<string, Message[]>,
): ChannelDiscussionProjection => {
  const reference = post.discussionThread;
  const exactRoot = reference
    ? messages.get(reference.chatId)?.find((message) => message.id === reference.messageId)
    : undefined;
  const root = exactRoot ?? messages.get(post.chatId)?.find((message) =>
    message.id === post.id
  );
  const replyChatId = reference?.chatId ?? root?.chatId;
  const replyMessageId = reference?.messageId ?? root?.id;
  const comments: Message[] = [];

  const candidateChatIds = new Set(
    [post.chatId, reference?.chatId].filter((chatId): chatId is string => Boolean(chatId)),
  );
  for (const candidateChatId of candidateChatIds) {
    const chatMessages = messages.get(candidateChatId);
    if (!chatMessages) continue;
    for (const message of chatMessages) {
      if (
        message.isChannelPost ||
        (message.chatId === post.chatId && message.id === post.id) ||
        (root && message.chatId === root.chatId && message.id === root.id)
      ) continue;
      const reply = message.replyTo?.kind === "message" ? message.replyTo : undefined;
      const belongsToResolvedThread = Boolean(
        replyChatId && replyMessageId && message.chatId === replyChatId && (
          message.topicId === replyMessageId || (
            reply?.messageId === replyMessageId &&
            (!reply.chatId || reply.chatId === replyChatId)
          )
        ),
      );
      const origin = reply?.origin;
      const isLegacyDirectReply = reply?.messageId === post.id && (
        message.chatId === post.chatId ||
        reply.chatId === post.chatId ||
        (origin?.kind === "channel" && origin.chatId === post.chatId)
      );
      if (belongsToResolvedThread || isLegacyDirectReply) comments.push(message);
    }
  }

  return {
    root,
    comments: upsertMessages([], comments),
    replyChatId,
    replyMessageId,
    cached: Boolean((reference && exactRoot) || comments.length > 0),
  };
};

export const pendingCachedIdsAfterConfirmation = (
  pendingCachedIds: Set<string>,
  confirmedIds: Set<string>,
) => {
  const remainingCachedIds = new Set(pendingCachedIds);
  for (const messageId of confirmedIds) remainingCachedIds.delete(messageId);
  return remainingCachedIds;
};
