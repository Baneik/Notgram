import type { DeliveryState, Message } from "../telegram/types";

/** A group is complete only when every outgoing item has completed. */
export const messageDeliveryState = (messages: readonly Message[], channelPost = false): DeliveryState | undefined => {
  const outgoing = messages.filter(message => message.outgoing);
  if (!outgoing.length) return undefined;
  if (outgoing.some(message => message.delivery === "failed")) return "failed";
  if (outgoing.some(message => message.delivery === "sending")) return "sending";
  // Channel view counts do not represent a recipient read receipt.
  if (!channelPost && outgoing.every(message => message.delivery === "read")) return "read";
  return "sent";
};

export const channelDiscussionAvailable = (message: Message) =>
  message.isChannelPost === true && (
    message.interaction?.hasDiscussion === true ||
    (message.interaction?.replyCount ?? 0) > 0
  );

/** Keep counters tied to a real source message, while including album-wide edits and pins. */
export const mediaAlbumMetadataMessage = (messages: readonly Message[]): Message | undefined => {
  const owner = messages.find(channelDiscussionAvailable)
    ?? messages.find(message => message.isChannelPost && message.interaction)
    ?? messages[0];
  if (!owner) return undefined;
  const editedAt = messages.reduce<string | undefined>((latest, message) =>
    message.editedAt && (!latest || Date.parse(message.editedAt) > Date.parse(latest))
      ? message.editedAt : latest, undefined);
  return { ...owner, editedAt, isPinned: messages.some(message => message.isPinned) };
};
