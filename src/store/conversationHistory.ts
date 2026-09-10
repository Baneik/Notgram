import type { CachedHistoryContext, ChatHistoryPage, HistoryPageRequest, Message } from "../telegram/types";
import { SyncRetryQueue } from "../telegram/syncRetryQueue";
import { compareMessages, reachedCachedHistoryBoundary } from "./telegramStore.messages";

export const HISTORY_REFRESH_PAGE_BUDGET = 9;
const HISTORY_RETRY_BUDGET = 3;

export interface HistoryWindowView {
  id: string;
  /** Context-only records remain cached without entering the latest timeline. */
  excludedIds: ReadonlySet<string>;
  messageIds?: ReadonlySet<string>;
}

export interface ConversationHistoryState {
  loading: boolean;
  background?: boolean;
  hasMore: boolean;
  initialized: boolean;
  view?: HistoryWindowView;
  recovery?: "refreshing" | "complete" | "paused" | "failed";
}

export const historyScopeKey = (chatId: string, topicId?: string) =>
  topicId ? `${chatId}:topic:${topicId}` : chatId;

export const projectHistoryWindow = (messages: Message[], view?: HistoryWindowView) => {
  if (!view) return messages;
  const projected = view.messageIds
    ? messages.filter(message => view.messageIds!.has(message.id))
    : messages.filter(message => !view.excludedIds.has(message.id));
  return projected.length === messages.length ? messages : projected;
};

interface Window {
  id: string;
  ids: Set<string>;
  cursor?: string;
  hasMore: boolean;
  failures?: number;
  loading?: boolean;
}

interface Refresh {
  boundary: Set<string>;
  cursor?: string;
  pages: number;
  failures: number;
  advancesReader: boolean;
  ownedCursor?: string;
}

interface Scope {
  chatId: string;
  topicId?: string;
  latest: Window;
  contexts: Map<string, Window>;
  selected: Window;
  excluded: Set<string>;
  needsRefresh: boolean;
  refresh?: Refresh;
  targetId?: string;
  view?: HistoryWindowView;
  firstPage?: { promise: Promise<void>; resolve: () => void };
}

interface HistoryHost {
  online: () => boolean;
  active: (chatId: string, topicId?: string) => boolean;
  messages: (chatId: string, topicId?: string) => Message[];
  state: (chatId: string, topicId?: string) => ConversationHistoryState | undefined;
  publish: (chatId: string, topicId: string | undefined, state: ConversationHistoryState, page?: ChatHistoryPage) => void;
  request: (chatId: string, topicId: string | undefined, request: HistoryPageRequest) => Promise<ChatHistoryPage>;
  error: (error: unknown, topicId?: string) => void;
  diagnostic: (chatId: string, details: Record<string, number | boolean>) => void;
}

/** Owns refresh and reader cursors independently. A context read is never a
 * request to scan the gap between that context and the latest messages. */
export class ConversationHistory {
  private scopes = new Map<string, Scope>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;
  private retries: SyncRetryQueue;

  constructor(private readonly host: HistoryHost) {
    this.retries = new SyncRetryQueue(host.online);
  }

