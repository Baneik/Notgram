import type { Message, MessageContent } from "../telegram/types";

export type PhotoContent = Extract<MessageContent, { kind: "media" }> & {
  mediaType: "photo";
};

export type PhotoMessage = Message & { content: PhotoContent };

export const isPhotoMessage = (message: Message): message is PhotoMessage =>
  message.content.kind === "media" && message.content.mediaType === "photo";

export const photoMessages = (messages: Message[]) => messages.filter(isPhotoMessage);

export const MAX_MEDIA_VIEWER_THUMBNAILS = 9;

export const photoThumbnailWindow = (
  messages: PhotoMessage[],
  currentId: string,
  limit = MAX_MEDIA_VIEWER_THUMBNAILS,
) => {
  const size = Math.max(1, Math.floor(limit));
  if (messages.length <= size) return messages;
  const currentIndex = Math.max(0, messages.findIndex((message) => message.id === currentId));
  const maximumStart = messages.length - size;
  const start = Math.min(Math.max(0, currentIndex - Math.floor(size / 2)), maximumStart);
  return messages.slice(start, start + size);
};

export const adjacentPhotoId = (
  messages: PhotoMessage[],
  currentId: string,
  direction: -1 | 1,
) => {
  const currentIndex = messages.findIndex((message) => message.id === currentId);
  return currentIndex < 0 ? undefined : messages[currentIndex + direction]?.id;
};
