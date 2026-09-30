import type { Message } from "../telegram/types";

const numericMessageId = (messageId: string) => {
  if (!/^-?\d+$/.test(messageId)) return undefined;
  try {
    return BigInt(messageId);
  } catch {
    return undefined;
  }
};

export const compareMessages = (left: Pick<Message, "id" | "sentAt">, right: Pick<Message, "id" | "sentAt">) => {
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

const equalMessageValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    equalMessageValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};

// Histories are immutable. Content-only replacements keep the same positions,
// so their arrays can share an index without retaining evicted histories.
const messagePositions = new WeakMap<Message[], ReadonlyMap<string, number>>();
const positionsFor = (messages: Message[]) => {
  let positions = messagePositions.get(messages);
  if (!positions) {
    positions = new Map(messages.map((message, index) => [message.id, index]));
    messagePositions.set(messages, positions);
  }
  return positions;
};

export const findIndexedMessage = (messages: Message[], messageId: string) => {
  const index = positionsFor(messages).get(messageId);
  return index === undefined ? undefined : messages[index];
};

export const upsertMessages = (messages: Message[], incoming: Message[]) => {
  if (incoming.length === 0) return messages;
  const positions = positionsFor(messages);
  const updates = new Map<string, Message>();
  for (let message of incoming) {
    const index = positions.get(message.id);
    const existing = updates.get(message.id) ?? (index === undefined ? undefined : messages[index]);
    // History/context responses started before deletion cannot replace a retained copy.
    // Its file state is updated explicitly through file.updated events.
    if (existing?.isLocallyDeleted && !message.isLocallyDeleted) continue;
    if (existing?.editedAt && Date.parse(existing.editedAt) > (message.editedAt ? Date.parse(message.editedAt) : 0)) {
      message = { ...message, content: existing.content, editedAt: existing.editedAt, replyMarkup: existing.replyMarkup };
    }
    const renderKey = message.renderKey ?? existing?.renderKey;
    const discussionThread = message.discussionThread ?? existing?.discussionThread;
    const isLocallyDeleted = message.isLocallyDeleted ?? existing?.isLocallyDeleted;
    const locallyDeletedAt = message.locallyDeletedAt ?? existing?.locallyDeletedAt;
    const candidate = renderKey || discussionThread || isLocallyDeleted
      ? { ...message, renderKey, discussionThread, isLocallyDeleted, locallyDeletedAt }
      : message;
    const next = existing && equalMessageValue(existing, candidate) ? existing : candidate;
    if (next !== existing) updates.set(message.id, next);
  }
  if (updates.size === 0) return messages;
  const result = messages.slice();
  const added: Message[] = [];
  let moved = false;
  for (const [id, next] of updates) {
    const index = positions.get(id);
    if (index === undefined) added.push(next);
    else {
      moved ||= messages[index].sentAt !== next.sentAt;
      result[index] = next;
    }
  }
  // Only a changed timestamp requires reordering existing entries. Edits,
  // reactions and file progress leave the chronological order untouched.
  if (moved) return [...result, ...added].sort(compareMessages);
  if (added.length === 0) {
    messagePositions.set(result, positions);
    return result;
  }
  if (added.length === 1) {
    const message = added[0];
    let start = 0;
    let end = result.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (compareMessages(result[middle], message) <= 0) start = middle + 1;
      else end = middle;
    }
    result.splice(start, 0, message);
    return result;
  }
  added.sort(compareMessages);
  const merged: Message[] = [];
  let index = 0;
  for (const message of added) {
    while (index < result.length && compareMessages(result[index], message) <= 0) {
      merged.push(result[index++]);
    }
    merged.push(message);
  }
  while (index < result.length) merged.push(result[index++]);
  return merged;
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

/** Stop backfilling once a contiguous server walk passes the cached window.
 * Missing IDs remain unconfirmed; reaching this boundary never deletes them.
 */
export const reachedCachedHistoryBoundary = (cachedIds: Set<string>, returnedIds: Set<string>) => {
  const cached = [...cachedIds].map(numericMessageId);
  if (cached.length === 0 || cached.some((id) => id === undefined || id <= 0n)) return false;
  const oldest = (cached as bigint[]).reduce((left, right) => left < right ? left : right);
  return [...returnedIds].some((id) => {
    const value = numericMessageId(id);
    return value !== undefined && value > 0n && value <= oldest;
  });
};

export const pendingCachedIdsAfterConfirmation = (
  pendingCachedIds: Set<string>,
  confirmedIds: Set<string>,
) => {
  const remainingCachedIds = new Set(pendingCachedIds);
  for (const messageId of confirmedIds) remainingCachedIds.delete(messageId);
  return remainingCachedIds;
};
