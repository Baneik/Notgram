import { messageExpired } from "../telegram/messageLifecycle";
import type {
  Message,
  SharedMediaCategory,
  SharedMediaPage,
  SharedMediaSearchInput,
} from "../telegram/types";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_MESSAGES_PER_ENTRY = 5_000;

interface SharedMediaCacheEntry extends SharedMediaPage {
  cachedAt: number;
}

const cacheKey = (chatId: string, category: SharedMediaCategory, query = "") =>
  `${chatId}\u0000${category}\u0000${query.trim().toLocaleLowerCase()}`;

const mergeMessages = (current: Message[], incoming: Message[]) => [...new Map(
  [...current, ...incoming].map((message) => [message.id, message]),
).values()].sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));

export class SharedMediaIndex {
  private entries = new Map<string, SharedMediaCacheEntry>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS, private readonly maxEntries = 100) {}

  clear() {
    this.entries.clear();
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.cachedAt > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  read(input: Pick<SharedMediaSearchInput, "chatId" | "category" | "query">, now = Date.now()) {
    this.prune(now);
    const key = cacheKey(input.chatId, input.category, input.query);
    const entry = this.entries.get(key);
    if (!entry || now - entry.cachedAt > this.ttlMs) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry, messages: structuredClone(entry.messages.filter((message) => !messageExpired(message, now))), cached: true } satisfies SharedMediaPage;
  }

  merge(input: SharedMediaSearchInput, page: SharedMediaPage, reset: boolean, now = Date.now()) {
    this.prune(now);
    const key = cacheKey(input.chatId, input.category, input.query);
    const current = reset ? undefined : this.entries.get(key);
    const mergedMessages = mergeMessages(current?.messages ?? [], page.messages);
    const messages = mergedMessages.slice(0, MAX_MESSAGES_PER_ENTRY);
    const entry: SharedMediaCacheEntry = {
      // Keep a generous bounded result set. Never report the server as exhausted
      // when local capacity trimmed older rows.
      messages,
      totalCount: page.totalCount ?? current?.totalCount,
      nextFromMessageId: page.nextFromMessageId,
      hasMore: page.hasMore || mergedMessages.length > messages.length,
      cachedAt: now,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(now);
    return { ...entry, messages: structuredClone(entry.messages.filter((message) => !messageExpired(message, now))), cached: false } satisfies SharedMediaPage;
  }

  remove(chatId: string, messageIds: string[]) {
    const removed = new Set(messageIds);
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${chatId}\u0000`)) continue;
      const messages = entry.messages.filter((message) => !removed.has(message.id));
      this.entries.set(key, {
        ...entry,
        messages,
        totalCount: entry.totalCount === undefined
          ? undefined
          : Math.max(0, entry.totalCount - (entry.messages.length - messages.length)),
      });
    }
  }

  clearChat(chatId: string) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${chatId}\u0000`)) this.entries.delete(key);
    }
  }
}
