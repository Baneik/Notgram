import type { Chat, ChatKind, User } from "../telegram/types";

export type FolderChatKind = ChatKind | "bot";
export type FolderChatFilter = FolderChatKind | "all" | "uncategorized";

export const folderChatKind = (chat: Chat, users: ReadonlyMap<string, User>): FolderChatKind =>
  chat.kind === "direct" && chat.peerId && users.get(chat.peerId)?.isBot ? "bot" : chat.kind;

export const filterFolderChats = (
  chats: readonly Chat[],
  users: ReadonlyMap<string, User>,
  selectedIds: ReadonlySet<string>,
  query: string,
  filter: FolderChatFilter,
  language: string,
) => {
  const normalized = query.trim().toLocaleLowerCase(language);
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  return chats.filter((chat) => {
    if (normalized && !chat.title.toLocaleLowerCase(language).includes(normalized)) return false;
    if (filter === "uncategorized") {
      // Use confirmed membership, including Archive, so draft selections stay visible until saved.
      return !chat.folderIds.some((id) => id !== "main");
    }
    return filter === "all" || folderChatKind(chat, users) === filter;
  }).sort((left, right) =>
    Number(selectedIds.has(right.id)) - Number(selectedIds.has(left.id)) ||
    collator.compare(left.title, right.title) ||
    // Equal names must not inherit the message-driven order of the source list.
    (left.id === right.id ? 0 : left.id < right.id ? -1 : 1),
  );
};
