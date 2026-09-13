import type { Chat, ChatKind, User } from "../telegram/types";

export type FolderChatKind = ChatKind | "bot";
export type FolderChatFilter = FolderChatKind | "all" | "uncategorized";
export const FOLDER_DIRECT_CHAT_LIMIT = 400;

/** TDLib does not allow Saved Messages or chats without a current list position in folders. */
export const isFolderChatEligible = (chat: Chat) =>
  chat.kind !== "saved" && chat.folderIds.length > 0;

export const folderChatKind = (chat: Chat, users: ReadonlyMap<string, User>): FolderChatKind =>
  chat.kind === "direct" && chat.peerId && users.get(chat.peerId)?.isBot ? "bot" : chat.kind;

export const filterFolderChats = (
  chats: readonly Chat[],
  users: ReadonlyMap<string, User>,
  priorityIds: ReadonlySet<string>,
  query: string,
  filter: FolderChatFilter,
  language: string,
) => {
  const normalized = query.trim().toLocaleLowerCase(language);
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  return chats.filter((chat) => {
    if (normalized && !chat.title.toLocaleLowerCase(language).includes(normalized)) return false;
    if (filter === "uncategorized") {
      // Unclassified means a confirmed main-list chat with no archive or custom-folder membership.
      return isFolderChatEligible(chat) && chat.folderIds.includes("main") && chat.folderIds.every((id) => id === "main");
    }
    return filter === "all" || folderChatKind(chat, users) === filter;
  }).sort((left, right) =>
    Number(priorityIds.has(right.id)) - Number(priorityIds.has(left.id)) ||
    collator.compare(left.title, right.title) ||
    // Equal names must not inherit the message-driven order of the source list.
    (left.id === right.id ? 0 : left.id < right.id ? -1 : 1),
  );
};