  private scope(chatId: string, topicId?: string) {
    const key = historyScopeKey(chatId, topicId);
    let scope = this.scopes.get(key);
    if (!scope) {
      const latest: Window = { id: "latest", ids: new Set(this.host.messages(chatId, topicId).map(message => message.id)), hasMore: true };
      scope = { chatId, topicId, latest, selected: latest, contexts: new Map(), excluded: new Set(), needsRefresh: true };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  private current(scope: Scope, generation: number) {
    return generation === this.generation && this.scopes.get(historyScopeKey(scope.chatId, scope.topicId)) === scope;
  }

  cachedContexts(messages: Message[]): CachedHistoryContext[] {
    const cached = new Map<string, Set<string>>();
    for (const message of messages) {
      const ids = cached.get(message.chatId) ?? new Set<string>();
      ids.add(message.id);
      cached.set(message.chatId, ids);
    }
    return [...this.scopes.values()].flatMap(scope => [...scope.contexts.values()].flatMap(window => {
      const messageIds = [...window.ids].filter(id => scope.excluded.has(id) && cached.get(scope.chatId)?.has(id));
      return messageIds.length ? [{ chatId: scope.chatId, topicId: scope.topicId, targetId: window.id.slice("context:".length), messageIds }] : [];
    }));
  }

  restoreContexts(contexts: CachedHistoryContext[]) {
    for (const context of contexts) {
      const scope = this.scope(context.chatId, context.topicId);
      const ids = new Set(context.messageIds);
      const messages = this.host.messages(context.chatId, context.topicId).filter(message => ids.has(message.id));
      if (!messages.length) continue;
      const window: Window = { id: `context:${context.targetId}`, ids: new Set(messages.map(message => message.id)), cursor: messages[0]?.id, hasMore: true };
      scope.contexts.set(window.id, window);
      scope.excluded = new Set([...scope.excluded, ...window.ids]);
      this.publish(scope);
    }
  }

  private view(scope: Scope): HistoryWindowView {
    const ids = scope.selected === scope.latest ? undefined : scope.selected.ids;
    if (scope.view?.id === scope.selected.id && scope.view.excludedIds === scope.excluded && scope.view.messageIds === ids) return scope.view;
    scope.view = { id: scope.selected.id, excludedIds: scope.excluded, messageIds: ids };
    return scope.view;
  }

  private publish(scope: Scope, patch: Partial<ConversationHistoryState> = {}, page?: ChatHistoryPage) {
    const previous = this.host.state(scope.chatId, scope.topicId);
    this.host.publish(scope.chatId, scope.topicId, {
      loading: false, initialized: previous?.initialized ?? false,
      ...previous, ...patch, hasMore: scope.selected.hasMore, view: this.view(scope),
      ...(scope.selected.loading ? { loading: true, background: false } : {}),
    }, page);
  }

  clear() {
    this.generation++;
    this.retries.clear();
    this.pending.clear();
    this.scopes.clear();
  }

  invalidate() {
    this.generation++;
    this.retries.clear();
    this.pending.clear();
    for (const scope of this.scopes.values()) {
      scope.needsRefresh = true;
      const newest = this.host.messages(scope.chatId, scope.topicId)
        .filter(message => !scope.excluded.has(message.id) && !message.isLocallyDeleted &&
          !message.isPending && message.delivery !== "sending" && message.delivery !== "failed").at(-1);
      scope.refresh = { boundary: new Set(newest ? [newest.id] : []), pages: 0, failures: 0,
        advancesReader: !scope.latest.cursor, ownedCursor: scope.latest.cursor };
      for (const window of [scope.latest, ...scope.contexts.values()]) {
        window.loading = false;
        window.failures = 0;
      }
      this.publish(scope, { loading: false, background: false, recovery: undefined });
    }
  }

  discard(chatId: string) {
    for (const [key, scope] of this.scopes) {
      if (scope.chatId !== chatId) continue;
      this.scopes.delete(key);
      for (const pendingKey of this.pending.keys()) {
        if (pendingKey.startsWith(`${key}:`)) this.pending.delete(pendingKey);
      }
    }
  }

  /** Navigation selects a window synchronously with its viewport request. */
  focus(chatId: string, topicId?: string, messageId?: string) {
    const scope = this.scope(chatId, topicId);
    scope.targetId = messageId;
    let selected = scope.latest;
    if (messageId && scope.excluded.has(messageId)) {
      selected = [...scope.contexts.values()].find(window => window.ids.has(messageId)) ?? scope.latest;
    }
    const changed = scope.selected !== selected;
    scope.selected = selected;
    this.publish(scope);
    return changed;
  }

  context(chatId: string, topicId: string | undefined, targetId: string, messages: Message[]) {
    const scope = this.scope(chatId, topicId);
    const scoped = messages.filter(message => message.chatId === chatId && (!topicId || message.topicId === topicId));
    if (scoped.length === 0) return;
    // Use pre-context cache membership, not the merged Store, to establish overlap.
    const latestIds = new Set(this.host.messages(chatId, topicId)
      .filter(message => !scope.excluded.has(message.id)).map(message => message.id));
    if (scoped.some(message => latestIds.has(message.id))) {
      for (const message of scoped) scope.latest.ids.add(message.id);
      if (scoped.some(message => scope.excluded.has(message.id))) {
        const returned = new Set(scoped.map(message => message.id));
        scope.excluded = new Set([...scope.excluded].filter(id => !returned.has(id)));
        if (scope.targetId && returned.has(scope.targetId)) scope.selected = scope.latest;
        this.publish(scope);
      }
      return;
    }
    const returnedIds = new Set(scoped.map(message => message.id));
    const overlapping = [...scope.contexts.values()].filter(window => [...window.ids].some(id => returnedIds.has(id)));
    const previous = overlapping.find(window => window === scope.selected) ?? overlapping[0];
    const existing = previous ? this.host.messages(chatId, topicId).filter(message => previous.ids.has(message.id)) : [];
    const ordered = [...existing, ...scoped].sort(compareMessages);
    const window: Window = previous ?? { id: `context:${targetId}`, ids: new Set(), hasMore: true };
    const cursor = ordered[0]?.id;
    if (cursor !== window.cursor) window.hasMore = true;
    window.ids = new Set([...window.ids, ...returnedIds]);
    window.cursor = cursor;
    scope.contexts.set(window.id, window);
    scope.excluded = new Set([...scope.excluded, ...window.ids]);
    if ((scope.targetId && window.ids.has(scope.targetId)) || scope.selected.id === window.id) scope.selected = window;
    this.publish(scope);
  }

  replace(chatId: string, oldId: string, newId: string) {
    for (const scope of this.scopes.values()) {
      if (scope.chatId !== chatId) continue;
      for (const window of [scope.latest, ...scope.contexts.values()]) {
        if (!window.ids.has(oldId)) continue;
        window.ids = new Set([...window.ids].filter(id => id !== oldId));
        window.ids.add(newId);
        if (window.cursor === oldId) window.cursor = newId;
      }
      if (scope.excluded.has(oldId)) {
        scope.excluded = new Set([...scope.excluded].filter(id => id !== oldId));
        scope.excluded.add(newId);
      }
      this.publish(scope);
    }
  }

  ensure(chatId: string, topicId?: string) {
    const scope = this.scope(chatId, topicId);
    if (!scope.needsRefresh || (scope.refresh && this.host.state(chatId, topicId)?.recovery === "paused")) return Promise.resolve();
    if (this.host.messages(chatId, topicId).length > 0) {
      this.publish(scope, { initialized: true });
      const generation = this.generation;
      queueMicrotask(() => { if (this.current(scope, generation)) void this.refresh(scope); });
      return Promise.resolve();
    }
    if (!scope.firstPage) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      scope.firstPage = { promise, resolve };
    }
    const first = scope.firstPage;
    void this.refresh(scope).finally(() => first.resolve());
    return first.promise;
  }

  older(chatId: string, topicId?: string) {
    const scope = this.scope(chatId, topicId);
    if (scope.selected === scope.latest && scope.refresh && this.host.state(chatId, topicId)?.recovery === "paused") {
      scope.refresh.pages = 0;
      scope.refresh.failures = 0;
      return this.refresh(scope);
    }
    if (this.host.state(chatId, topicId)?.hasMore !== false) scope.selected.hasMore = true;
    if (!scope.selected.cursor) {
      const refresh = this.pending.get(`${historyScopeKey(chatId, topicId)}:refresh`);
      if (refresh) return refresh;
    }
    return this.readOlder(scope, scope.selected);
  }

  private run(key: string, operation: () => Promise<void>) {
    if (!this.host.online()) return Promise.resolve();
    const existing = this.pending.get(key);
    if (existing) return existing;
    // Register ownership before any synchronous Store notification can re-enter.
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.pending.set(key, promise);
    const release = () => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    };
    void operation().then(() => { release(); resolve(); }, error => { release(); reject(error); });
    return promise;
  }

