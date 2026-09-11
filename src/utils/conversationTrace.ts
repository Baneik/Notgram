import type { FlatIndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import type { Message } from "../telegram/types";
import { logPerformance, type PerformanceDetails } from "./performanceMonitor";

// Numeric codes and limits are documented in conversation-state-model.md.
export const conversationTraceKind = {
  start: 1, end: 2, frame: 3, write: 4, scroll: 5, indexScroll: 6,
  commitBefore: 7, commitAfter: 8, resize: 9, totalHeight: 10,
  removalStart: 11, removalEnd: 12, input: 13, visibility: 14,
  messageUpsert: 15, messageRemove: 16, ghostStart: 17, ghostEnd: 18,
  immediateRemove: 19, archived: 20, control: 21, measure: 22, dropped: 23,
} as const;
export const conversationScrollWriter = {
  bottom: 1, latestMotion: 2, latestApproach: 3, anchor: 4, rowResize: 5,
  jumpMotion: 6, reveal: 7, selection: 8, selectionRestore: 9, virtualIndex: 10,
} as const;
export const conversationTraceLimits = {
  history: 96, identities: 4096, durationMs: 8_000, cooldownMs: 30_000,
  records: 640, rows: 8, rowIntervalMs: 250, flushIntervalMs: 100,
} as const;

type TraceEntry = { event: string; details: PerformanceDetails };
interface TraceOptions {
  now?: () => number;
  emit?: typeof logPerformance;
}
let nextSession = 1;

/** A bounded flight recorder. Recording never starts a scroll or reads layout. */
export const createConversationTrace = (options: TraceOptions = {}) => {
  const now = options.now ?? (() => performance.now());
  const emit = options.emit ?? logPerformance;
  const session = nextSession++;
  const origin = now();
  const wallOrigin = Date.now();
  const tokens = new Map<string, number>();
  const objects = new WeakMap<object, number>();
  let nextToken = 1;
  let sequence = 0;
  let run = 0;
  let startedAt: number | undefined;
  let nextAllowedAt = -Infinity;
  let emitted = 0;
  let dropped = 0;
  let disposed = false;
  let history: TraceEntry[] = [];
  let lifecycle: TraceEntry[] = [];
  let lastIdleFlush = -Infinity;
  let pendingStart: TraceEntry | undefined;
  const entry = (event: string, details: PerformanceDetails): TraceEntry => ({ event, details: {
    traceSession: session, traceSeq: ++sequence, traceTimeMs: now() - origin, traceOriginMs: wallOrigin, ...details,
  } });
  const send = (item: TraceEntry) => {
    emit(item.event, { ...item.details, traceRun: run });
    emitted++;
  };
  const end = (finishKind: number) => {
    if (startedAt === undefined) return;
    send(entry("ui_conversation_trace", {
      traceKind: conversationTraceKind.end, finishKind, droppedCount: dropped,
      recordCount: emitted, traceElapsedMs: now() - startedAt,
    }));
    startedAt = undefined;
    dropped = 0;
  };
  return {
    session,
    get run() { return run; },
    get active() { return startedAt !== undefined; },
    objectToken(value: object | undefined) {
      if (!value) return 0;
      let token = objects.get(value);
      if (!token) { token = nextToken++; objects.set(value, token); }
      return token;
    },
    token(key: string | undefined) {
      if (!key) return 0;
      const existing = tokens.get(key);
      if (existing) return existing;
      if (tokens.size >= conversationTraceLimits.identities) return 0;
      const value = nextToken++;
      tokens.set(key, value);
      return value;
    },
    record(traceKind: number, details: PerformanceDetails = {}) {
      if (disposed) return;
      const item = entry("ui_conversation_trace", { traceKind, ...details });
      history.push(item);
      if ([16, 17, 18, 19, 20].includes(traceKind) ||
        (traceKind === conversationTraceKind.messageUpsert && details.live === true)) {
        lifecycle.push(item);
        if (lifecycle.length > 32) { lifecycle.shift(); dropped++; }
      }
      if (history.length > conversationTraceLimits.history) {
        const removed = history.shift()!;
        if (startedAt !== undefined && !lifecycle.includes(removed)) dropped++;
      }
    },
    trigger(triggerKind: number) {
      if (disposed || startedAt !== undefined || now() < nextAllowedAt) return false;
      run++;
      startedAt = now();
      nextAllowedAt = startedAt + conversationTraceLimits.cooldownMs;
      emitted = 0;
      dropped = 0;
      // The observer flushes this later; commit/transport callbacks never log synchronously.
      pendingStart = entry("ui_conversation_trace", { traceKind: conversationTraceKind.start, triggerKind });
      return true;
    },
    detail(event: string, details: PerformanceDetails) {
      if (disposed || startedAt === undefined) return;
      if (emitted >= conversationTraceLimits.records - 1) { dropped++; return; }
      send(entry(event, details));
    },
    flush() {
      if (disposed) return;
      if (startedAt === undefined) {
        if (now() - lastIdleFlush < 1_000) return;
        lastIdleFlush = now();
        for (const item of lifecycle.splice(0)) send(item);
        if (dropped) {
          send(entry("ui_conversation_trace", { traceKind: conversationTraceKind.dropped, droppedCount: dropped }));
          dropped = 0;
        }
        return;
      }
      if (pendingStart) { send(pendingStart); pendingStart = undefined; }
      const queued = [...new Map([...lifecycle, ...history].map(item => [item.details.traceSeq, item])).values()]
        .sort((a, b) => Number(a.details.traceSeq) - Number(b.details.traceSeq));
      history = [];
      lifecycle = [];
      for (const item of queued) {
        if (emitted >= conversationTraceLimits.records - 1) { dropped++; continue; }
        send(item);
      }
      if (emitted >= conversationTraceLimits.records - 1) end(2);
      else if (now() - startedAt >= conversationTraceLimits.durationMs) end(1);
    },
    dispose() {
      if (disposed) return;
      lastIdleFlush = -Infinity;
      this.flush();
      end(3);
      disposed = true;
      history = [];
      lifecycle = [];
      tokens.clear();
    },
  };
};
export type ConversationTrace = ReturnType<typeof createConversationTrace>;

const traces = new WeakMap<HTMLElement, ConversationTrace>();
const chatTraces = new Map<string, Set<ConversationTrace>>();
export const registerConversationTrace = (list: HTMLElement, chatId: string, trace: ConversationTrace) => {
  traces.set(list, trace);
  const group = chatTraces.get(chatId) ?? new Set<ConversationTrace>();
  group.add(trace);
  chatTraces.set(chatId, group);
  return () => {
    if (traces.get(list) === trace) traces.delete(list);
    group.delete(trace);
    if (group.size === 0) chatTraces.delete(chatId);
    trace.dispose();
  };
};
export const conversationTraceFor = (list: HTMLElement | null | undefined) => list ? traces.get(list) : undefined;

export const conversationMessageShape = (message?: Message): PerformanceDetails => ({
  contentKind: message ? ["text", "rich", "media", "file", "sticker", "service", "unsupported"].indexOf(message.content.kind) + 1 : 0,
  mediaKind: message?.content.kind === "media" ? ["photo", "video", "animation", "audio", "voice", "videoNote"].indexOf(message.content.mediaType) + 1 : 0,
  hasReply: Boolean(message?.replyTo), hasKeyboard: Boolean(message?.replyMarkup),
  hasAlbum: Boolean(message?.mediaAlbumId), isRemoving: Boolean(message?.isRemoving),
  isLocallyDeleted: Boolean(message?.isLocallyDeleted),
  textLength: message?.content.kind === "text" ? message.content.text.length : undefined,
  mediaWidth: message?.content.kind === "media" ? message.content.width : undefined,
  mediaHeight: message?.content.kind === "media" ? message.content.height : undefined,
});

/** IDs stay in session-local maps; only opaque counters and message shape leave memory. */
export const recordConversationMessage = (
  chatId: string, messageId: string, kind: number, message?: Message, details: PerformanceDetails = {},
) => {
  for (const trace of chatTraces.get(chatId) ?? []) {
    trace.record(kind, {
      messageToken: trace.token(`message:${messageId}`),
      revisionToken: trace.objectToken(message),
      replyToken: trace.token(message?.replyTo?.kind === "message" && message.replyTo.messageId
        ? message.replyTo.chatId && message.replyTo.chatId !== chatId
          ? `external-reply:${message.replyTo.chatId}:${message.replyTo.messageId}`
          : `message:${message.replyTo.messageId}` : undefined),
      ...conversationMessageShape(message), ...details,
    });
    if (kind === conversationTraceKind.messageRemove || kind === conversationTraceKind.ghostStart) trace.trigger(1);
  }
};

// Preserve the existing assignment and browser clamping exactly. Unattributed
// browser/Virtuoso movement is separately recorded by the passive scroll listener.
export const writeConversationScrollTop = (list: HTMLElement, target: number, writerKind: number) => {
  const beforeTop = list.scrollTop;
  list.scrollTop = target;
  conversationTraceFor(list)?.record(conversationTraceKind.write, {
    writerKind, beforeTop, requestedTop: target, actualTop: list.scrollTop,
  });
};
export const traceConversationIndexScroll = (
  list: HTMLElement | null, handle: VirtuosoHandle | null, location: FlatIndexLocationWithAlign,
) => {
  conversationTraceFor(list)?.record(conversationTraceKind.indexScroll, {
    targetIndex: typeof location.index === "number" ? location.index : -1,
    alignKind: ["start", "center", "end"].indexOf(location.align ?? "start"),
    anchorOffset: location.offset,
    smooth: location.behavior === "smooth",
  });
  handle?.scrollToIndex(location);
};

export const recordConversationMeasurement = (element: HTMLElement, value: number, height: boolean) => {
  const list = element.closest<HTMLElement>(".message-list");
  const trace = conversationTraceFor(list);
  trace?.record(conversationTraceKind.measure, {
    rowToken: trace.objectToken(element), blockIndex: Number(element.dataset.index),
    knownHeight: Number(element.dataset.knownSize), measuredSize: value, heightMeasurement: height,
  });
};
