import { messageContentText } from "./messageContent";
import type { Message, MessageContent, MessageFileState, MessageReplyQuote, MessageTextEntity } from "./types";
import { trimComposerFormattedText } from "../utils/composerMentions";

export const retainedMessageQuote = (
  content: MessageContent,
  author: string,
  quote?: MessageReplyQuote,
  senderId?: string,
) => {
  const sourceEntities = content.kind === "text" ? content.entities
    : content.kind === "media" || content.kind === "file" ? content.captionEntities : undefined;
  const body = trimComposerFormattedText(quote?.text ?? messageContentText(content),
    quote ? quote.entities ?? [] : sourceEntities ?? []);
  if (!body.text) return { text: "", entities: [] as MessageTextEntity[] };
  const userId = senderId && !senderId.startsWith("chat:") ? senderId : undefined;
  const authorText = userId && !author.startsWith("@") ? `@${author}` : author;
  const prefix = `${authorText}:\n`;
  const text = `${prefix}${body.text}`;
  return {
    text,
    entities: [
      { offset: 0, length: text.length, kind: "blockquote" as const },
      ...(userId ? [{ offset: 0, length: authorText.length, kind: "mentionName" as const, userId }] : []),
      ...body.entities.filter(entity => entity.kind !== "blockquote")
        .map(entity => ({ ...entity, offset: entity.offset + prefix.length })),
    ],
  };
};

/** A deletion snapshot may predate the file hydration already shown in the UI. */
export const retainHydratedContent = (snapshot: MessageContent, existing?: MessageContent): MessageContent => {
  if ((snapshot.kind !== "media" && snapshot.kind !== "file") || existing?.kind !== snapshot.kind) return snapshot;
  if (snapshot.kind === "media" && existing.kind === "media" && snapshot.mediaType !== existing.mediaType) return snapshot;
  const sameFile = snapshot.fileId === existing.fileId;
  const downloaded = sameFile && Boolean(existing.localPath) && existing.isDownloaded === true;
  const sameThumbnail = snapshot.thumbnailFileId === existing.thumbnailFileId;
  return {
    ...snapshot,
    ...(downloaded ? {
      localPath: existing.localPath,
      isDownloaded: true,
      isDownloading: false,
      downloadedSize: Math.max(existing.downloadedSize ?? 0, snapshot.downloadedSize ?? 0),
      progress: 1,
    } : {}),
    ...(sameThumbnail && existing.thumbnailPath ? {
      thumbnailPath: existing.thumbnailPath,
      thumbnailIsDownloading: false,
    } : {}),
  };
};

export const updateRetainedMessageFile = (message: Message, file: MessageFileState): Message => {
  const content = message.content;
  if (content.kind !== "media" && content.kind !== "file") return message;
  if (content.fileId !== file.fileId && content.thumbnailFileId !== file.fileId) return message;
  return {
    ...message,
    content: {
      ...content,
      ...(content.fileId === file.fileId ? file : {}),
      ...(content.thumbnailFileId === file.fileId ? {
        thumbnailPath: file.localPath,
        thumbnailCanDownload: file.canDownload,
        thumbnailIsDownloading: file.isDownloading,
      } : {}),
    },
  };
};
