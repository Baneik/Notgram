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
    byId.set(
      message.id,
      existing?.renderKey && !message.renderKey
        ? { ...message, renderKey: existing.renderKey }
        : message,
    );
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
    else reactions[index] = { ...current, chosen, totalCount };
  } else if (chosen) {
    reactions.push({
      type: { kind: "emoji", emoji },
      totalCount: 1,
      chosen: true,
      recentSenderIds: [],
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

export const pendingCachedIdsAfterConfirmation = (
  pendingCachedIds: Set<string>,
  confirmedIds: Set<string>,
) => {
  const remainingCachedIds = new Set(pendingCachedIds);
  for (const messageId of confirmedIds) remainingCachedIds.delete(messageId);
  return remainingCachedIds;
};
