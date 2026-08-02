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
  return content.caption || content.fileName;
};
