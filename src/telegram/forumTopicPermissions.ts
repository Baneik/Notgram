import type { Chat, ForumTopic } from "./types";

export const canDeleteForumTopic = (chat: Chat, topic: ForumTopic) =>
  chat.isForum === true && chat.isMember !== false && !topic.isGeneral && (
    chat.management?.status === "owner" ||
    chat.management?.adminRights?.canDeleteMessages === true ||
    // TDLib additionally checks that an author's topic has at most 11 messages
    // and no messages from others. Only the server can establish that coverage.
    topic.isOutgoing
  );
