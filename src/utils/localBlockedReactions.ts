import type { Message, MessageReaction, MessageReactionType } from "../telegram/types";

export const messageReactionTypeKey = (type: MessageReactionType) => {
  if (type.kind === "emoji") return `emoji:${type.emoji}`;
  if (type.kind === "customEmoji") return `custom:${type.customEmojiId}`;
  return "paid";
};

const unreadReactionTypeKeysFromBlockedSenders = (
  message: Message,
  blockedSenderIds: ReadonlySet<string>,
) => new Set(
  (message.unreadReactions ?? [])
    .filter((reaction) => reaction.senderId !== undefined && blockedSenderIds.has(reaction.senderId))
    .map((reaction) => messageReactionTypeKey(reaction.type)),
);

export const reactionHasLocalBlockedSender = (
  message: Message,
  reaction: MessageReaction,
  blockedSenderIds: ReadonlySet<string>,
) => blockedSenderIds.size > 0 && (
  reaction.recentSenderIds.some((senderId) => blockedSenderIds.has(senderId)) ||
  unreadReactionTypeKeysFromBlockedSenders(message, blockedSenderIds).has(
    messageReactionTypeKey(reaction.type),
  )
);

export const visibleMessageReactions = (
  message: Message,
  blockedSenderIds: ReadonlySet<string>,
) => {
  const reactions = message.interaction?.reactions ?? [];
  if (blockedSenderIds.size === 0 || reactions.length === 0) return reactions;
  const unreadReactions = message.unreadReactions ?? [];
  return reactions.flatMap((reaction) => {
    const hiddenSenderIds = new Set(
      reaction.recentSenderIds.filter((senderId) => blockedSenderIds.has(senderId)),
    );
    for (const unreadReaction of unreadReactions) {
      if (
        unreadReaction.senderId &&
        blockedSenderIds.has(unreadReaction.senderId) &&
        messageReactionTypeKey(unreadReaction.type) === messageReactionTypeKey(reaction.type)
      ) {
        hiddenSenderIds.add(unreadReaction.senderId);
      }
    }
    const totalCount = Math.max(0, reaction.totalCount - hiddenSenderIds.size);
    if (totalCount === 0) return [];
    return [{
      ...reaction,
      totalCount,
      recentSenderIds: reaction.recentSenderIds.filter((senderId) => !blockedSenderIds.has(senderId)),
    }];
  });
};

export const messageHasUnreadLocalBlockedReaction = (
  message: Message,
  blockedSenderIds: ReadonlySet<string>,
) => message.containsUnreadReaction === true && blockedSenderIds.size > 0 && (
  (message.unreadReactions ?? []).some((reaction) =>
    reaction.senderId !== undefined && blockedSenderIds.has(reaction.senderId)
  ) ||
  (message.interaction?.reactions ?? []).some((reaction) =>
    reaction.recentSenderIds.some((senderId) => blockedSenderIds.has(senderId))
  )
);
