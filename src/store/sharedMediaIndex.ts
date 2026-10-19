import { messageExpired } from "../telegram/messageLifecycle";
import { memoryCacheBudget } from "../media/memoryCacheBudget";
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
  bytes: number;
}

const cacheKey = (chatId: string, category: SharedMediaCategory, query = "") =>
  `${chatId}\u0000${category}\u0000${query.trim().toLocaleLowerCase()}`;

export const mergeSharedMediaMessages = (current: Message[], incoming: Message[]) => [...new Map(
  [...current, ...incoming].map((message) => [message.id, message]),
).values()].sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));

export class SharedMediaIndex {
  private entries = new Map<string, SharedMediaCacheEntry>();
  private bytes = 0;
  private messageCount = 0;

  readonly memoryCache = {
    read: () => ({ entries: this.messageCount, bytes: this.bytes }),
    trim: (idleBefore: number) => this.prune(Date.now(), idleBefore),
  };

  constructor(private readonly ttlMs = DEFAULT_TTL_MS, private readonly maxEntries = 100) {}

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.messageCount = 0;
  }

  private forget(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.messageCount -= entry.messages.length;
  }

  private prune(now: number, idleBefore = -Infinity) {
    for (const [key, entry] of this.entries) {
      if (now - entry.cachedAt > this.ttlMs || entry.cachedAt <= idleBefore) this.forget(key);
    }
    while (this.entries.size > this.maxEntries || this.messageCount > MAX_MESSAGES_PER_ENTRY ||
      this.bytes > memoryCacheBudget("sharedMedia")) {
      this.forget(this.entries.keys().next().value!);
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
    const mergedMessages = mergeSharedMediaMessages(current?.messages ?? [], page.messages);
    const messages = mergedMessages.slice(0, MAX_MESSAGES_PER_ENTRY);
    const entry: SharedMediaCacheEntry = {
      // Keep a generous bounded result set. Never report the server as exhausted
      // when local capacity trimmed older rows.
      messages,
      totalCount: page.totalCount ?? current?.totalCount,
      nextFromMessageId: page.nextFromMessageId,
      hasMore: page.hasMore || mergedMessages.length > messages.length,
      cachedAt: now,
      // An estimate of retained message data; decoded media belongs to other caches.
      bytes: JSON.stringify(messages).length * 2,
    };
    this.forget(key);
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.messageCount += entry.messages.length;
    this.prune(now);
    return { ...entry, messages: structuredClone(entry.messages.filter((message) => !messageExpired(message, now))), cached: false } satisfies SharedMediaPage;
  }

  remove(chatId: string, messageIds: string[]) {
    const removed = new Set(messageIds);
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${chatId}\u0000`)) continue;
      const messages = entry.messages.filter((message) => !removed.has(message.id));
      this.bytes -= entry.bytes;
      this.messageCount -= entry.messages.length - messages.length;
      const bytes = JSON.stringify(messages).length * 2;
      this.bytes += bytes;
      this.entries.set(key, {
        ...entry,
        messages,
        bytes,
        totalCount: entry.totalCount === undefined
          ? undefined
          : Math.max(0, entry.totalCount - (entry.messages.length - messages.length)),
      });
    }
  }

  clearChat(chatId: string) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${chatId}\u0000`)) this.forget(key);
    }
  }
}
