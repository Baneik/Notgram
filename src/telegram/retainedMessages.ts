import { messageContentText } from "./messageContent";
import type { Message, MessageContent, MessageFileState, MessageReplyQuote, MessageTextEntity } from "./types";
import { trimComposerFormattedText } from "../utils/composerMentions";

const matchesIdentity = (remoteId: string | undefined, uniqueId: string | undefined,
  file: Pick<MessageFileState, "remoteId" | "remoteUniqueId">) =>
  uniqueId ? uniqueId === file.remoteUniqueId : Boolean(remoteId && remoteId === file.remoteId);

/** Persist paths and remote identities, never runtime file handles or transfers. Also migrates legacy archives. */
export const retainedMessageForCache = (message: Message): Message => {
  const content = message.content;
  if (!message.isLocallyDeleted || (content.kind !== "media" && content.kind !== "file")) return message;
  return { ...message, content: {
    ...content,
    fileId: undefined,
    thumbnailFileId: undefined,
    canDownload: false,
    thumbnailCanDownload: false,
    isDownloading: false,
    thumbnailIsDownloading: false,
    isUploading: false,
    uploadedSize: undefined,
    isDownloaded: Boolean(content.localPath),
    downloadedSize: content.localPath ? content.downloadedSize : undefined,
    progress: content.localPath ? 1 : undefined,
  } };
};

/** A remote lookup may bind only the identities requested, never an old numeric ID. */
export const bindRetainedMessageFile = (message: Message, remoteId: string, file: MessageFileState): Message => {
  const content = message.content;
  if (!message.isLocallyDeleted || (content.kind !== "media" && content.kind !== "file") ||
    !Number.isSafeInteger(file.fileId) || file.fileId <= 0) return message;
  const main = content.fileId === undefined && content.remoteId === remoteId &&
    matchesIdentity(content.remoteId, content.remoteUniqueId, file);
  const thumbnail = content.thumbnailFileId === undefined && content.thumbnailRemoteId === remoteId &&
    matchesIdentity(content.thumbnailRemoteId, content.thumbnailRemoteUniqueId, file);
  if (!main && !thumbnail) return message;
  return updateRetainedMessageFile({ ...message, content: {
    ...content,
    ...(main ? { fileId: file.fileId } : {}),
    ...(thumbnail ? { thumbnailFileId: file.fileId } : {}),
  } }, file);
};

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
  const prefix = `${authorText}\n`;
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
  const sameFile = snapshot.fileId !== undefined && snapshot.fileId === existing.fileId &&
    (!snapshot.remoteId && !snapshot.remoteUniqueId || matchesIdentity(snapshot.remoteId, snapshot.remoteUniqueId, existing));
  const downloaded = sameFile && Boolean(existing.localPath) && existing.isDownloaded === true;
  const sameThumbnail = snapshot.thumbnailFileId !== undefined && snapshot.thumbnailFileId === existing.thumbnailFileId &&
    (!snapshot.thumbnailRemoteId && !snapshot.thumbnailRemoteUniqueId || matchesIdentity(snapshot.thumbnailRemoteId,
      snapshot.thumbnailRemoteUniqueId, { remoteId: existing.thumbnailRemoteId, remoteUniqueId: existing.thumbnailRemoteUniqueId }));
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
  const main = content.fileId === file.fileId && (!content.remoteId && !content.remoteUniqueId ||
    matchesIdentity(content.remoteId, content.remoteUniqueId, file));
  const thumbnail = content.thumbnailFileId === file.fileId && (!content.thumbnailRemoteId && !content.thumbnailRemoteUniqueId ||
    matchesIdentity(content.thumbnailRemoteId, content.thumbnailRemoteUniqueId, file));
  if (!main && !thumbnail) return message;
  return {
    ...message,
    content: {
      ...content,
      ...(main ? {
        ...file,
        remoteId: file.remoteId ?? content.remoteId,
        remoteUniqueId: file.remoteUniqueId ?? content.remoteUniqueId,
        // Remote deletion can discard TDLib's local state while our retained path is still usable.
        ...(!file.localPath && content.localPath ? {
          localPath: content.localPath, isDownloaded: true, isDownloading: false,
          downloadedSize: content.downloadedSize, progress: 1,
        } : {}),
      } : {}),
      ...(thumbnail ? {
        thumbnailRemoteId: file.remoteId ?? content.thumbnailRemoteId,
        thumbnailRemoteUniqueId: file.remoteUniqueId ?? content.thumbnailRemoteUniqueId,
        thumbnailPath: file.localPath ?? content.thumbnailPath,
        thumbnailCanDownload: file.canDownload,
        thumbnailIsDownloading: file.isDownloading,
      } : {}),
    },
  };
};
