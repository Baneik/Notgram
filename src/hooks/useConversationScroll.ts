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
import type { IndexLocationWithAlign, StateSnapshot, VirtuosoHandle } from "react-virtuoso";
import type { Message } from "../telegram/types";
import {
  captureConversationSwitchSnapshot,
  removeConversationSwitchSnapshot,
} from "../utils/conversationSwitchSnapshot";
import {
  logPerformance,
  markConversationSwitch,
  markHistoryInteraction,
} from "../utils/performanceMonitor";

const BOTTOM_PROXIMITY_PX = 40;
const SMOOTH_SCROLL_MAX_DISTANCE_PX = 1_400;
const SMOOTH_SCROLL_TELEPORT_VIEWPORTS = 0.85;

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
  performanceTraceId?: number;
}

export interface EntryConversationScrollRequest {
  chatId: string;
  serverMessageId?: string;
  requestId: number;
  performanceTraceId?: number;
}

export interface MessageConversationScrollRequest {
  chatId: string;
  messageId: string;
  requestId: number;
  performanceTraceId?: number;
}

interface ConversationScrollOptions {
  scope: string;
  chatId?: string;
  entryRequest?: EntryConversationScrollRequest;
  latestRequest?: LatestConversationScrollRequest;
  messageRequest?: MessageConversationScrollRequest;
  visibleMessages: Message[];
  messageItemIndexes: ReadonlyMap<string, number>;
  virtualItemCount: number;
  search: string;
  historyLoading: boolean;
  historyInitialized: boolean;
  hasOlderMessages: boolean;
  messageCount: number;
  onLoadOlder: () => Promise<void>;
}

const conversationScrollMemory = new Map<string, ConversationScrollMemory>();
const conversationVirtuosoSnapshots = new Map<string, {
  state: StateSnapshot;
  firstMessageId?: string;
  lastMessageId?: string;
  virtualItemCount: number;
}>();

const scrollMemoryKey = (scope: string, chatId?: string) =>
  chatId ? `${scope}:${chatId}` : undefined;

