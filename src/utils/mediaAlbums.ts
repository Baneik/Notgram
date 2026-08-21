import type { Message } from "../telegram/types";

export type MediaAlbumSegment =
  | { kind: "message"; message: Message }
  | { kind: "album"; albumId: string; messages: Message[] };

const isVisualAlbumMessage = (message: Message) => Boolean(
  message.mediaAlbumId &&
  message.content.kind === "media" &&
  (message.content.mediaType === "photo" || message.content.mediaType === "video"),
);

const belongsToSameAlbum = (left: Message, right: Message) => Boolean(
  isVisualAlbumMessage(left) &&
  isVisualAlbumMessage(right) &&
  left.mediaAlbumId === right.mediaAlbumId &&
  left.chatId === right.chatId &&
  left.senderId === right.senderId &&
  left.outgoing === right.outgoing,
);

export const segmentMediaAlbums = (messages: Message[]): MediaAlbumSegment[] => {
  const segments: MediaAlbumSegment[] = [];

  for (let index = 0; index < messages.length;) {
    const first = messages[index];
    if (!first || !isVisualAlbumMessage(first)) {
      if (first) segments.push({ kind: "message", message: first });
      index += 1;
      continue;
    }

    const albumMessages = [first];
    let nextIndex = index + 1;
    while (
      nextIndex < messages.length &&
      belongsToSameAlbum(albumMessages.at(-1)!, messages[nextIndex]!)
    ) {
      albumMessages.push(messages[nextIndex]!);
      nextIndex += 1;
    }

    if (albumMessages.length > 1) {
      segments.push({
        kind: "album",
        albumId: first.mediaAlbumId!,
        messages: albumMessages,
      });
    } else {
      segments.push({ kind: "message", message: first });
    }
    index = nextIndex;
  }

  return segments;
};

export const mediaAlbumMessagesFor = (
  messages: readonly Message[],
  source: Message,
) => source.mediaAlbumId
  ? messages.filter((message) =>
      message.chatId === source.chatId &&
      message.mediaAlbumId === source.mediaAlbumId &&
      isVisualAlbumMessage(message)
    )
  : [];
