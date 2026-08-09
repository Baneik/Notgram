export interface ConversationJumpAnchor {
  messageId: string;
  offset: number;
}

export const MAX_CONVERSATION_JUMP_HISTORY = 32;

export const pushConversationJumpAnchor = (
  history: readonly ConversationJumpAnchor[],
  anchor: ConversationJumpAnchor,
  limit = MAX_CONVERSATION_JUMP_HISTORY,
) => {
  const previous = history.at(-1);
  if (
    previous?.messageId === anchor.messageId &&
    Math.abs(previous.offset - anchor.offset) <= 1
  ) {
    return [...history];
  }
  return [...history, anchor].slice(-Math.max(1, limit));
};

export const popAvailableConversationJumpAnchor = (
  history: readonly ConversationJumpAnchor[],
  availableMessageIds: ReadonlySet<string>,
) => {
  const remaining = [...history];
  while (remaining.length > 0) {
    const anchor = remaining.pop()!;
    if (availableMessageIds.has(anchor.messageId)) {
      return { anchor, history: remaining };
    }
  }
  return { anchor: undefined, history: remaining };
};
