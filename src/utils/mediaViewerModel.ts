import type { Message, MessageContent } from "../telegram/types";

export type PhotoContent = Extract<MessageContent, { kind: "media" }> & {
  mediaType: "photo";
};

export type PhotoMessage = Message & { content: PhotoContent };

export const isPhotoMessage = (message: Message): message is PhotoMessage =>
  message.content.kind === "media" && message.content.mediaType === "photo";

export const photoMessages = (messages: Message[]) => messages.filter(isPhotoMessage);

export const adjacentPhotoId = (
  messages: PhotoMessage[],
  currentId: string,
  direction: -1 | 1,
) => {
  const currentIndex = messages.findIndex((message) => message.id === currentId);
  return currentIndex < 0 ? undefined : messages[currentIndex + direction]?.id;
};