export const hasConversationScrollMemory = (scope: string, chatId: string) =>
  conversationScrollMemory.has(scrollMemoryKey(scope, chatId)!);

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
  const anchor = captureAnchor ? visibleAnchor(element) : undefined;
  return {
    scrollTop: element.scrollTop,
    followLatest,
    lastKnownMessageId,
    pendingNewCount: followLatest ? 0 : pendingNewCount,
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
  if (!memory.anchorMessageId || memory.anchorOffset === undefined) {
    element.scrollTop = memory.scrollTop;
    return;
  }
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
  if (itemIndex === undefined) {
    element.scrollTop = memory.scrollTop;
    return;
  }
  virtuoso?.scrollToIndex({
    index: itemIndex,
    align: "start",
    offset: -memory.anchorOffset,
    behavior: "auto",
  });
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
  entryRequest,
  latestRequest,
  messageRequest,
  visibleMessages,
  messageItemIndexes,
  virtualItemCount,
  search,
  historyLoading,
  historyInitialized,
  hasOlderMessages,
  messageCount,
  onLoadOlder,
}: ConversationScrollOptions) => {
  const messageListRef = useRef<HTMLDivElement>(null);
  const [messageListElement, setMessageListElement] = useState<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const messageItemIndexesRef = useRef(messageItemIndexes);
  messageItemIndexesRef.current = messageItemIndexes;
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const previousLayoutRef = useRef<ConversationLayoutSnapshot | undefined>(undefined);
  const handledEntryRequestRef = useRef(0);
  const handledLatestRequestRef = useRef(0);
  const handledMessageRequestRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const historyLoadPendingRef = useRef<string | undefined>(undefined);
  const historyRestoreFrameRef = useRef<number | undefined>(undefined);
  const heightCorrectionTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const heightCorrectionFrameRef = useRef<number | undefined>(undefined);
  const historyTraceRef = useRef<{
    key: string;
    startedAt: number;
    beforeCount: number;
  } | undefined>(undefined);
  const scrollPointerActiveRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const initialLocationRef = useRef<{
    identity: string;
    location: IndexLocationWithAlign | number;
    mode: "empty" | "pending" | "bottom" | "anchor";
    targetMessageId?: string;
  } | undefined>(undefined);
  const initialPositionFrameRef = useRef<number | undefined>(undefined);
  const initialPositionStableFramesRef = useRef(0);
  const initialPositionSignatureRef = useRef<string | undefined>(undefined);
  const initialPositionVerifierRef = useRef<() => void>(() => undefined);
  const initialPositionCancelledIdentityRef = useRef<string | undefined>(undefined);
  const latestJumpFrameRef = useRef<number | undefined>(undefined);
  const smoothScrollTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const smoothScrollUntilRef = useRef(0);
  const [newMessageNotice, setNewMessageNotice] = useState<{
    key: string;
    count: number;
  }>();
  const [latestPosition, setLatestPosition] = useState<{
    key: string;
    atBottom: boolean;
  }>();
  const [highlightedMessage, setHighlightedMessage] = useState<{
    key: string;
    messageId: string;
  }>();
  const currentScrollKey = scrollMemoryKey(scope, chatId);
  const [positionedScrollIdentity, setPositionedScrollIdentity] = useState<string>();
  const positionCorrectionIdentityRef = useRef<string | undefined>(undefined);
  const lastVisibleMessageId = visibleMessages.at(-1)?.id;
  const firstVisibleMessageId = visibleMessages[0]?.id;
  const lastVisibleMessageIdRef = useRef(lastVisibleMessageId);
  lastVisibleMessageIdRef.current = lastVisibleMessageId;
  const matchingEntryRequest = entryRequest?.chatId === chatId ? entryRequest : undefined;
  const matchingLatestRequest = latestRequest?.chatId === chatId ? latestRequest : undefined;
  const matchingMessageRequest = messageRequest?.chatId === chatId ? messageRequest : undefined;
  const performanceTraceId = matchingMessageRequest?.performanceTraceId ??
    matchingLatestRequest?.performanceTraceId ??
    matchingEntryRequest?.performanceTraceId;
  const initialDataPhase = virtualItemCount > 0 ? "ready" : "empty";
  const requestedEntryTarget = matchingEntryRequest?.serverMessageId;
  const requestedMessageTarget = matchingMessageRequest?.messageId;
  const entryTargetPhase = !requestedEntryTarget
    ? "no-target"
    : messageItemIndexes.has(requestedEntryTarget) ? "target-ready" : "target-pending";
  const messageTargetPhase = !requestedMessageTarget
    ? "no-target"
    : messageItemIndexes.has(requestedMessageTarget) ? "target-ready" : "target-pending";
  const initialLocationIdentity = `${currentScrollKey ?? ""}:${matchingEntryRequest?.requestId ?? 0}:${matchingLatestRequest?.requestId ?? 0}:${matchingMessageRequest?.requestId ?? 0}:${initialDataPhase}:${entryTargetPhase}:${messageTargetPhase}`;
  if (initialLocationRef.current?.identity !== initialLocationIdentity) {
    const stored = currentScrollKey ? conversationScrollMemory.get(currentScrollKey) : undefined;
    const storedAnchorIndex = stored?.anchorMessageId
      ? messageItemIndexes.get(stored.anchorMessageId)
      : undefined;
    const serverAnchorIndex = matchingEntryRequest?.serverMessageId
      ? messageItemIndexes.get(matchingEntryRequest.serverMessageId)
      : undefined;
    const requestedMessageIndex = requestedMessageTarget
      ? messageItemIndexes.get(requestedMessageTarget)
      : undefined;
    let location: IndexLocationWithAlign | number = 0;
    let mode: "empty" | "pending" | "bottom" | "anchor" = "empty";
    let targetMessageId: string | undefined;
    if (virtualItemCount > 0) {
      if (requestedMessageTarget && requestedMessageIndex === undefined) {
        location = 0;
        mode = "pending";
        targetMessageId = requestedMessageTarget;
      } else if (requestedMessageIndex !== undefined) {
        location = { index: requestedMessageIndex, align: "center", behavior: "auto" };
        mode = "anchor";
        targetMessageId = requestedMessageTarget;
      } else if (matchingLatestRequest) {
        location = {
          index: "LAST",
          align: "end",
          behavior: "auto",
        };
        mode = "bottom";
      } else if (stored?.followLatest === false && storedAnchorIndex !== undefined) {
        location = {
          index: storedAnchorIndex,
          align: "start",
          offset: -(stored.anchorOffset ?? 0),
          behavior: "auto",
        };
        mode = "anchor";
        targetMessageId = stored.anchorMessageId;
      } else if (stored?.followLatest === true) {
        location = {
          index: "LAST",
          align: "end",
          behavior: "auto",
        };
        mode = "bottom";
      } else if (requestedEntryTarget && serverAnchorIndex === undefined) {
        location = 0;
        mode = "pending";
        targetMessageId = requestedEntryTarget;
      } else if (serverAnchorIndex !== undefined) {
        location = { index: serverAnchorIndex, align: "center", behavior: "auto" };
        mode = "anchor";
        targetMessageId = requestedEntryTarget;
      } else {
        location = {
          index: "LAST",
          align: "end",
          behavior: "auto",
        };
        mode = "bottom";
      }
    }
    initialLocationRef.current = {
      identity: initialLocationIdentity,
      location,
      mode,
      targetMessageId,
    };
  }
  const initialTopMostItemIndex = initialLocationRef.current!.location;
  const initialAlignToBottom = initialLocationRef.current!.mode === "bottom";
  const storedVirtuosoSnapshot = currentScrollKey
    ? conversationVirtuosoSnapshots.get(currentScrollKey)
    : undefined;
  const storedMemory = currentScrollKey
    ? conversationScrollMemory.get(currentScrollKey)
    : undefined;
  const restoreStateFrom = !matchingLatestRequest && !matchingMessageRequest &&
      storedMemory?.followLatest === false && storedVirtuosoSnapshot &&
      storedVirtuosoSnapshot.firstMessageId === firstVisibleMessageId &&
      storedVirtuosoSnapshot.lastMessageId === lastVisibleMessageId &&
      storedVirtuosoSnapshot.virtualItemCount === virtualItemCount
    ? storedVirtuosoSnapshot.state
    : undefined;
  const setMessageListRef = useCallback((ref: HTMLElement | Window | null) => {
    const element = ref instanceof HTMLDivElement ? ref : null;
    messageListRef.current = element;
    setMessageListElement((current) => current === element ? current : element);
  }, []);

  const updateNewMessageNotice = (key: string, count: number) => {
    setNewMessageNotice((current) =>
      current?.key === key && current.count === count ? current : { key, count });
  };

  const updateLatestPosition = (key: string, atBottom: boolean) => {
    setLatestPosition((current) =>
      current?.key === key && current.atBottom === atBottom
        ? current
        : { key, atBottom });
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
    const followLatest = stored?.followLatest ?? distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
    const memory = captureScrollMemory(
      element,
      lastVisibleMessageId,
      stored?.pendingNewCount ?? 0,
      followLatest,
      !followLatest,
    );
    conversationScrollMemory.set(currentScrollKey, memory);
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
      if (
        !memory.followLatest &&
        messageListRef.current === element &&
        conversationScrollMemory.get(currentScrollKey)?.followLatest === false
      ) {
        settleHistoryRestore(element, memory);
      }
    });
  };

  const scrollToLatestPosition = useCallback((behavior: "auto" | "smooth" = "auto") => {
    const element = messageListRef.current;
    if (!element) return;
    if (behavior === "smooth") {
      smoothScrollUntilRef.current = performance.now() + 520;
    }
    if (virtualItemCount === 0) {
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      if (behavior === "smooth") element.scrollTo({ top: target, behavior });
      else element.scrollTop = target;
      return;
    }
    const latestMessageId = lastVisibleMessageIdRef.current;
    const latestMessageMounted = Boolean(
      latestMessageId && element.querySelector(
        `[data-message-id="${CSS.escape(latestMessageId)}"]`,
      ),
    );
    if (latestMessageMounted) {
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const distance = Math.abs(target - element.scrollTop);
      if (behavior === "smooth" && distance > SMOOTH_SCROLL_MAX_DISTANCE_PX) {
        element.scrollTop = Math.max(
          0,
          target - element.clientHeight * SMOOTH_SCROLL_TELEPORT_VIEWPORTS,
        );
        requestAnimationFrame(() => {
          if (messageListRef.current === element && element.isConnected) {
            element.scrollTo({ top: target, behavior: "smooth" });
          }
        });
      } else if (behavior === "smooth") {
        element.scrollTo({ top: target, behavior });
      } else {
        element.scrollTop = target;
      }
      return;
    }
    if (behavior === "smooth") {
      virtuosoRef.current?.scrollToIndex({
        index: Math.max(0, virtualItemCount - 8),
        align: "end",
        behavior: "auto",
      });
      requestAnimationFrame(() => {
        if (messageListRef.current === element && element.isConnected) {
          virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
        }
      });
    } else {
      virtuosoRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior: "auto",
      });
    }
  }, [virtualItemCount]);

  const cancelHistoryRestore = useCallback(() => {
    if (historyRestoreFrameRef.current === undefined) return;
    cancelAnimationFrame(historyRestoreFrameRef.current);
    historyRestoreFrameRef.current = undefined;
  }, []);

  const settleHistoryRestore = useCallback((
    element: HTMLElement,
    memory: ConversationScrollMemory,
  ) => {
    cancelHistoryRestore();
    let remainingCorrections = 8;
    const restore = () => {
      if (messageListRef.current !== element || !element.isConnected) return;
      restoreScrollMemory(element, memory, virtuosoRef.current, messageItemIndexesRef.current);
      remainingCorrections -= 1;
      if (remainingCorrections > 0) {
        historyRestoreFrameRef.current = requestAnimationFrame(restore);
      } else {
        historyRestoreFrameRef.current = undefined;
      }
    };
    historyRestoreFrameRef.current = requestAnimationFrame(restore);
  }, [cancelHistoryRestore]);

  const stopFollowingLatest = useCallback(() => {
    cancelHistoryRestore();
    initialPositionCancelledIdentityRef.current = initialLocationIdentity;
    if (latestJumpFrameRef.current !== undefined) {
      cancelAnimationFrame(latestJumpFrameRef.current);
      latestJumpFrameRef.current = undefined;
    }
    if (initialPositionFrameRef.current !== undefined) {
      cancelAnimationFrame(initialPositionFrameRef.current);
      initialPositionFrameRef.current = undefined;
    }
    if (positionCorrectionIdentityRef.current === initialLocationIdentity) {
      positionCorrectionIdentityRef.current = undefined;
      initialPositionStableFramesRef.current = 0;
      initialPositionSignatureRef.current = undefined;
      setPositionedScrollIdentity(initialLocationIdentity);
    }
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const stored = conversationScrollMemory.get(currentScrollKey);
    const anchor = nearbyVisibleAnchor(element);
    conversationScrollMemory.set(currentScrollKey, {
      scrollTop: element.scrollTop,
      followLatest: false,
      lastKnownMessageId: lastVisibleMessageIdRef.current,
      pendingNewCount: stored?.pendingNewCount ?? 0,
      anchorMessageId: anchor?.messageId ?? stored?.anchorMessageId,
      anchorOffset: anchor?.offset ?? stored?.anchorOffset,
    });
    updateLatestPosition(currentScrollKey, false);
  }, [cancelHistoryRestore, currentScrollKey, initialLocationIdentity]);

  const scheduleExactBottomCorrection = useCallback(() => {
    if (!currentScrollKey || search) return;
    const stored = conversationScrollMemory.get(currentScrollKey);
    if (!stored?.followLatest) return;
    if (heightCorrectionTimerRef.current !== undefined) {
      globalThis.clearTimeout(heightCorrectionTimerRef.current);
    }
    if (heightCorrectionFrameRef.current !== undefined) {
      cancelAnimationFrame(heightCorrectionFrameRef.current);
      heightCorrectionFrameRef.current = undefined;
    }
    // Rich media, wrapping, and the composer can change the measured height over
    // several consecutive frames. Wait until ResizeObserver notifications become
    // quiet, then converge without correcting every individual notification.
    heightCorrectionTimerRef.current = globalThis.setTimeout(() => {
      heightCorrectionTimerRef.current = undefined;
      if (performance.now() < smoothScrollUntilRef.current) {
        heightCorrectionTimerRef.current = globalThis.setTimeout(() => {
          heightCorrectionTimerRef.current = undefined;
          scheduleExactBottomCorrection();
        }, Math.max(16, smoothScrollUntilRef.current - performance.now()));
        return;
      }
      let remainingFrames = 4;
      const settleLatest = () => {
        if (!conversationScrollMemory.get(currentScrollKey)?.followLatest) {
          heightCorrectionFrameRef.current = undefined;
          return;
        }
        scrollToLatestPosition();
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          heightCorrectionFrameRef.current = requestAnimationFrame(settleLatest);
        } else {
          heightCorrectionFrameRef.current = undefined;
        }
      };
      settleLatest();
    }, 80);
  }, [currentScrollKey, scrollToLatestPosition, search]);

  const jumpToLatest = useCallback(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    initialPositionCancelledIdentityRef.current = undefined;
    scrollPointerActiveRef.current = false;
    userScrollIntentUntilRef.current = 0;
    conversationScrollMemory.set(currentScrollKey, {
      scrollTop: element.scrollTop,
      followLatest: true,
      lastKnownMessageId: lastVisibleMessageId,
      pendingNewCount: 0,
    });
    const initial = initialLocationRef.current;
    if (initial) {
      initialLocationRef.current = {
        ...initial,
        location: { index: "LAST", align: "end", behavior: "auto" },
        mode: "bottom",
        targetMessageId: undefined,
      };
      initialPositionStableFramesRef.current = 0;
      initialPositionSignatureRef.current = undefined;
    }
    if (latestJumpFrameRef.current !== undefined) cancelAnimationFrame(latestJumpFrameRef.current);
    if (smoothScrollTimerRef.current !== undefined) globalThis.clearTimeout(smoothScrollTimerRef.current);
    latestJumpFrameRef.current = requestAnimationFrame(() => {
      latestJumpFrameRef.current = undefined;
      scrollToLatestPosition("smooth");
    });
    smoothScrollTimerRef.current = globalThis.setTimeout(() => {
      smoothScrollTimerRef.current = undefined;
      if (conversationScrollMemory.get(currentScrollKey)?.followLatest) {
        scrollToLatestPosition("auto");
      }
    }, 520);
    scheduleExactBottomCorrection();
    initialPositionVerifierRef.current();
    updateNewMessageNotice(currentScrollKey, 0);
    updateLatestPosition(currentScrollKey, true);
  }, [currentScrollKey, lastVisibleMessageId, scheduleExactBottomCorrection, scrollToLatestPosition]);

  const followOutput = useCallback((): "smooth" | false => {
    if (!currentScrollKey) return false;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest !== true) return false;
    smoothScrollUntilRef.current = performance.now() + 520;
    return "smooth";
  }, [currentScrollKey]);

  const onTotalListHeightChanged = useCallback(() => {
    initialPositionVerifierRef.current();
    scheduleExactBottomCorrection();
  }, [scheduleExactBottomCorrection]);

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
      if (!previous || previous.key !== currentScrollKey || previous.search !== search) {
        virtuosoRef.current?.scrollToIndex({ index: 0, align: "start", behavior: "auto" });
      }
      updateNewMessageNotice(currentScrollKey, stored?.pendingNewCount ?? 0);
      previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
      return;
    }

    const pendingEntryRequest = matchingEntryRequest?.requestId &&
        matchingEntryRequest.requestId > handledEntryRequestRef.current
      ? matchingEntryRequest
      : undefined;
    const pendingServerMessageId = pendingEntryRequest?.serverMessageId;
    const pendingServerMessageIndex = pendingServerMessageId
      ? messageItemIndexes.get(pendingServerMessageId)
      : undefined;
    let pendingNewCount = stored?.pendingNewCount ?? 0;
    let followLatest = stored?.followLatest ?? true;
    const enteringChat = !previous || previous.key !== currentScrollKey;
    const leavingSearch = previous?.key === currentScrollKey && Boolean(previous.search);
    const placeMessageAtCenter = (messageId: string) => {
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "auto" });
        return target.getBoundingClientRect().top - element.getBoundingClientRect().top;
      }
      const itemIndex = messageItemIndexes.get(messageId);
      if (itemIndex !== undefined) {
        virtuosoRef.current?.scrollToIndex({
          index: itemIndex,
          align: "center",
          behavior: "auto",
        });
      }
      return Math.max(0, element.clientHeight / 2);
    };
    if (enteringChat || leavingSearch) {
      if (matchingLatestRequest) {
        scrollToLatestPosition();
        pendingNewCount = 0;
        followLatest = true;
        conversationScrollMemory.set(currentScrollKey, {
          scrollTop: element.scrollTop,
          followLatest: true,
          lastKnownMessageId: lastId,
          pendingNewCount: 0,
        });
      } else if (stored?.followLatest === false) {
        restoreScrollMemory(element, stored, virtuosoRef.current, messageItemIndexes);
        pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
        followLatest = false;
        conversationScrollMemory.set(currentScrollKey, {
          ...stored,
          scrollTop: element.scrollTop,
          lastKnownMessageId: lastId,
          pendingNewCount,
        });
      } else if (stored) {
        scrollToLatestPosition();
        pendingNewCount = 0;
        followLatest = true;
        conversationScrollMemory.set(currentScrollKey, {
          scrollTop: element.scrollTop,
          followLatest: true,
          lastKnownMessageId: lastId,
          pendingNewCount: 0,
        });
      } else if (pendingServerMessageId && pendingServerMessageIndex === undefined) {
        previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
        return;
      } else {
        const serverMessageId = pendingServerMessageId;
        if (pendingEntryRequest) {
          handledEntryRequestRef.current = Math.max(
            handledEntryRequestRef.current,
            pendingEntryRequest.requestId,
          );
        }
        if (
          serverMessageId &&
          serverMessageId !== lastId &&
          messageItemIndexes.has(serverMessageId)
        ) {
          const anchorOffset = placeMessageAtCenter(serverMessageId);
          followLatest = false;
          conversationScrollMemory.set(currentScrollKey, {
            scrollTop: element.scrollTop,
            followLatest: false,
            lastKnownMessageId: lastId,
            pendingNewCount: appendedMessageCount(visibleMessages, serverMessageId),
            anchorMessageId: serverMessageId,
            anchorOffset,
          });
        } else {
          scrollToLatestPosition();
          pendingNewCount = 0;
          followLatest = true;
          conversationScrollMemory.set(currentScrollKey, {
            scrollTop: element.scrollTop,
            followLatest: true,
            lastKnownMessageId: lastId,
            pendingNewCount: 0,
          });
        }
      }
      const memory = conversationScrollMemory.get(currentScrollKey)!;
      updateNewMessageNotice(currentScrollKey, memory.pendingNewCount);
      if (memory.followLatest) scheduleExactBottomCorrection();
      previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
      return;
    } else if (!stored && pendingServerMessageId && pendingServerMessageIndex === undefined) {
      previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
      return;
    } else if (!stored && pendingServerMessageId) {
      const anchorOffset = placeMessageAtCenter(pendingServerMessageId);
      handledEntryRequestRef.current = Math.max(
        handledEntryRequestRef.current,
        pendingEntryRequest?.requestId ?? 0,
      );
      followLatest = false;
      conversationScrollMemory.set(currentScrollKey, {
        scrollTop: element.scrollTop,
        followLatest: false,
        lastKnownMessageId: lastId,
        pendingNewCount: appendedMessageCount(visibleMessages, pendingServerMessageId),
        anchorMessageId: pendingServerMessageId,
        anchorOffset,
      });
      const memory = conversationScrollMemory.get(currentScrollKey)!;
      updateNewMessageNotice(currentScrollKey, memory.pendingNewCount);
      previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
      return;
    } else if (stored) {
      const firstMessageChanged = previous.firstId !== firstId;
      const previousFirstStillPresent = Boolean(
        previous.firstId && visibleMessages.some((message) => message.id === previous.firstId),
      );
      if (firstMessageChanged && previousFirstStillPresent) {
        if (stored.followLatest) {
          scrollToLatestPosition();
        }
        else {
          restoreScrollMemory(element, stored, virtuosoRef.current, messageItemIndexes);
          settleHistoryRestore(element, stored);
          restoredHistoryAnchor = historyTraceRef.current?.key === currentScrollKey;
        }
      }

      if (previous.lastId !== lastId) {
        if (stored.followLatest) {
          pendingNewCount = 0;
          followLatest = true;
        } else {
          pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
          followLatest = false;
        }
      }
    }

    const capturedMemory = captureScrollMemory(
      element,
      lastId,
      pendingNewCount,
      followLatest,
      !followLatest,
    );
    const memory = !followLatest && !capturedMemory.anchorMessageId && stored?.anchorMessageId
      ? {
          ...capturedMemory,
          anchorMessageId: stored.anchorMessageId,
          anchorOffset: stored.anchorOffset,
        }
      : capturedMemory;
    conversationScrollMemory.set(currentScrollKey, memory);
    updateNewMessageNotice(currentScrollKey, memory.pendingNewCount);
    if (memory.followLatest) scheduleExactBottomCorrection();
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
    lastVisibleMessageId,
    matchingEntryRequest,
    matchingLatestRequest,
    messageListElement,
    messageItemIndexes,
    search,
    scheduleExactBottomCorrection,
    scrollToLatestPosition,
    settleHistoryRestore,
    virtualItemCount,
    visibleMessages,
  ]);

  const verifyInitialPosition = useCallback(() => {
    initialPositionFrameRef.current = undefined;
    const element = messageListRef.current;
    const initial = initialLocationRef.current;
    if (
      !element ||
      !currentScrollKey ||
      initial?.identity !== initialLocationIdentity ||
      initialPositionCancelledIdentityRef.current === initialLocationIdentity ||
      (
        positionedScrollIdentity === initialLocationIdentity &&
        positionCorrectionIdentityRef.current !== initialLocationIdentity
      )
    ) return;

    if (initial.mode === "pending") {
      initialPositionStableFramesRef.current = 0;
      initialPositionSignatureRef.current = undefined;
      return;
    }
    let signature: string;
    if (initial.mode === "empty") {
      if (historyLoading || virtualItemCount > 0) {
        initialPositionStableFramesRef.current = 0;
        initialPositionSignatureRef.current = undefined;
        return;
      }
      signature = "empty";
    } else if (initial.mode === "bottom") {
      const latestMessageId = lastVisibleMessageIdRef.current;
      const latest = latestMessageId
        ? element.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(latestMessageId)}"]`,
          )
        : undefined;
      if (!latest || distanceFromBottom(element) > BOTTOM_PROXIMITY_PX) {
        if (performance.now() < smoothScrollUntilRef.current) {
          initialPositionFrameRef.current = requestAnimationFrame(() => verifyInitialPosition());
          return;
        }
        scrollToLatestPosition();
        initialPositionStableFramesRef.current = 0;
        initialPositionSignatureRef.current = undefined;
        initialPositionFrameRef.current = requestAnimationFrame(() => verifyInitialPosition());
        return;
      }
      signature = `${Math.round(element.scrollHeight)}:${Math.round(element.scrollTop)}:${Math.round(element.clientHeight)}`;
    } else {
      const target = initial.targetMessageId
        ? element.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(initial.targetMessageId)}"]`,
          )
        : undefined;
      if (!target) {
        const memory = currentScrollKey
          ? conversationScrollMemory.get(currentScrollKey)
          : undefined;
        if (memory && memory.anchorMessageId === initial.targetMessageId) {
          restoreScrollMemory(
            element,
            memory,
            virtuosoRef.current,
            messageItemIndexesRef.current,
          );
        }
        initialPositionStableFramesRef.current = 0;
        initialPositionSignatureRef.current = undefined;
        initialPositionFrameRef.current = requestAnimationFrame(() => verifyInitialPosition());
        return;
      }
      const listBounds = element.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      if (targetBounds.bottom <= listBounds.top + 1 || targetBounds.top >= listBounds.bottom - 1) {
        const memory = currentScrollKey
          ? conversationScrollMemory.get(currentScrollKey)
          : undefined;
        if (memory && memory.anchorMessageId === initial.targetMessageId) {
          restoreScrollMemory(
            element,
            memory,
            virtuosoRef.current,
            messageItemIndexesRef.current,
          );
        }
        initialPositionStableFramesRef.current = 0;
        initialPositionSignatureRef.current = undefined;
        initialPositionFrameRef.current = requestAnimationFrame(() => verifyInitialPosition());
        return;
      }
      const memory = currentScrollKey
        ? conversationScrollMemory.get(currentScrollKey)
        : undefined;
      const targetOffset = targetBounds.top - listBounds.top;
      if (
        element.scrollHeight > element.clientHeight + 1 &&
        memory &&
        memory.anchorMessageId === initial.targetMessageId &&
        memory.anchorOffset !== undefined &&
        Math.abs(targetOffset - memory.anchorOffset) > 2
      ) {
        element.scrollTop += targetOffset - memory.anchorOffset;
        initialPositionStableFramesRef.current = 0;
        initialPositionSignatureRef.current = undefined;
        initialPositionFrameRef.current = requestAnimationFrame(() => verifyInitialPosition());
        return;
      }
      signature = `${Math.round(element.scrollHeight)}:${Math.round(targetOffset)}:${Math.round(element.clientHeight)}`;
    }

    if (initialPositionSignatureRef.current === signature) {
      initialPositionStableFramesRef.current += 1;
    } else {
      initialPositionSignatureRef.current = signature;
      initialPositionStableFramesRef.current = 1;
    }
    if (initialPositionStableFramesRef.current < 3) {
      initialPositionFrameRef.current = requestAnimationFrame(() => verifyInitialPosition());
      return;
    }

    setPositionedScrollIdentity(initialLocationIdentity);
    if (positionCorrectionIdentityRef.current === initialLocationIdentity) {
      positionCorrectionIdentityRef.current = undefined;
    }
  }, [
    currentScrollKey,
    historyLoading,
    initialLocationIdentity,
    positionedScrollIdentity,
    scrollToLatestPosition,
    virtualItemCount,
  ]);

  const scheduleInitialPositionVerification = useCallback(() => {
    if (!historyLoading || virtualItemCount > 0) {
      markConversationSwitch(performanceTraceId, "virtuosoRange", {
        messageCount: visibleMessages.length,
        blockCount: virtualItemCount,
      });
    }
    if (initialPositionFrameRef.current !== undefined) return;
    initialPositionFrameRef.current = requestAnimationFrame(verifyInitialPosition);
  }, [historyLoading, performanceTraceId, verifyInitialPosition, virtualItemCount, visibleMessages.length]);
  initialPositionVerifierRef.current = scheduleInitialPositionVerification;

  useLayoutEffect(() => {
    if (historyLoading && virtualItemCount === 0) return;
    markConversationSwitch(performanceTraceId, "dataReady", {
      messageCount: visibleMessages.length,
      blockCount: virtualItemCount,
    });
  }, [historyLoading, performanceTraceId, virtualItemCount, visibleMessages.length]);

  useLayoutEffect(() => {
    if (
      (historyLoading && virtualItemCount === 0) ||
      positionedScrollIdentity !== initialLocationIdentity
    ) return;
    markConversationSwitch(performanceTraceId, "positioned", {
      messageCount: visibleMessages.length,
      blockCount: virtualItemCount,
    });
  }, [
    historyLoading,
    initialLocationIdentity,
    performanceTraceId,
    positionedScrollIdentity,
    virtualItemCount,
    visibleMessages.length,
  ]);

  useLayoutEffect(() => {
    if (!currentScrollKey) return;
    initialPositionCancelledIdentityRef.current = undefined;
    initialPositionStableFramesRef.current = 0;
    initialPositionSignatureRef.current = undefined;
    positionCorrectionIdentityRef.current = initialLocationIdentity;
    initialPositionVerifierRef.current();
    return () => {
      if (positionCorrectionIdentityRef.current === initialLocationIdentity) {
        positionCorrectionIdentityRef.current = undefined;
      }
      if (initialPositionFrameRef.current !== undefined) {
        cancelAnimationFrame(initialPositionFrameRef.current);
        initialPositionFrameRef.current = undefined;
      }
      initialPositionStableFramesRef.current = 0;
      initialPositionSignatureRef.current = undefined;
    };
  }, [currentScrollKey, initialLocationIdentity, messageListElement]);

  const onInitialAtBottomStateChange = useCallback((atBottom: boolean) => {
    if (currentScrollKey) updateLatestPosition(currentScrollKey, atBottom);
    if (atBottom) scheduleInitialPositionVerification();
  }, [currentScrollKey, scheduleInitialPositionVerification]);

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
    let animationFrame: number | undefined;
    let cancelled = false;
    let jumpSnapshot: HTMLElement | undefined;
    let stableSignature: string | undefined;
    let stableFrames = 0;
    const captureJumpSnapshot = () => {
      if (jumpSnapshot || document.querySelector("[data-conversation-switch-snapshot]")) return;
      jumpSnapshot = captureConversationSwitchSnapshot();
    };
    const releaseJumpSnapshot = () => {
      removeConversationSwitchSnapshot(jumpSnapshot);
      jumpSnapshot = undefined;
    };
    const centeredOffset = (target: HTMLElement) => {
      const listBounds = element.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      return (targetBounds.top + targetBounds.height / 2) -
        (listBounds.top + listBounds.height / 2);
    };
    const finishJump = () => {
      if (cancelled || messageListRef.current !== element) return;
      releaseJumpSnapshot();
      const memory = captureScrollMemory(element, lastVisibleMessageId, 0, false, true);
      conversationScrollMemory.set(currentScrollKey, {
        ...memory,
        followLatest: false,
        pendingNewCount: 0,
      });
      updateNewMessageNotice(currentScrollKey, 0);
      setPositionedScrollIdentity(initialLocationIdentity);
      if (positionCorrectionIdentityRef.current === initialLocationIdentity) {
        positionCorrectionIdentityRef.current = undefined;
      }
      markConversationSwitch(messageRequest.performanceTraceId, "positioned", {
        messageCount: visibleMessages.length,
        blockCount: virtualItemCount,
      });
    };
    const animateToTarget = (initialTarget: HTMLElement) => {
      const initialOffset = centeredOffset(initialTarget);
      if (Math.abs(initialOffset) < 1) {
        finishJump();
        return;
      }
      const startedAt = performance.now();
      const duration = Math.min(420, Math.max(220, Math.abs(initialOffset) * 0.42));
      const step = (now: number) => {
        if (cancelled || messageListRef.current !== element) return;
        const target = element.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageRequest.messageId)}"]`,
        );
        if (!target) {
          finishJump();
          return;
        }
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const desiredOffset = initialOffset * (1 - eased);
        element.scrollTop += centeredOffset(target) - desiredOffset;
        if (progress < 1) {
          animationFrame = requestAnimationFrame(step);
        } else {
          finishJump();
        }
      };
      animationFrame = requestAnimationFrame(step);
    };
    const animateWhenStable = () => {
      if (cancelled || messageListRef.current !== element) return;
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageRequest.messageId)}"]`,
      );
      if (!target) {
        animationFrame = requestAnimationFrame(animateWhenStable);
        return;
      }
      const signature = `${Math.round(element.scrollTop)}:${Math.round(element.scrollHeight)}:${Math.round(centeredOffset(target))}`;
      if (signature === stableSignature) stableFrames += 1;
      else {
        stableSignature = signature;
        stableFrames = 1;
      }
      if (stableFrames < 2) {
        animationFrame = requestAnimationFrame(animateWhenStable);
        return;
      }
      releaseJumpSnapshot();
      animateToTarget(target);
    };
    const revealMessage = (attempt: number) => {
      if (cancelled) return;
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageRequest.messageId)}"]`,
      );
      if (!target) {
        if (attempt === 0) {
          const itemIndex = messageItemIndexes.get(messageRequest.messageId);
          if (itemIndex === undefined) return;
          captureJumpSnapshot();
          const nearby = nearbyVisibleAnchor(element);
          const currentIndex = nearby?.messageId
            ? messageItemIndexes.get(nearby.messageId)
            : undefined;
          const direction = currentIndex === undefined || itemIndex >= currentIndex ? 1 : -1;
          const teleportIndex = Math.max(0, Math.min(
            virtualItemCount - 1,
            itemIndex - direction * 6,
          ));
          virtuosoRef.current?.scrollToIndex({
            index: teleportIndex,
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
      const distance = centeredOffset(target);
      if (Math.abs(distance) > Math.max(element.clientHeight * 1.75, SMOOTH_SCROLL_MAX_DISTANCE_PX)) {
        captureJumpSnapshot();
        element.scrollTop += distance - Math.sign(distance) * element.clientHeight * SMOOTH_SCROLL_TELEPORT_VIEWPORTS;
        animationFrame = requestAnimationFrame(() => revealMessage(attempt + 1));
        return;
      }
      setHighlightedMessage({ key: currentScrollKey, messageId: messageRequest.messageId });
      if (jumpSnapshot) animateWhenStable();
      else animateToTarget(target);
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
      releaseJumpSnapshot();
    };
  }, [
    chatId,
    currentScrollKey,
    initialLocationIdentity,
    lastVisibleMessageId,
    messageItemIndexes,
    messageRequest,
    virtualItemCount,
    visibleMessages,
  ]);

  useEffect(() => () => {
    if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
    if (heightCorrectionTimerRef.current !== undefined) {
      globalThis.clearTimeout(heightCorrectionTimerRef.current);
    }
    if (heightCorrectionFrameRef.current !== undefined) {
      cancelAnimationFrame(heightCorrectionFrameRef.current);
      heightCorrectionFrameRef.current = undefined;
    }
    if (latestJumpFrameRef.current !== undefined) {
      cancelAnimationFrame(latestJumpFrameRef.current);
      latestJumpFrameRef.current = undefined;
    }
    if (smoothScrollTimerRef.current !== undefined) {
      globalThis.clearTimeout(smoothScrollTimerRef.current);
      smoothScrollTimerRef.current = undefined;
    }
    cancelHistoryRestore();
  }, [cancelHistoryRestore]);

  useLayoutEffect(() => {
    if (!currentScrollKey || search) return;
    const handle = virtuosoRef.current;
    if (!handle || conversationScrollMemory.get(currentScrollKey)?.followLatest !== false) return;
    return () => {
      handle.getState((state) => {
        conversationVirtuosoSnapshots.set(currentScrollKey, {
          state,
          firstMessageId: firstVisibleMessageId,
          lastMessageId: lastVisibleMessageId,
          virtualItemCount,
        });
      });
    };
  }, [currentScrollKey, firstVisibleMessageId, lastVisibleMessageId, search, virtualItemCount]);

  useEffect(() => {
    const element = messageListRef.current;
    if (
      !element ||
      positionedScrollIdentity !== initialLocationIdentity ||
      search ||
      historyLoading ||
      !hasOlderMessages ||
      element.scrollHeight > element.clientHeight + 1
    ) return;
    const attemptKey = `${chatId ?? ""}:${messageCount}`;
    if (autoFillAttemptRef.current === attemptKey) return;
    autoFillAttemptRef.current = attemptKey;
    loadOlder();
  }, [
    chatId,
    hasOlderMessages,
    historyLoading,
    initialLocationIdentity,
    messageCount,
    onLoadOlder,
    positionedScrollIdentity,
    search,
  ]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (event.deltaY > 0 && distanceFromBottom(element) <= 1) {
      event.preventDefault();
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (currentScrollKey) {
        conversationScrollMemory.set(currentScrollKey, {
          scrollTop: element.scrollTop,
          followLatest: true,
          lastKnownMessageId: lastVisibleMessageIdRef.current,
          pendingNewCount: 0,
        });
        updateLatestPosition(currentScrollKey, true);
      }
    } else if (event.deltaY !== 0) {
      stopFollowingLatest();
    }
    userScrollIntentUntilRef.current = performance.now() + 400;
  };
  const onPointerDown = () => {
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
      userScrollIntentUntilRef.current = performance.now() + 400;
    }
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (
      !search &&
      currentScrollKey &&
      positionedScrollIdentity === initialLocationIdentity &&
      positionCorrectionIdentityRef.current !== initialLocationIdentity
    ) {
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
      updateLatestPosition(currentScrollKey, distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX);
    }
    if (
      positionedScrollIdentity === initialLocationIdentity &&
      element.scrollTop <= 64 &&
      !search &&
      hasOlderMessages &&
      !historyLoading
    ) {
      loadOlder();
    }
  };

  return {
    messageListRef,
    setMessageListRef,
    virtuosoRef,
    currentScrollKey,
    positioning: Boolean(
      currentScrollKey && positionedScrollIdentity !== initialLocationIdentity
    ),
    // A Virtuoso instance must not retain measurements from another chat. The
    // switch snapshot covers this remount until the destination is positioned.
    virtuosoKey: `${currentScrollKey ?? scope}:${historyInitialized ? "ready" : "initial"}`,
    initialTopMostItemIndex,
    initialAlignToBottom,
    restoreStateFrom,
    highlightedMessageId: highlightedMessage && highlightedMessage.key === currentScrollKey
      ? highlightedMessage.messageId
      : undefined,
    newMessageNotice,
    awayFromLatest: Boolean(
      currentScrollKey &&
      positionedScrollIdentity === initialLocationIdentity &&
      latestPosition?.key === currentScrollKey &&
      !latestPosition.atBottom
    ),
    jumpToLatest,
    followOutput,
    onTotalListHeightChanged,
    onInitialRangeChanged: scheduleInitialPositionVerification,
    onInitialAtBottomStateChange,
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
