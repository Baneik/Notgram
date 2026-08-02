import type { Message, TelegramAccount, User, Chat } from "../telegram/types";

interface CacheReferenceState {
  accounts: Iterable<TelegramAccount>;
  users: Iterable<User>;
  chats: Iterable<Chat>;
  messages: Iterable<Message[]>;
}

export const protectedCachePaths = ({ accounts, users, chats, messages }: CacheReferenceState) => {
  const paths = new Set<string>();
  const add = (path?: string) => {
    if (path) paths.add(path);
  };
  for (const account of accounts) add(account.avatar.imagePath);
  for (const user of users) add(user.avatar.imagePath);
  for (const chat of chats) add(chat.avatar.imagePath);
  for (const chatMessages of messages) {
    for (const message of chatMessages) {
      const content = message.content;
      if (content.kind !== "file" && content.kind !== "media") continue;
      add(content.localPath);
      add(content.thumbnailPath);
    }
  }
  return [...paths];
};
