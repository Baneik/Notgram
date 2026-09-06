import type { Message } from "../telegram/types";

export type MediaAlbumSegment =
  | { kind: "message"; message: Message }
  | { kind: "album"; albumId: string; messages: Message[] };

const isVisualAlbumMessage = (message: Message) => Boolean(
  message.mediaAlbumId &&
  message.content.kind === "media" &&
  (message.content.mediaType === "photo" || message.content.mediaType === "video"),
);

/** TDLib media_album_id is the authoritative identity of a media group. */
export const belongsToSameAlbum = (left: Message, right: Message) => Boolean(
  isVisualAlbumMessage(left) &&
  isVisualAlbumMessage(right) &&
  left.mediaAlbumId === right.mediaAlbumId &&
  left.chatId === right.chatId,
);

/** A visual album has shared text only when exactly one item owns a caption. */
export const mediaAlbumCaptionMessage = (messages: readonly Message[]) => {
  let owner: (Message & { content: Extract<Message["content"], { kind: "media" }> }) | undefined;
  for (const message of messages) {
    if (!isVisualAlbumMessage(message) || message.content.kind !== "media" || !message.content.caption) continue;
    if (owner) return undefined;
    owner = { ...message, content: message.content };
  }
  return owner;
};

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
