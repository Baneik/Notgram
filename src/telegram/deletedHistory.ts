/** Compare ordered TDLib message IDs without losing integer precision. */
export const isInDeletedHistory = (messageId: string, lastMessageId?: string) =>
  Boolean(lastMessageId && /^[1-9]\d*$/.test(messageId) && /^[1-9]\d*$/.test(lastMessageId) &&
    BigInt(messageId) <= BigInt(lastMessageId));
