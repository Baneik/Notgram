import type { Chat, Message } from "../telegram/types";

// Presentation updates (reads, reactions, thumbnails and transfer progress) do
// not change operation rights. Actual edits and lifecycle changes still do.
export const messagePermissionRevision = (message: Message) => {
  const content = message.content;
  const body = content.kind === "media" || content.kind === "file"
    ? [content.kind === "media" ? content.mediaType : undefined, content.fileId,
      content.caption, content.captionEntities, content.hasSpoiler, content.isDocument]
    : content.kind === "poll" ? [content.pollId, content.isClosed]
      : [content.text, content.kind === "text" ? content.entities : undefined];
  return JSON.stringify([
    message.id, message.chatId, message.topicId, message.messageThreadId,
    message.senderId, message.outgoing, message.sentAt, message.editedAt,
    message.delivery === "read" ? "sent" : message.delivery, message.isPending,
    message.canSave, message.selfDestruct, message.expiresAt, message.isPinned,
    message.isLocallyDeleted, message.isRemoving, content.kind, body,
  ]);
};

export const chatMessagePermissionRevision = (chat: Chat | undefined) => JSON.stringify([
  chat?.kind, chat?.isMember, chat?.isBanned, chat?.canSendMessages,
  chat?.canPinMessages, chat?.management,
]);