  private accept(scope: Scope, window: Window, page: ChatHistoryPage) {
    window.ids = new Set([...window.ids, ...page.messageIds]);
    window.cursor = page.nextFromMessageId ?? page.messageIds.at(-1) ?? window.cursor;
    window.hasMore = page.hasMore;
    if (window === scope.latest && page.messageIds.some(id => scope.excluded.has(id))) {
      scope.excluded = new Set([...scope.excluded].filter(id => !page.messageIds.includes(id)));
      // A cold unread context can arrive before the head page. Once that page
      // covers the entire context, it is part of the live timeline, not a frozen
      // finite window that would hide subsequently received messages.
      if (scope.selected !== scope.latest && [...scope.selected.ids].every(id => !scope.excluded.has(id))) {
        scope.selected = scope.latest;
      }
    }
  }

  private retry(scope: Scope, operation: () => Promise<void>, window?: Window) {
    return this.host.active(scope.chatId, scope.topicId) && (!window || scope.selected === window)
      ? operation() : Promise.resolve();
  }

  private refresh(scope: Scope) {
    const key = `${historyScopeKey(scope.chatId, scope.topicId)}:refresh`;
    const generation = this.generation;
    return this.run(key, async () => {
      if (!this.current(scope, generation)) return;
      const newest = this.host.messages(scope.chatId, scope.topicId)
        .filter(message => !scope.excluded.has(message.id) && !message.isLocallyDeleted &&
          !message.isPending && message.delivery !== "sending" && message.delivery !== "failed").at(-1);
      const refresh = scope.refresh ??= { boundary: new Set(newest ? [newest.id] : []), pages: 0, failures: 0,
        advancesReader: !scope.latest.cursor, ownedCursor: scope.latest.cursor };
      const startedAt = performance.now();
      const beforeCount = this.host.messages(scope.chatId, scope.topicId).length;
      this.publish(scope, { loading: true, background: this.host.messages(scope.chatId, scope.topicId).length > 0, recovery: "refreshing" });
      let stopReason = 0;
      try {
        while (refresh.pages < HISTORY_REFRESH_PAGE_BUDGET) {
          const page = await this.host.request(scope.chatId, scope.topicId, { purpose: "refresh", fromMessageId: refresh.cursor });
          if (!this.current(scope, generation)) return;
          const previousCursor = refresh.cursor;
          refresh.cursor = page.nextFromMessageId ?? page.messageIds.at(-1) ?? refresh.cursor;
          refresh.pages++;
          // Refresh must not consume an existing reader's older cursor.
          const previousReaderCursor = scope.latest.cursor;
          const previousHasMore = scope.latest.hasMore;
          const advancesReader = refresh.advancesReader && refresh.ownedCursor === previousReaderCursor;
          this.accept(scope, scope.latest, page);
          if (!advancesReader) {
            scope.latest.cursor = previousReaderCursor;
            scope.latest.hasMore = previousHasMore && page.hasMore;
          } else refresh.ownedCursor = scope.latest.cursor;
          const boundaryReached = refresh.boundary.size === 0 ||
            page.messageIds.some(id => refresh.boundary.has(id)) ||
            reachedCachedHistoryBoundary(refresh.boundary, new Set(page.messageIds));
          const complete = !page.hasMore || (!page.stalled && boundaryReached);
          stopReason = complete ? 1 : page.stalled || refresh.cursor === previousCursor ? 2 : 0;
          this.publish(scope, { loading: false, background: false, initialized: true, recovery: complete ? "complete" : "refreshing" }, page);
          scope.firstPage?.resolve();
          if (complete) {
            scope.needsRefresh = false;
            scope.refresh = undefined;
            this.retries.complete(key);
            break;
          }
          if (stopReason === 2) {
            if (++refresh.failures < HISTORY_RETRY_BUDGET) this.retries.schedule(key, () => this.retry(scope, () => this.refresh(scope)));
            break;
          }
          if (!this.host.active(scope.chatId, scope.topicId)) { stopReason = 3; break; }
        }
        if (scope.needsRefresh) {
          this.publish(scope, { loading: false, background: false, recovery: "paused" });
          if (stopReason === 0) stopReason = 4;
        }
      } catch (error) {
        if (!this.current(scope, generation)) return;
        this.host.error(error, scope.topicId);
        this.publish(scope, { loading: false, background: false, recovery: "failed" });
        if (++refresh.failures < HISTORY_RETRY_BUDGET) this.retries.schedule(key, () => this.retry(scope, () => this.refresh(scope)), error);
        stopReason = 5;
      }
      this.host.diagnostic(scope.chatId, { durationMs: performance.now() - startedAt, purpose: 1,
        beforeCount, afterCount: this.host.messages(scope.chatId, scope.topicId).length,
        localCacheHit: beforeCount > 0, failed: stopReason === 5,
        pageCount: refresh.pages, stopReason, remainingBoundaryCount: scope.needsRefresh ? refresh.boundary.size : 0 });
    });
  }

