import type { Message } from "../telegram/types";

export const upsertMessage = (messages: Message[], next: Message) => {
  const index = messages.findIndex((message) => message.id === next.id);
  const updated = [...messages];
  if (index >= 0) updated[index] = next;
  else updated.push(next);
  return updated.sort(
    (left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime(),
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
  const result = new Map<string, Message[]>();
  for (const message of messages) {
    result.set(message.chatId, upsertMessage(result.get(message.chatId) ?? [], message));
  }
  return result;
};

const numericMessageId = (messageId: string) => {
  if (!/^-?\d+$/.test(messageId)) return undefined;
  try {
    return BigInt(messageId);
  } catch {
    return undefined;
  }
};

export const reconcileCachedMessageWindow = (
  messages: Message[],
  pendingCachedIds: Set<string>,
  confirmedIds: Set<string>,
) => {
  const confirmedNumericIds = [...confirmedIds]
    .map(numericMessageId)
    .filter((messageId): messageId is bigint => messageId !== undefined);
  const oldestConfirmedId = confirmedNumericIds.length > 0
    ? confirmedNumericIds.reduce((oldest, messageId) => messageId < oldest ? messageId : oldest)
    : undefined;
  const newestConfirmedId = confirmedNumericIds.length > 0
    ? confirmedNumericIds.reduce((newest, messageId) => messageId > newest ? messageId : newest)
    : undefined;
  const remainingCachedIds = new Set(pendingCachedIds);
  const reconciledMessages = messages.filter((message) => {
    if (!pendingCachedIds.has(message.id)) return true;
    if (confirmedIds.has(message.id)) {
      remainingCachedIds.delete(message.id);
      return true;
    }

    const messageId = numericMessageId(message.id);
    const coveredByServerWindow =
      messageId !== undefined &&
      oldestConfirmedId !== undefined &&
      newestConfirmedId !== undefined &&
      messageId >= oldestConfirmedId &&
      messageId <= newestConfirmedId;
    if (!coveredByServerWindow) return true;
    remainingCachedIds.delete(message.id);
    return false;
  });
  return { messages: reconciledMessages, pendingCachedIds: remainingCachedIds };
};
