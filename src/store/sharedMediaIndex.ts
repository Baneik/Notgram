import type {
  Message,
  SharedMediaCategory,
  SharedMediaPage,
  SharedMediaSearchInput,
} from "../telegram/types";

const DEFAULT_TTL_MS = 5 * 60_000;

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

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  read(input: Pick<SharedMediaSearchInput, "chatId" | "category" | "query">, now = Date.now()) {
    const entry = this.entries.get(cacheKey(input.chatId, input.category, input.query));
    if (!entry || now - entry.cachedAt > this.ttlMs) return undefined;
    return { ...entry, messages: structuredClone(entry.messages), cached: true } satisfies SharedMediaPage;
  }

  merge(input: SharedMediaSearchInput, page: SharedMediaPage, reset: boolean, now = Date.now()) {
    const key = cacheKey(input.chatId, input.category, input.query);
    const current = reset ? undefined : this.entries.get(key);
    const entry: SharedMediaCacheEntry = {
      messages: mergeMessages(current?.messages ?? [], page.messages),
      totalCount: page.totalCount ?? current?.totalCount,
      nextFromMessageId: page.nextFromMessageId,
      hasMore: page.hasMore,
      cachedAt: now,
    };
    this.entries.set(key, entry);
    return { ...entry, messages: structuredClone(entry.messages), cached: false } satisfies SharedMediaPage;
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
