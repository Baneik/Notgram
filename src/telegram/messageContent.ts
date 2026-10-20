import { translate } from "../i18n";
import { presentServiceEvent, servicePartsText } from "./serviceMessages";
import { isLargeEmojiText } from "../utils/largeEmoji";
import type { MessageContent, MessageRichBlock, MessageRichMedia, MessageRichTextRun } from "./types";

export const isCaptionContent = (content: MessageContent): content is Extract<MessageContent, { kind: "media" | "file" }> =>
  content.kind === "file" || (content.kind === "media" &&
    content.mediaType !== "sticker" && content.mediaType !== "videoNote");

export const isEditableMessageContent = (content: MessageContent) =>
  content.kind === "text" || isCaptionContent(content);

export const messageContentText = (content: MessageContent) => {
  if (content.kind === "service" && content.event) return servicePartsText(presentServiceEvent(content.event).parts);
  if (
    content.kind === "text" ||
    content.kind === "rich" ||
    content.kind === "service" ||
    content.kind === "unsupported"
  ) {
    return content.text;
  }
  if (content.kind === "poll") return content.question;
  return content.caption || content.fileName;
};

/**
 * Compact text for chat-list previews. Media file names are transport
 * metadata, not message text, so only real files keep their names here.
 */
export const messagePreviewText = (content: MessageContent) => {
  if (content.kind !== "media") return messageContentText(content);
  if (content.caption) return content.caption;
  return mediaTypeLabel(content.mediaType);
};

const mediaTypeLabel = (mediaType: Extract<MessageContent, { kind: "media" }>["mediaType"]) => {
  switch (mediaType) {
    case "photo": return translate("图片");
    case "video": return translate("视频");
    case "videoNote": return translate("视频消息");
    case "audio": return translate("音频");
    case "voice": return translate("语音消息");
    case "animation": return translate("动图");
    case "sticker": return translate("贴纸");
  }
};

const withCaption = (label: string, caption?: string) => caption?.trim()
  ? translate("{{value0}}，{{value1}}", { value0: label, value1: caption.trim() })
  : label;

type ReplyMedia = Pick<Extract<MessageContent, { kind: "media" }>,
  "mediaType" | "fileName" | "isDocument" | "fileNameIsGenerated" | "title" | "performer" | "stickerEmoji"
>;

const replyMediaLabel = (content: ReplyMedia): string => {
  if (content.isDocument) return content.fileNameIsGenerated ? translate("文件") : content.fileName.trim() || translate("文件");
  if (content.mediaType === "animation") return "GIF";
  if (content.mediaType === "sticker") {
    // Old snapshots stored the sticker emoji in fileName; never expose a cached file name.
    const emoji = content.stickerEmoji?.trim() || (isLargeEmojiText(content.fileName) ? content.fileName.trim() : "");
    return emoji ? translate("{{value0}} 贴纸", { value0: emoji }) : translate("贴纸");
  }
  if (content.mediaType === "audio") {
    const title = content.title?.trim();
    const performer = content.performer?.trim();
    if (performer) return `${performer} – ${title || "Unknown Track"}`;
    return title || (!content.fileNameIsGenerated && content.fileName.trim()) || "Unknown Track";
  }
  return mediaTypeLabel(content.mediaType);
};

export const richRunsText = (runs: MessageRichTextRun[]) => runs.map(({ text }) => text).join("");

export const richBlockText = (
  block: MessageRichBlock,
  mediaText: (media: MessageRichMedia) => string[] = media => [
    ...(media.caption ? [richRunsText(media.caption.text)] : []), media.fileName,
  ],
): string[] => {
  const nestedText = (blocks: MessageRichBlock[]) => blocks.flatMap(block => richBlockText(block, mediaText));
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "preformatted":
    case "footer":
    case "thinking": return [richRunsText(block.text)];
    case "mathematicalExpression": return [block.expression];
    case "anchor":
    case "divider": return [];
    case "list": return block.items.flatMap(item => nestedText(item.blocks));
    case "quote": return [...nestedText(block.blocks), ...(block.credit ? [richRunsText(block.credit)] : [])];
    case "details": return [richRunsText(block.summary), ...nestedText(block.blocks)];
    case "table": return [
      ...(block.caption ? [richRunsText(block.caption)] : []),
      ...block.rows.flatMap(row => row.map(cell => richRunsText(cell.text))),
    ];
    case "media": return mediaText(block.media);
    case "collection": return [...nestedText(block.blocks), ...(block.caption ? [richRunsText(block.caption.text)] : [])];
    case "map": return block.caption ? [richRunsText(block.caption.text)] : [translate("位置")];
  }
};

/** Text semantics shared by Desktop's in-message reply and composer header. */
export const messageReplyText = (content: MessageContent): string => {
  if (content.kind === "media") return withCaption(replyMediaLabel(content), content.caption);
  if (content.kind === "file") return withCaption(content.fileNameIsGenerated ? translate("文件") : content.fileName.trim() || translate("文件"), content.caption);
  if (content.kind === "rich") {
    const text = content.blocks.flatMap(block => richBlockText(block, media => [
      withCaption(replyMediaLabel(media), media.caption ? richRunsText(media.caption.text) : undefined),
    ])).filter(Boolean).join(" ");
    return text.trim() || translate("富文本消息");
  }
  if (content.kind === "text" && content.mediaPreview) {
    const preview = content.mediaPreview;
    switch (preview.type) {
      case "contact": return translate("联系人");
      case "location": return translate("位置");
      case "liveLocation": return translate("实时位置");
      case "venue": return withCaption(translate("位置"), preview.title);
      case "dice": return preview.emoji;
      case "game": return `🎮 ${preview.title?.trim() || translate("游戏")}`;
      case "invoice": return preview.title?.trim() || translate("账单");
      case "checklist": return preview.title?.trim() || translate("清单");
      case "paidMedia": return withCaption(translate("付费媒体"), preview.title);
      case "story": return translate("故事");
    }
  }
  return messageContentText(content);
};
