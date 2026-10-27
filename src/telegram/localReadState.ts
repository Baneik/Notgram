import { readAccountMetadata, writeAccountMetadata } from "../store/accountMetadata";
import type { Chat, Message } from "./types";

export const LOCAL_READ_STATE_KEY = "notgram:local-read-state:v1";
export interface ReadCursor { id: string; sentAt: string }
interface AttentionRead { id: string; topicId?: string; signature?: string }
export interface LocalReadRecord {
  accountId: string;
  chatId: string;
  topicId?: string;
  through?: ReadCursor;
  unreadCount?: number;
  mentionCount?: number;
  reactionCount?: number;
  mentions?: AttentionRead[];
  reactions?: AttentionRead[];
}

export const compareReadCursors = (left: ReadCursor, right: ReadCursor) => {
  if (left.id === right.id) return 0;
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) return BigInt(left.id) > BigInt(right.id) ? 1 : -1;
  return left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id, undefined, { numeric: true });
};
export const readCursor = (message: Pick<Message, "id" | "sentAt">): ReadCursor => ({ id: message.id, sentAt: message.sentAt });
export const atReadCursor = (message: Pick<Message, "id" | "sentAt">, cursor?: ReadCursor) =>
  Boolean(cursor && compareReadCursors(readCursor(message), cursor) <= 0);
const reactionSignature = (message: Message) => JSON.stringify(message.unreadReactions ?? []);
const scopeKey = (chatId: string, topicId?: string) => JSON.stringify([chatId, topicId ?? null]);
const validCount = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
export type ReadCountSource = Pick<Chat, "id" | "unreadCount" | "unreadMentionCount" | "unreadReactionCount" | "lastReadInboxMessageId"> & {
  chatId?: string;
  lastMessage?: Pick<Message, "id" | "sentAt">;
};

/** Durable read cursors are independent of the replaceable, bounded message cache. */
export class LocalReadState {
  private records: LocalReadRecord[] = [];
  private accountId = "default";

