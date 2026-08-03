import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { Message } from "../telegram/types";
import { logPerformance, markHistoryInteraction } from "../utils/performanceMonitor";

const BOTTOM_PROXIMITY_PX = 40;

interface ConversationScrollMemory {
  scrollTop: number;
  followLatest: boolean;
  lastKnownMessageId?: string;
  pendingNewCount: number;
  anchorMessageId?: string;
  anchorOffset?: number;
}

interface ConversationLayoutSnapshot {
  key?: string;
  firstId?: string;
  lastId?: string;
  search: string;
}

export interface LatestConversationScrollRequest {
  chatId: string;
  requestId: number;
}

export interface MessageConversationScrollRequest {
  chatId: string;
  messageId: string;
  requestId: number;
}

interface ConversationScrollOptions {
  scope: string;
  chatId?: string;
  latestRequest?: LatestConversationScrollRequest;
  messageRequest?: MessageConversationScrollRequest;
  visibleMessages: Message[];
  messageItemIndexes: ReadonlyMap<string, number>;
  virtualItemCount: number;
  search: string;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  messageCount: number;
  onLoadOlder: () => Promise<void>;
}

const conversationScrollMemory = new Map<string, ConversationScrollMemory>();

const scrollMemoryKey = (scope: string, chatId?: string) =>
  chatId ? `${scope}:${chatId}` : undefined;

const distanceFromBottom = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);

const visibleAnchor = (element: HTMLElement) => {
  const listBounds = element.getBoundingClientRect();
  const rows = element.querySelectorAll<HTMLElement>("[data-message-id]");
  for (const row of rows) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > listBounds.top + 1) {
      return {
        messageId: row.dataset.messageId,
        offset: bounds.top - listBounds.top,
      };
    }
  }
  return undefined;
};

const nearbyVisibleAnchor = (element: HTMLElement) => {
  const bounds = element.getBoundingClientRect();
  const x = bounds.left + bounds.width / 2;
  for (const offset of [1, 8, 20, 40, 64]) {
    const target = document.elementFromPoint(x, Math.min(bounds.bottom - 1, bounds.top + offset));
    const row = target?.closest<HTMLElement>("[data-message-id]");
    if (row && element.contains(row)) {
      return {
        messageId: row.dataset.messageId,
        offset: row.getBoundingClientRect().top - bounds.top,
      };
    }
  }
  return undefined;
};

const captureScrollMemory = (
  element: HTMLElement,
  lastKnownMessageId: string | undefined,
  pendingNewCount: number,
  followLatest = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX,
  captureAnchor = false,
): ConversationScrollMemory => {
  const atBottom = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
  const shouldFollowLatest = atBottom || followLatest;
  const anchor = captureAnchor ? visibleAnchor(element) : undefined;
  return {
    scrollTop: element.scrollTop,
    followLatest: shouldFollowLatest,
    lastKnownMessageId,
    pendingNewCount: shouldFollowLatest ? 0 : pendingNewCount,
    anchorMessageId: anchor?.messageId,
    anchorOffset: anchor?.offset,
  };
};

const restoreScrollMemory = (
  element: HTMLElement,
  memory: ConversationScrollMemory,
  virtuoso: VirtuosoHandle | null,
  messageItemIndexes: ReadonlyMap<string, number>,
) => {
  element.scrollTop = memory.scrollTop;
  if (!memory.anchorMessageId || memory.anchorOffset === undefined) return;
  const restoreAnchorOffset = () => {
    const anchor = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(memory.anchorMessageId!)}"]`,
    );
    if (!anchor) return;
    const currentOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTop += currentOffset - memory.anchorOffset!;
  };
  const anchor = element.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(memory.anchorMessageId)}"]`,
  );
  if (anchor) {
    restoreAnchorOffset();
    return;
  }
  const itemIndex = messageItemIndexes.get(memory.anchorMessageId);
  if (itemIndex === undefined) return;
  virtuoso?.scrollToIndex({ index: itemIndex, align: "start", behavior: "auto" });
  requestAnimationFrame(restoreAnchorOffset);
};

const appendedMessageCount = (messages: Message[], previousLastId?: string) => {
  if (!previousLastId) return 0;
  const previousIndex = messages.findIndex((message) => message.id === previousLastId);
  return previousIndex < 0 ? 0 : Math.max(0, messages.length - previousIndex - 1);
};

