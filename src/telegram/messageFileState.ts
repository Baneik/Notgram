import type { Message, MessageContent, MessageFileState, MessageRichBlock } from "./types";

export type MessageFileContent = Pick<Extract<MessageContent, { kind: "file" }>,
  "fileId" | "remoteId" | "remoteUniqueId" | "localPath" | "isDownloaded" | "isDownloading" |
  "canDownload" | "downloadedSize" | "progress" | "size" | "sizeLabel" | "isUploading" | "uploadedSize" |
  "thumbnailFileId" | "thumbnailRemoteId" | "thumbnailRemoteUniqueId" | "thumbnailPath" |
  "thumbnailCanDownload" | "thumbnailIsDownloading"
>;

const mapArray = <T>(items: T[], visit: (item: T) => T) => {
  const next = items.map(visit);
  return next.some((item, index) => item !== items[index]) ? next : items;
};

/** Preserve message/layout identity when an unrelated file update arrives. */
export const mapMessageFiles = (message: Message, visit: (file: MessageFileContent) => MessageFileContent): Message => {
  const mapBlocks = (blocks: MessageRichBlock[]): MessageRichBlock[] => mapArray(blocks, block => {
    if (block.kind === "media") {
      const media = visit(block.media);
      return media === block.media ? block : { ...block, media: { ...block.media, ...media } };
    }
    if ("blocks" in block) {
      const blocks = mapBlocks(block.blocks);
      return blocks === block.blocks ? block : { ...block, blocks };
    }
    if (block.kind === "list") {
      const items = mapArray(block.items, item => {
        const blocks = mapBlocks(item.blocks);
        return blocks === item.blocks ? item : { ...item, blocks };
      });
      return items === block.items ? block : { ...block, items };
    }
    return block;
  });
  const mapContent = (content: MessageContent): MessageContent => {
    if (content.kind === "media" || content.kind === "file") return visit(content) as typeof content;
    if (content.kind !== "rich") return content;
    const blocks = mapBlocks(content.blocks);
    return blocks === content.blocks ? content : { ...content, blocks };
  };
  const content = mapContent(message.content);
  let replyTo = message.replyTo;
  if (replyTo?.kind === "message" && replyTo.content) {
    const content = mapContent(replyTo.content);
    if (content !== replyTo.content) replyTo = { ...replyTo, content };
  }
  return content === message.content && replyTo === message.replyTo ? message : { ...message, content, replyTo };
};

export const messageFiles = (message: Message) => {
  const files: MessageFileContent[] = [];
  mapMessageFiles(message, file => { files.push(file); return file; });
  return files;
};

/** Numeric file handles belong to one TDLib runtime, including those in legacy snapshots. */
export const messageFilesForCache = (message: Message) => mapMessageFiles(message, content => ({
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
}));

export const matchesFileIdentity = (remoteId: string | undefined, uniqueId: string | undefined,
  file: Pick<MessageFileState, "remoteId" | "remoteUniqueId">) =>
  uniqueId ? uniqueId === file.remoteUniqueId : Boolean(remoteId && remoteId === file.remoteId);

export const updateMessageFile = (message: Message, file: MessageFileState): Message => mapMessageFiles(message, content => {
  const main = content.fileId === file.fileId && (!content.remoteId && !content.remoteUniqueId ||
    matchesFileIdentity(content.remoteId, content.remoteUniqueId, file));
  const thumbnail = content.thumbnailFileId === file.fileId && (!content.thumbnailRemoteId && !content.thumbnailRemoteUniqueId ||
    matchesFileIdentity(content.thumbnailRemoteId, content.thumbnailRemoteUniqueId, file));
  if (!main && !thumbnail) return content;
  const patch: Partial<MessageFileContent> = {
    ...(main ? {
      ...file,
      remoteId: file.remoteId ?? content.remoteId,
      remoteUniqueId: file.remoteUniqueId ?? content.remoteUniqueId,
      // Only deletion archives own local copies independently of TDLib cache eviction.
      ...(message.isLocallyDeleted && !file.localPath && content.localPath ? {
        localPath: content.localPath, isDownloaded: true, isDownloading: false,
        downloadedSize: content.downloadedSize, progress: 1,
      } : {}),
    } : {}),
    ...(thumbnail ? {
      thumbnailRemoteId: file.remoteId ?? content.thumbnailRemoteId,
      thumbnailRemoteUniqueId: file.remoteUniqueId ?? content.thumbnailRemoteUniqueId,
      thumbnailPath: message.isLocallyDeleted ? file.localPath ?? content.thumbnailPath : file.localPath,
      thumbnailCanDownload: file.canDownload,
      thumbnailIsDownloading: file.isDownloading,
    } : {}),
  };
  return Object.keys(patch).some(key => patch[key as keyof MessageFileContent] !== content[key as keyof MessageFileContent])
    ? { ...content, ...patch } : content;
});

/** Resolve by persistent identity before exposing a runtime handle to download/playback callers. */
export const bindMessageFile = (message: Message, remoteId: string, file: MessageFileState): Message => {
  if (!Number.isSafeInteger(file.fileId) || file.fileId <= 0) return message;
  const bound = mapMessageFiles(message, content => {
    const main = content.fileId === undefined && content.remoteId === remoteId &&
      matchesFileIdentity(content.remoteId, content.remoteUniqueId, file);
    const thumbnail = content.thumbnailFileId === undefined && content.thumbnailRemoteId === remoteId &&
      matchesFileIdentity(content.thumbnailRemoteId, content.thumbnailRemoteUniqueId, file);
    return !main && !thumbnail ? content : {
      ...content,
      ...(main ? { fileId: file.fileId } : {}),
      ...(thumbnail ? { thumbnailFileId: file.fileId } : {}),
    };
  });
  return bound === message ? message : updateMessageFile(bound, file);
};
