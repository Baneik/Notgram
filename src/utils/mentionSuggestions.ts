import type { Message, MessageTextEntity, User } from "../telegram/types";

export const MAX_MENTION_SUGGESTIONS = 5;

const mentionEntitiesForMessage = (message: Message): readonly MessageTextEntity[] => {
  if (message.content.kind === "text") return message.content.entities ?? [];
  if (message.content.kind === "file" || message.content.kind === "media") {
    return message.content.captionEntities ?? [];
  }
  return [];
};

export const recentMentionUserIdsFor = (messages: readonly Message[]): string[] => {
  const usage = new Map<string, {
    count: number;
    lastMentionedAt: number;
    lastMessageIndex: number;
  }>();

  messages.forEach((message, messageIndex) => {
    if (!message.outgoing) return;
    const sentAt = Date.parse(message.sentAt);
    for (const entity of mentionEntitiesForMessage(message)) {
      if (entity.kind !== "mentionName" || !entity.userId) continue;
      const current = usage.get(entity.userId);
      usage.set(entity.userId, {
        count: (current?.count ?? 0) + 1,
        lastMentionedAt: Math.max(
          current?.lastMentionedAt ?? Number.NEGATIVE_INFINITY,
          Number.isFinite(sentAt) ? sentAt : Number.NEGATIVE_INFINITY,
        ),
        lastMessageIndex: messageIndex,
      });
    }
  });

  return [...usage.entries()]
    .sort((left, right) =>
      right[1].count - left[1].count ||
      right[1].lastMentionedAt - left[1].lastMentionedAt ||
      right[1].lastMessageIndex - left[1].lastMessageIndex
    )
    .map(([userId]) => userId);
};

export const mentionSuggestionsFor = (
  users: readonly User[],
  query: string,
  recentMentionUserIds: readonly string[],
): User[] => {
  const mentionableUsers = users.filter((user) => user.isBot !== true);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    const usersById = new Map(mentionableUsers.map((user) => [user.id, user]));
    return recentMentionUserIds
      .flatMap((userId) => {
        const user = usersById.get(userId);
        return user ? [user] : [];
      })
      .slice(0, MAX_MENTION_SUGGESTIONS);
  }

  return mentionableUsers
    .map((user, order) => {
      const username = user.username?.trim().replace(/^@/, "") ?? "";
      const values = [username, user.displayName, user.firstName, user.lastName]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLocaleLowerCase());
      const rank = Math.min(...values.map((value) => value === normalizedQuery
        ? 0
        : value.startsWith(normalizedQuery)
          ? 1
          : value.includes(normalizedQuery)
            ? 2
            : 99));
      return { user, order, rank };
    })
    .filter((item) => item.rank < 99)
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .slice(0, MAX_MENTION_SUGGESTIONS)
    .map((item) => item.user);
};