export const useConversationScroll = ({
  scope,
  chatId,
  latestRequest,
  messageRequest,
  visibleMessages,
  messageItemIndexes,
  virtualItemCount,
  search,
  historyLoading,
  hasOlderMessages,
  messageCount,
  onLoadOlder,
}: ConversationScrollOptions) => {
  const messageListRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const previousLayoutRef = useRef<ConversationLayoutSnapshot | undefined>(undefined);
  const handledLatestRequestRef = useRef(0);
  const handledMessageRequestRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const historyLoadPendingRef = useRef<string | undefined>(undefined);
  const historyTraceRef = useRef<{
    key: string;
    startedAt: number;
    beforeCount: number;
  } | undefined>(undefined);
  const scrollPointerActiveRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const latestSettleTokenRef = useRef(0);
  const latestSettleTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const [newMessageNotice, setNewMessageNotice] = useState<{
    key: string;
    count: number;
  }>();
  const [highlightedMessage, setHighlightedMessage] = useState<{
    key: string;
    messageId: string;
  }>();
  const currentScrollKey = scrollMemoryKey(scope, chatId);
  const lastVisibleMessageId = visibleMessages.at(-1)?.id;
  const lastVisibleMessageIdRef = useRef(lastVisibleMessageId);
  lastVisibleMessageIdRef.current = lastVisibleMessageId;

  const setMessageListRef = useCallback((ref: HTMLElement | Window | null) => {
    messageListRef.current = ref instanceof HTMLDivElement ? ref : null;
  }, []);

  const updateNewMessageNotice = (key: string, count: number) => {
    setNewMessageNotice((current) =>
      current?.key === key && current.count === count ? current : { key, count });
  };

  const loadOlder = () => {
    const element = messageListRef.current;
    if (
      !element ||
      !currentScrollKey ||
      search ||
      historyLoading ||
      !hasOlderMessages ||
      historyLoadPendingRef.current === currentScrollKey
    ) return;
    const stored = conversationScrollMemory.get(currentScrollKey);
    conversationScrollMemory.set(currentScrollKey, captureScrollMemory(
      element,
      lastVisibleMessageId,
      stored?.pendingNewCount ?? 0,
      false,
      true,
    ));
    historyTraceRef.current = {
      key: currentScrollKey,
      startedAt: performance.now(),
      beforeCount: visibleMessages.length,
    };
    markHistoryInteraction();
    historyLoadPendingRef.current = currentScrollKey;
    void onLoadOlder().finally(() => {
      if (historyLoadPendingRef.current === currentScrollKey) {
        historyLoadPendingRef.current = undefined;
      }
    });
  };

  const scrollToLatestPosition = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    if (virtualItemCount > 0) {
      const virtuoso = virtuosoRef.current;
      const latestMessageId = lastVisibleMessageIdRef.current;
      const latestMessageMounted = Boolean(
        latestMessageId && element.querySelector(
          `[data-message-id="${CSS.escape(latestMessageId)}"]`,
        ),
      );
      if (!latestMessageMounted) {
        virtuoso?.scrollToIndex({
          index: "LAST",
          align: "end",
          behavior: "auto",
        });
      }
      virtuoso?.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      virtuoso?.autoscrollToBottom();
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [virtualItemCount]);

  const cancelLatestSettle = useCallback(() => {
    latestSettleTokenRef.current += 1;
    if (latestSettleTimerRef.current) {
      globalThis.clearTimeout(latestSettleTimerRef.current);
      latestSettleTimerRef.current = undefined;
    }
  }, []);

  const stopFollowingLatest = useCallback(() => {
    cancelLatestSettle();
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const stored = conversationScrollMemory.get(currentScrollKey);
    conversationScrollMemory.set(currentScrollKey, {
      scrollTop: element.scrollTop,
      followLatest: false,
      lastKnownMessageId: lastVisibleMessageIdRef.current,
      pendingNewCount: stored?.pendingNewCount ?? 0,
      anchorMessageId: stored?.anchorMessageId,
      anchorOffset: stored?.anchorOffset,
    });
  }, [cancelLatestSettle, currentScrollKey]);

  const settleLatestScroll = useCallback(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    cancelLatestSettle();
    const token = latestSettleTokenRef.current;
    let attempt = 0;
    const settle = () => {
      if (
        token !== latestSettleTokenRef.current ||
        messageListRef.current !== element ||
        conversationScrollMemory.get(currentScrollKey)?.followLatest === false
      ) return;
      scrollToLatestPosition();
      attempt += 1;
      if (attempt < 8) {
        latestSettleTimerRef.current = globalThis.setTimeout(settle, 50);
      } else {
        latestSettleTimerRef.current = undefined;
      }
    };
    settle();
  }, [cancelLatestSettle, currentScrollKey, scrollToLatestPosition]);

  const jumpToLatest = useCallback(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    scrollPointerActiveRef.current = false;
    userScrollIntentUntilRef.current = 0;
    conversationScrollMemory.set(currentScrollKey, {
      scrollTop: element.scrollTop,
      followLatest: true,
      lastKnownMessageId: lastVisibleMessageId,
      pendingNewCount: 0,
    });
    settleLatestScroll();
    updateNewMessageNotice(currentScrollKey, 0);
  }, [currentScrollKey, lastVisibleMessageId, settleLatestScroll]);

  useLayoutEffect(() => {
    const renderStartedAt = performance.now();
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const previous = previousLayoutRef.current;
    const firstId = visibleMessages[0]?.id;
    const lastId = lastVisibleMessageId;
    const stored = conversationScrollMemory.get(currentScrollKey);
    let restoredHistoryAnchor = false;

    if (search) {
      cancelLatestSettle();
      if (!previous || previous.key !== currentScrollKey || previous.search !== search) {
        virtuosoRef.current?.scrollToIndex({ index: 0, align: "start", behavior: "auto" });
      }
      updateNewMessageNotice(currentScrollKey, stored?.pendingNewCount ?? 0);
      previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
      return;
    }

    let pendingNewCount = stored?.pendingNewCount ?? 0;
    let followLatest = stored?.followLatest ?? true;
    const enteringChat = !previous || previous.key !== currentScrollKey;
    const leavingSearch = previous?.key === currentScrollKey && Boolean(previous.search);
    if (enteringChat || leavingSearch) {
      if (!stored || stored.followLatest) {
        settleLatestScroll();
        pendingNewCount = 0;
        followLatest = true;
      } else {
        cancelLatestSettle();
        restoreScrollMemory(element, stored, virtuosoRef.current, messageItemIndexes);
        pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
        followLatest = false;
      }
    } else if (stored) {
      const firstMessageChanged = previous.firstId !== firstId;
      const previousFirstStillPresent = Boolean(
        previous.firstId && visibleMessages.some((message) => message.id === previous.firstId),
      );
      if (firstMessageChanged && previousFirstStillPresent) {
        if (stored.followLatest) {
          settleLatestScroll();
        }
        else {
          cancelLatestSettle();
          restoreScrollMemory(element, stored, virtuosoRef.current, messageItemIndexes);
          restoredHistoryAnchor = historyTraceRef.current?.key === currentScrollKey;
        }
      }

      if (previous.lastId !== lastId) {
        if (stored.followLatest) {
          settleLatestScroll();
          pendingNewCount = 0;
          followLatest = true;
        } else {
          pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
          followLatest = false;
        }
      }
    }

    const memory = captureScrollMemory(element, lastId, pendingNewCount, followLatest);
    conversationScrollMemory.set(currentScrollKey, memory);
    updateNewMessageNotice(currentScrollKey, memory.pendingNewCount);
    previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
    if (restoredHistoryAnchor && historyTraceRef.current && stored) {
      const trace = historyTraceRef.current;
      const anchorMessageId = stored.anchorMessageId;
      const expectedAnchorOffset = stored.anchorOffset;
      historyTraceRef.current = undefined;
      const restoreDurationMs = performance.now() - renderStartedAt;
      requestAnimationFrame(() => {
        if (messageListRef.current !== element) return;
        const anchor = anchorMessageId
          ? element.querySelector<HTMLElement>(
              `[data-message-id="${CSS.escape(anchorMessageId)}"]`,
            )
          : undefined;
        const anchorOffset = anchor
          ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
          : undefined;
        logPerformance("ui_history_render", {
          durationMs: performance.now() - trace.startedAt,
          restoreDurationMs,
          addedCount: Math.max(0, visibleMessages.length - trace.beforeCount),
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          anchorShiftPx: anchorOffset !== undefined && expectedAnchorOffset !== undefined
            ? Math.abs(anchorOffset - expectedAnchorOffset)
            : undefined,
        });
      });
    }
  }, [
    currentScrollKey,
    cancelLatestSettle,
    lastVisibleMessageId,
    messageItemIndexes,
    search,
    settleLatestScroll,
    virtualItemCount,
    visibleMessages,
  ]);

  useLayoutEffect(() => {
    if (
      !latestRequest ||
      latestRequest.chatId !== chatId ||
      latestRequest.requestId <= handledLatestRequestRef.current
    ) return;
    handledLatestRequestRef.current = latestRequest.requestId;
    jumpToLatest();
  }, [chatId, jumpToLatest, latestRequest]);

  useLayoutEffect(() => {
    if (
      !messageRequest ||
      messageRequest.chatId !== chatId ||
      messageRequest.requestId <= handledMessageRequestRef.current
    ) return;
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    cancelLatestSettle();
    let animationFrame: number | undefined;
    let cancelled = false;
    const revealMessage = (attempt: number) => {
      if (cancelled) return;
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageRequest.messageId)}"]`,
      );
      if (!target) {
        if (attempt === 0) {
          const itemIndex = messageItemIndexes.get(messageRequest.messageId);
          if (itemIndex === undefined) return;
          virtuosoRef.current?.scrollToIndex({
            index: itemIndex,
            align: "center",
            behavior: "auto",
          });
        }
        if (attempt < 6) {
          animationFrame = requestAnimationFrame(() => revealMessage(attempt + 1));
        }
        return;
      }

      handledMessageRequestRef.current = messageRequest.requestId;
      target.scrollIntoView({ block: "center", behavior: "auto" });
      element.focus({ preventScroll: true });
      setHighlightedMessage({ key: currentScrollKey, messageId: messageRequest.messageId });
      const memory = captureScrollMemory(element, lastVisibleMessageId, 0, false);
      conversationScrollMemory.set(currentScrollKey, {
        ...memory,
        followLatest: false,
        pendingNewCount: 0,
      });
      updateNewMessageNotice(currentScrollKey, 0);
      if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = globalThis.setTimeout(() => {
        highlightTimerRef.current = undefined;
        setHighlightedMessage((current) =>
          current?.key === currentScrollKey && current.messageId === messageRequest.messageId
            ? undefined
            : current
        );
      }, 1_600);
    };
    revealMessage(0);
    return () => {
      cancelled = true;
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  }, [
    chatId,
    cancelLatestSettle,
    currentScrollKey,
    lastVisibleMessageId,
    messageItemIndexes,
    messageRequest,
    visibleMessages,
  ]);

  useEffect(() => () => {
    cancelLatestSettle();
    if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
  }, [cancelLatestSettle]);

  useEffect(() => {
    const element = messageListRef.current;
    const content = element?.querySelector<HTMLElement>(".message-list-content");
    if (!element || !content || !currentScrollKey || search) return;
    let animationFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const stored = conversationScrollMemory.get(currentScrollKey);
        if (!stored) return;
        if (!stored.followLatest) return;
        settleLatestScroll();
        conversationScrollMemory.set(currentScrollKey, {
          ...stored,
          lastKnownMessageId: lastVisibleMessageIdRef.current,
        });
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  }, [currentScrollKey, search, settleLatestScroll]);

  useEffect(() => {
    const element = messageListRef.current;
    if (
      !element ||
      search ||
      historyLoading ||
      !hasOlderMessages ||
      element.scrollHeight > element.clientHeight + 1
    ) return;
    const attemptKey = `${chatId ?? ""}:${messageCount}`;
    if (autoFillAttemptRef.current === attemptKey) return;
    autoFillAttemptRef.current = attemptKey;
    loadOlder();
  }, [chatId, hasOlderMessages, historyLoading, messageCount, onLoadOlder, search]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) stopFollowingLatest();
    else cancelLatestSettle();
    userScrollIntentUntilRef.current = performance.now() + 400;
  };
  const onPointerDown = () => {
    cancelLatestSettle();
    scrollPointerActiveRef.current = true;
  };
  const onPointerUp = () => {
    scrollPointerActiveRef.current = false;
    userScrollIntentUntilRef.current = performance.now() + 200;
  };
  const onPointerCancel = () => {
    scrollPointerActiveRef.current = false;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopFollowingLatest();
      else cancelLatestSettle();
      userScrollIntentUntilRef.current = performance.now() + 400;
    }
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (!search && currentScrollKey) {
      const stored = conversationScrollMemory.get(currentScrollKey);
      const userInitiated = scrollPointerActiveRef.current ||
        performance.now() <= userScrollIntentUntilRef.current;
      const followLatest = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX ||
        (!userInitiated && stored?.followLatest === true);
      const shouldFollowLatest = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX || followLatest;
      const anchor = shouldFollowLatest ? undefined : nearbyVisibleAnchor(element);
      const memory: ConversationScrollMemory = {
        scrollTop: element.scrollTop,
        followLatest: shouldFollowLatest,
        lastKnownMessageId: lastVisibleMessageId,
        pendingNewCount: shouldFollowLatest ? 0 : (stored?.pendingNewCount ?? 0),
        anchorMessageId: anchor?.messageId,
        anchorOffset: anchor?.offset,
      };
      conversationScrollMemory.set(currentScrollKey, memory);
      updateNewMessageNotice(currentScrollKey, memory.pendingNewCount);
    }
    if (element.scrollTop <= 64 && !search && hasOlderMessages && !historyLoading) {
      loadOlder();
    }
  };

  return {
    messageListRef,
    setMessageListRef,
    virtuosoRef,
    currentScrollKey,
    highlightedMessageId: highlightedMessage && highlightedMessage.key === currentScrollKey
      ? highlightedMessage.messageId
      : undefined,
    newMessageNotice,
    jumpToLatest,
    messageListHandlers: {
      onWheel,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onKeyDown,
      onScroll,
    },
  };
};
