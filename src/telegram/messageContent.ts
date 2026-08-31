import { translate } from "../i18n";
import type { MessageContent } from "./types";

export const messageContentText = (content: MessageContent) => {
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
  switch (content.mediaType) {
    case "photo": return translate("图片");
    case "video": return translate("视频");
    case "videoNote": return translate("视频消息");
    case "audio": return translate("音频");
    case "voice": return translate("语音消息");
    case "animation": return translate("动图");
    case "sticker": return translate("贴纸");
  }
};