  load(accountId: string) {
    const value: unknown = JSON.parse(readAccountMetadata(LOCAL_READ_STATE_KEY) ?? "[]");
    if (!Array.isArray(value) || value.some(record => !record || typeof record !== "object" ||
      typeof record.accountId !== "string" || typeof record.chatId !== "string" ||
      (record.topicId !== undefined && typeof record.topicId !== "string") ||
      (record.through !== undefined && (typeof record.through?.id !== "string" || typeof record.through?.sentAt !== "string")) ||
      ![record.unreadCount, record.mentionCount, record.reactionCount].every(validCount) ||
      [record.mentions, record.reactions].some(entries => entries !== undefined &&
        (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== "string" ||
          (entry.topicId !== undefined && typeof entry.topicId !== "string") ||
          (entry.signature !== undefined && typeof entry.signature !== "string")))))) {
      throw new Error("Invalid local reading state; existing data has been preserved");
    }
    this.accountId = accountId;
    this.records = value;
  }

  save() {
    const value = JSON.stringify(this.records);
    if (value !== readAccountMetadata(LOCAL_READ_STATE_KEY)) writeAccountMetadata(LOCAL_READ_STATE_KEY, value);
  }
  removeAccount(accountId: string) {
    this.records = this.records.filter(record => record.accountId !== accountId);
    this.save();
  }
  migrateChat(from: string, to: string) {
    for (const record of this.records) {
      if (record.accountId !== this.accountId || record.chatId !== from) continue;
      const existing = this.get(to, record.topicId);
      if (existing) {
        if (record.through && (!existing.through || compareReadCursors(record.through, existing.through) > 0)) existing.through = record.through;
        existing.mentions = [...new Map([...(existing.mentions ?? []), ...(record.mentions ?? [])].map(entry => [entry.id, entry])).values()];
        existing.reactions = [...new Map([...(existing.reactions ?? []), ...(record.reactions ?? [])].map(entry => [entry.id, entry])).values()];
        this.records = this.records.filter(candidate => candidate !== record);
      } else record.chatId = to;
    }
    this.save();
  }
  get(chatId: string, topicId?: string) {
    return this.records.find(record => record.accountId === this.accountId && scopeKey(record.chatId, record.topicId) === scopeKey(chatId, topicId));
  }
  ensure(chatId: string, topicId?: string) {
    let record = this.get(chatId, topicId);
    if (!record) { record = { accountId: this.accountId, chatId, topicId }; this.records.push(record); }
    return record;
  }
  scopes(chatId: string) { return this.records.filter(record => record.accountId === this.accountId && record.chatId === chatId); }
  has(chatId: string) { return this.scopes(chatId).length > 0; }
  hasAny() { return this.records.some(record => record.accountId === this.accountId); }
  hasReads(chatId: string) { return this.scopes(chatId).some(record => record.through); }
  read(chatId: string, cursor: ReadCursor, topicId?: string) {
    const record = this.ensure(chatId, topicId);
    if (!record.through || compareReadCursors(cursor, record.through) > 0) record.through = cursor;
    record.unreadCount = 0;
    this.ensure(chatId);
  }
  isRead(message: Pick<Message, "id" | "sentAt" | "chatId" | "topicId">) {
    return atReadCursor(message, this.get(message.chatId)?.through) ||
      Boolean(message.topicId && atReadCursor(message, this.get(message.chatId, message.topicId)?.through));
  }
  acknowledge(message: Message, reactionsOnly = false) {
    const record = this.ensure(message.chatId);
    if (message.topicId) this.ensure(message.chatId, message.topicId);
    if (!reactionsOnly && message.containsUnreadMention && !record.mentions?.some(entry => entry.id === message.id)) {
      (record.mentions ??= []).push({ id: message.id, topicId: message.topicId });
    }
    if (message.containsUnreadReaction) {
      record.reactions = (record.reactions ?? []).filter(entry => entry.id !== message.id);
      record.reactions.push({ id: message.id, topicId: message.topicId, signature: reactionSignature(message) });
    }
  }
  mentionRead(message: Pick<Message, "chatId" | "id">) {
    return this.get(message.chatId)?.mentions?.some(entry => entry.id === message.id) ?? false;
  }
  reactionRead(message: Message) {
    return this.get(message.chatId)?.reactions?.some(entry => entry.id === message.id && entry.signature === reactionSignature(message)) ?? false;
  }
  projectMessage(message: Message): Message {
    const mention = message.containsUnreadMention && this.mentionRead(message);
    const reaction = message.containsUnreadReaction && this.reactionRead(message);
    return mention || reaction ? { ...message,
      ...(mention ? { containsUnreadMention: false } : {}),
      ...(reaction ? { containsUnreadReaction: false, unreadReactions: [] } : {}),
    } : message;
  }
  project<T extends ReadCountSource>(source: T, topicId?: string): T {
    const chatId = source.chatId ?? source.id;
    const root = this.get(chatId);
    const record = topicId ? this.get(chatId, topicId) : root;
    if (!record && !root) return source;
    const localThrough = root?.through && (!record?.through || compareReadCursors(root.through, record.through) > 0)
      ? root.through : record?.through;
    const serverThrough = source.lastReadInboxMessageId;
    const serverCaughtUp = localThrough && serverThrough && /^\d+$/.test(serverThrough) && /^\d+$/.test(localThrough.id) &&
      BigInt(serverThrough) >= BigInt(localThrough.id);
    const cursor = localThrough && !serverCaughtUp ? localThrough.id : serverThrough;
    const topicAlreadyRead = topicId && "lastMessage" in source && source.lastMessage && atReadCursor(source.lastMessage, localThrough);
    return { ...source,
      unreadCount: topicAlreadyRead ? 0 : serverCaughtUp && !topicId && this.scopes(chatId).some(scope => scope.topicId && scope.through)
        ? Math.min(source.unreadCount, record?.unreadCount ?? source.unreadCount)
        : serverCaughtUp ? source.unreadCount : Math.min(source.unreadCount, record?.unreadCount ?? source.unreadCount),
      lastReadInboxMessageId: cursor,
      unreadMentionCount: Math.min(source.unreadMentionCount, record?.mentionCount ?? source.unreadMentionCount),
      unreadReactionCount: Math.min(source.unreadReactionCount ?? 0, record?.reactionCount ?? source.unreadReactionCount ?? 0),
    };
  }
}