  private readOlder(scope: Scope, window: Window) {
    if (!window.hasMore) return Promise.resolve();
    const key = `${historyScopeKey(scope.chatId, scope.topicId)}:older:${window.id}`;
    const generation = this.generation;
    return this.run(key, async () => {
      if (!this.current(scope, generation)) return;
      const startedAt = performance.now();
      window.loading = true;
      this.publish(scope, { loading: true, background: scope.selected !== window });
      try {
        const page = await this.host.request(scope.chatId, scope.topicId, { purpose: "older", fromMessageId: window.cursor });
        if (!this.current(scope, generation)) return;
        window.loading = false;
        this.accept(scope, window, page);
        if (window !== scope.latest) {
          const latestIds = new Set(this.host.messages(scope.chatId, scope.topicId).filter(message => !scope.excluded.has(message.id)).map(message => message.id));
          scope.excluded = new Set([...scope.excluded, ...page.messageIds.filter(id => !latestIds.has(id))]);
        }
        this.publish(scope, { loading: false, background: false, initialized: true }, page);
        if (page.stalled) {
          window.failures = (window.failures ?? 0) + 1;
          if (window.failures < HISTORY_RETRY_BUDGET) this.retries.schedule(key, () => this.retry(scope, () => this.readOlder(scope, window), window));
        } else { window.failures = 0; this.retries.complete(key); }
        this.host.diagnostic(scope.chatId, { durationMs: performance.now() - startedAt, purpose: 2, pageCount: 1, stopReason: page.stalled ? 2 : 1 });
      } catch (error) {
        if (!this.current(scope, generation)) return;
        window.loading = false;
        this.host.error(error, scope.topicId);
        this.publish(scope, { loading: false, background: false });
        window.failures = (window.failures ?? 0) + 1;
        if (window.failures < HISTORY_RETRY_BUDGET) this.retries.schedule(key, () => this.retry(scope, () => this.readOlder(scope, window), window), error);
      }
    });
  }
}
