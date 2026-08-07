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
  logPerformance,
  markConversationSwitch,
  markHistoryInteraction,
} from "../utils/performanceMonitor";

const BOTTOM_PROXIMITY_PX = 32;
const HISTORY_TRIGGER_PX = 64;
const SMOOTH_SCROLL_DURATION_MS = 480;

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
  searchActive: boolean;
}

interface PendingHistoryRestore {
  key: string;
  previousFirstId?: string;
  anchorMessageId: string;
  anchorOffset: number;
  startedAt: number;
  beforeCount: number;
}

interface InitialLocation {
  identity: string;
  location: IndexLocationWithAlign | number;
  mode: "empty" | "bottom" | "anchor" | "search" | "pending";
  targetMessageId?: string;
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
const conversationLayouts = new Map<string, {
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
  for (const row of element.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1) {
      return {
        messageId: row.dataset.messageId,
        offset: bounds.top - listBounds.top,
      };
    }
  }
  return undefined;
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
  const visibleMessagesRef = useRef(visibleMessages);
  const firstVisibleMessageIdRef = useRef(visibleMessages[0]?.id);
  const lastVisibleMessageIdRef = useRef(visibleMessages.at(-1)?.id);
  const virtualItemCountRef = useRef(virtualItemCount);
  messageItemIndexesRef.current = messageItemIndexes;
  visibleMessagesRef.current = visibleMessages;
  firstVisibleMessageIdRef.current = visibleMessages[0]?.id;
  lastVisibleMessageIdRef.current = visibleMessages.at(-1)?.id;
  virtualItemCountRef.current = virtualItemCount;

  const previousLayoutRef = useRef<ConversationLayoutSnapshot | undefined>(undefined);
  const pendingHistoryRestoreRef = useRef<PendingHistoryRestore | undefined>(undefined);
  const historyLoadKeyRef = useRef<string | undefined>(undefined);
  const historyLoadFrameRef = useRef<number | undefined>(undefined);
  const historyRestoreFrameRef = useRef<number | undefined>(undefined);
  const bottomFrameRef = useRef<number | undefined>(undefined);
  const anchorFrameRef = useRef<number | undefined>(undefined);
  const positioningFrameRef = useRef<number | undefined>(undefined);
  const smoothScrollTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const smoothScrollUntilRef = useRef(0);
  const userIntentUntilRef = useRef(0);
  const pointerActiveRef = useRef(false);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const handledEntryRequestRef = useRef(0);
  const handledLatestRequestRef = useRef(0);
  const handledMessageRequestRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const initialLocationRef = useRef<InitialLocation | undefined>(undefined);
  const positionedIdentityRef = useRef<string | undefined>(undefined);

  const [positionedIdentity, setPositionedIdentity] = useState<string>();
  const [hasRenderedRows, setHasRenderedRows] = useState(false);
  const [followingState, setFollowingState] = useState<{
    key: string;
    followLatest: boolean;
  }>();
  const [newMessageNotice, setNewMessageNotice] = useState<{
    key: string;
    count: number;
  }>();
  const [highlightedMessage, setHighlightedMessage] = useState<{
    key: string;
    messageId: string;
  }>();

  const currentScrollKey = scrollMemoryKey(scope, chatId);
  const firstVisibleMessageId = visibleMessages[0]?.id;
  const lastVisibleMessageId = visibleMessages.at(-1)?.id;
  const matchingEntryRequest = entryRequest?.chatId === chatId ? entryRequest : undefined;
  const matchingLatestRequest = latestRequest?.chatId === chatId ? latestRequest : undefined;
  const matchingMessageRequest = messageRequest?.chatId === chatId ? messageRequest : undefined;
  const requestedTargetId = matchingMessageRequest?.messageId ?? matchingEntryRequest?.serverMessageId;
  const targetReady = requestedTargetId ? messageItemIndexes.has(requestedTargetId) : false;
  const searchActive = Boolean(search);
  const dataPhase = virtualItemCount > 0 ? "ready" : historyLoading ? "loading" : "empty";
  const targetPhase = !requestedTargetId ? "none" : targetReady ? "ready" : "pending";
  const initialLocationIdentity = [
    currentScrollKey ?? scope,
    matchingEntryRequest?.requestId ?? 0,
    matchingLatestRequest?.requestId ?? 0,
    matchingMessageRequest?.requestId ?? 0,
    searchActive ? "search" : "conversation",
    historyInitialized ? "history-ready" : "history-initial",
    dataPhase,
    targetPhase,
  ].join(":");
  const virtuosoKey = `${currentScrollKey ?? scope}:${historyInitialized ? "ready" : "initial"}:${searchActive ? "search" : "conversation"}`;
  if (currentScrollKey) {
    conversationLayouts.set(currentScrollKey, {
      firstMessageId: firstVisibleMessageId,
      lastMessageId: lastVisibleMessageId,
      virtualItemCount,
    });
  }

  if (initialLocationRef.current?.identity !== initialLocationIdentity) {
    const memory = currentScrollKey ? conversationScrollMemory.get(currentScrollKey) : undefined;
    const storedAnchorIndex = memory?.anchorMessageId
      ? messageItemIndexes.get(memory.anchorMessageId)
      : undefined;
    const targetIndex = requestedTargetId
      ? messageItemIndexes.get(requestedTargetId)
      : undefined;
    let location: IndexLocationWithAlign | number = 0;
    let mode: InitialLocation["mode"] = "empty";
    let targetMessageId: string | undefined;

    if (virtualItemCount > 0) {
      if (searchActive) {
        mode = "search";
      } else if (requestedTargetId && targetIndex === undefined) {
        mode = "pending";
        targetMessageId = requestedTargetId;
      } else if (targetIndex !== undefined) {
        location = { index: targetIndex, align: "center", behavior: "auto" };
        mode = "anchor";
        targetMessageId = requestedTargetId;
      } else if (matchingLatestRequest || memory?.followLatest !== false) {
        location = { index: "LAST", align: "end", behavior: "auto" };
        mode = "bottom";
      } else if (storedAnchorIndex !== undefined) {
        location = {
          index: storedAnchorIndex,
          align: "start",
          offset: -(memory?.anchorOffset ?? 0),
          behavior: "auto",
        };
        mode = "anchor";
        targetMessageId = memory?.anchorMessageId;
      } else {
        location = { index: "LAST", align: "end", behavior: "auto" };
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

  const initialLocation = initialLocationRef.current!;
  const initialTopMostItemIndex = initialLocation.location;
  const initialAlignToBottom = initialLocation.mode === "bottom";
  const storedMemory = currentScrollKey
    ? conversationScrollMemory.get(currentScrollKey)
    : undefined;
  const storedSnapshot = currentScrollKey
    ? conversationVirtuosoSnapshots.get(currentScrollKey)
    : undefined;
  const restoreStateFrom = !searchActive && !matchingLatestRequest && !requestedTargetId &&
      storedMemory?.followLatest === false && storedSnapshot &&
      storedSnapshot.firstMessageId === firstVisibleMessageId &&
      storedSnapshot.lastMessageId === lastVisibleMessageId &&
      storedSnapshot.virtualItemCount === virtualItemCount
    ? storedSnapshot.state
    : undefined;

  const updateFollowingState = useCallback((key: string, followLatest: boolean) => {
    setFollowingState((current) =>
      current?.key === key && current.followLatest === followLatest
        ? current
        : { key, followLatest });
  }, []);

  const updateNewMessageNotice = useCallback((key: string, count: number) => {
    setNewMessageNotice((current) =>
      current?.key === key && current.count === count ? current : { key, count });
  }, []);

  const setMessageListRef = useCallback((ref: HTMLElement | Window | null) => {
    const element = ref instanceof HTMLDivElement ? ref : null;
    messageListRef.current = element;
    setMessageListElement((current) => current === element ? current : element);
  }, []);

  useLayoutEffect(() => {
    if (messageListElement) {
      messageListElement.dataset.conversationVirtuosoKey = virtuosoKey;
    }
  }, [messageListElement, virtuosoKey]);

  useLayoutEffect(() => {
    if (!messageListElement) {
      setHasRenderedRows(false);
      return;
    }
    const updateRows = () => {
      const next = messageCount === 0 || Boolean(
        messageListElement.querySelector("[data-message-id]"),
      );
      const shell = messageListElement.closest<HTMLElement>(".message-list-shell");
      if (shell) shell.dataset.conversationRows = next ? "ready" : "empty";
      setHasRenderedRows((current) => current === next ? current : next);
    };
    updateRows();
    const observer = new MutationObserver(updateRows);
    observer.observe(messageListElement, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [messageCount, messageListElement, virtuosoKey]);

  const writeMemory = useCallback((
    key: string,
    element: HTMLElement,
    followLatest: boolean,
    pendingNewCount: number,
    captureAnchor: boolean,
  ) => {
    const anchor = captureAnchor ? visibleAnchor(element) : undefined;
    const memory: ConversationScrollMemory = {
      scrollTop: element.scrollTop,
      followLatest,
      lastKnownMessageId: lastVisibleMessageIdRef.current,
      pendingNewCount: followLatest ? 0 : pendingNewCount,
      anchorMessageId: anchor?.messageId,
      anchorOffset: anchor?.offset,
    };
    conversationScrollMemory.set(key, memory);
    updateFollowingState(key, memory.followLatest);
    updateNewMessageNotice(key, memory.pendingNewCount);
    return memory;
  }, [updateFollowingState, updateNewMessageNotice]);

  const pinToBottom = useCallback(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey || searchActive) return;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest === false) return;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - maximum) > 0.5) element.scrollTop = maximum;
  }, [currentScrollKey, searchActive]);

  const scheduleBottomPin = useCallback(() => {
    if (!currentScrollKey || searchActive) return;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest === false) return;
    if (performance.now() < smoothScrollUntilRef.current) return;
    if (pointerActiveRef.current || performance.now() <= userIntentUntilRef.current) return;
    if (bottomFrameRef.current !== undefined) return;
    bottomFrameRef.current = requestAnimationFrame(() => {
      bottomFrameRef.current = undefined;
      pinToBottom();
    });
  }, [currentScrollKey, pinToBottom, searchActive]);

  const stopFollowingLatest = useCallback(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    writeMemory(
      currentScrollKey,
      element,
      false,
      current?.pendingNewCount ?? 0,
      true,
    );
  }, [currentScrollKey, writeMemory]);

  const jumpToLatest = useCallback((behavior: "auto" | "smooth" = "smooth") => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    userIntentUntilRef.current = 0;
    pointerActiveRef.current = false;
    writeMemory(currentScrollKey, element, true, 0, false);
    if (smoothScrollTimerRef.current) globalThis.clearTimeout(smoothScrollTimerRef.current);
    if (behavior === "smooth") {
      smoothScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_DURATION_MS;
      virtuosoRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior: "smooth",
      });
      smoothScrollTimerRef.current = globalThis.setTimeout(() => {
        smoothScrollTimerRef.current = undefined;
        smoothScrollUntilRef.current = 0;
        scheduleBottomPin();
      }, SMOOTH_SCROLL_DURATION_MS);
    } else {
      smoothScrollUntilRef.current = 0;
      pinToBottom();
    }
  }, [currentScrollKey, pinToBottom, scheduleBottomPin, writeMemory]);

  const restoreAnchor = useCallback((
    element: HTMLElement,
    messageId: string,
    expectedOffset: number,
  ) => {
    const correctMountedAnchor = () => {
      const anchor = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!anchor) return false;
      const actualOffset = anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      const correction = actualOffset - expectedOffset;
      if (Math.abs(correction) > 0.5) element.scrollTop += correction;
      return true;
    };
    if (correctMountedAnchor()) return;
    const itemIndex = messageItemIndexesRef.current.get(messageId);
    if (itemIndex === undefined) return;
    virtuosoRef.current?.scrollToIndex({
      index: itemIndex,
      align: "start",
      offset: -expectedOffset,
      behavior: "auto",
    });
    if (historyRestoreFrameRef.current !== undefined) {
      cancelAnimationFrame(historyRestoreFrameRef.current);
    }
    historyRestoreFrameRef.current = requestAnimationFrame(() => {
      historyRestoreFrameRef.current = undefined;
      correctMountedAnchor();
    });
  }, []);

  const loadOlder = useCallback(() => {
    const element = messageListRef.current;
    if (
      !element ||
      !currentScrollKey ||
      searchActive ||
      historyLoading ||
      !hasOlderMessages ||
      historyLoadKeyRef.current === currentScrollKey
    ) return;
    const anchor = visibleAnchor(element);
    if (!anchor?.messageId) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    writeMemory(
      currentScrollKey,
      element,
      false,
      current?.pendingNewCount ?? 0,
      true,
    );
    pendingHistoryRestoreRef.current = {
      key: currentScrollKey,
      previousFirstId: firstVisibleMessageIdRef.current,
      anchorMessageId: anchor.messageId,
      anchorOffset: anchor.offset,
      startedAt: performance.now(),
      beforeCount: visibleMessagesRef.current.length,
    };
    historyLoadKeyRef.current = currentScrollKey;
    markHistoryInteraction();
    void onLoadOlder().finally(() => {
      if (historyLoadKeyRef.current === currentScrollKey) {
        historyLoadKeyRef.current = undefined;
      }
    });
  }, [
    currentScrollKey,
    hasOlderMessages,
    historyLoading,
    onLoadOlder,
    searchActive,
    writeMemory,
  ]);

  const scheduleOlderLoad = useCallback(() => {
    if (historyLoadFrameRef.current !== undefined) return;
    historyLoadFrameRef.current = requestAnimationFrame(() => {
      historyLoadFrameRef.current = undefined;
      loadOlder();
    });
  }, [loadOlder]);

  const completePositioning = useCallback(() => {
    if (!currentScrollKey) return;
    if (positionedIdentityRef.current === initialLocationIdentity) return;
    if (positioningFrameRef.current !== undefined) return;
    const identity = initialLocationIdentity;
    const expectedVirtuosoKey = virtuosoKey;
    let attempts = 0;
    const finishWhenRendered = () => {
      attempts += 1;
      positioningFrameRef.current = requestAnimationFrame(() => {
        positioningFrameRef.current = undefined;
        if (initialLocationRef.current?.identity !== identity) return;
        if (messageListRef.current?.dataset.conversationVirtuosoKey !== expectedVirtuosoKey) {
          if (attempts < 12) finishWhenRendered();
          return;
        }
        const hasRenderedContent = visibleMessagesRef.current.length === 0 || Boolean(
          messageListRef.current?.querySelector("[data-message-id]"),
        );
        if (!hasRenderedContent && attempts < 12) {
          finishWhenRendered();
          return;
        }
        if (initialLocationRef.current.mode === "bottom") pinToBottom();
        positionedIdentityRef.current = identity;
        setPositionedIdentity(identity);
        markConversationSwitch(
          matchingMessageRequest?.performanceTraceId ??
            matchingLatestRequest?.performanceTraceId ??
            matchingEntryRequest?.performanceTraceId,
          "positioned",
          {
            messageCount: visibleMessagesRef.current.length,
            blockCount: virtualItemCountRef.current,
          },
        );
      });
    };
    finishWhenRendered();
  }, [
    currentScrollKey,
    initialLocationIdentity,
    matchingEntryRequest?.performanceTraceId,
    matchingLatestRequest?.performanceTraceId,
    matchingMessageRequest?.performanceTraceId,
    virtuosoKey,
    pinToBottom,
  ]);

  const revealTarget = useCallback((
    messageId: string,
    behavior: "auto" | "smooth",
    highlight: boolean,
  ) => {
    const element = messageListRef.current;
    const itemIndex = messageItemIndexesRef.current.get(messageId);
    if (!element || !currentScrollKey || itemIndex === undefined) return false;
    stopFollowingLatest();
    const mounted = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (mounted) {
      mounted.scrollIntoView({ block: "center", behavior });
    } else {
      virtuosoRef.current?.scrollToIndex({
        index: itemIndex,
        align: "center",
        behavior: "auto",
      });
    }
    requestAnimationFrame(() => {
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (target && !mounted && behavior === "smooth") {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const current = conversationScrollMemory.get(currentScrollKey);
      writeMemory(
        currentScrollKey,
        element,
        false,
        current?.pendingNewCount ?? 0,
        true,
      );
      completePositioning();
    });
    if (highlight) {
      setHighlightedMessage({ key: currentScrollKey, messageId });
      if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = globalThis.setTimeout(() => {
        highlightTimerRef.current = undefined;
        setHighlightedMessage((current) =>
          current?.key === currentScrollKey && current.messageId === messageId
            ? undefined
            : current);
      }, 1_600);
    }
    return true;
  }, [completePositioning, currentScrollKey, stopFollowingLatest, writeMemory]);

  const revealMessageStart = useCallback((messageId: string) => {
    const element = messageListRef.current;
    const row = element?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!element || !row || !currentScrollKey) return;
    const expectedOffset = row.getBoundingClientRect().top -
      element.getBoundingClientRect().top;
    stopFollowingLatest();
    requestAnimationFrame(() => {
      restoreAnchor(element, messageId, expectedOffset);
      const current = conversationScrollMemory.get(currentScrollKey);
      writeMemory(
        currentScrollKey,
        element,
        false,
        current?.pendingNewCount ?? 0,
        true,
      );
    });
  }, [currentScrollKey, restoreAnchor, stopFollowingLatest, writeMemory]);

  useLayoutEffect(() => {
    if (!currentScrollKey || !messageListElement) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    if (!current) {
      const followLatest = initialLocation.mode === "bottom" || initialLocation.mode === "empty";
      conversationScrollMemory.set(currentScrollKey, {
        scrollTop: messageListElement.scrollTop,
        followLatest,
        lastKnownMessageId: lastVisibleMessageId,
        pendingNewCount: 0,
      });
      updateFollowingState(currentScrollKey, followLatest);
      updateNewMessageNotice(currentScrollKey, 0);
    } else {
      updateFollowingState(currentScrollKey, current.followLatest);
      updateNewMessageNotice(currentScrollKey, current.pendingNewCount);
    }
  }, [
    currentScrollKey,
    initialLocation.mode,
    lastVisibleMessageId,
    messageListElement,
    updateFollowingState,
    updateNewMessageNotice,
  ]);

  useLayoutEffect(() => {
    if (!currentScrollKey || !messageListElement) return;
    const previous = previousLayoutRef.current;
    const currentMemory = conversationScrollMemory.get(currentScrollKey);
    const enteringConversation = previous?.key !== currentScrollKey;
    const leavingSearch = previous?.key === currentScrollKey &&
      previous.searchActive && !searchActive;

    if (!searchActive && currentMemory) {
      let pendingNewCount = currentMemory.pendingNewCount;
      if (enteringConversation || leavingSearch) {
        if (!currentMemory.followLatest) {
          pendingNewCount += appendedMessageCount(
            visibleMessages,
            currentMemory.lastKnownMessageId,
          );
        }
      } else if (previous?.lastId !== lastVisibleMessageId) {
        if (currentMemory.followLatest) {
          pendingNewCount = 0;
          scheduleBottomPin();
        } else {
          pendingNewCount += appendedMessageCount(visibleMessages, previous?.lastId);
        }
      }
      conversationScrollMemory.set(currentScrollKey, {
        ...currentMemory,
        lastKnownMessageId: lastVisibleMessageId,
        pendingNewCount,
      });
      updateNewMessageNotice(currentScrollKey, pendingNewCount);
    }

    const pendingHistory = pendingHistoryRestoreRef.current;
    if (
      pendingHistory?.key === currentScrollKey &&
      pendingHistory.previousFirstId !== firstVisibleMessageId
    ) {
      pendingHistoryRestoreRef.current = undefined;
      restoreAnchor(
        messageListElement,
        pendingHistory.anchorMessageId,
        pendingHistory.anchorOffset,
      );
      const anchor = messageListElement.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(pendingHistory.anchorMessageId)}"]`,
      );
      const actualOffset = anchor
        ? anchor.getBoundingClientRect().top - messageListElement.getBoundingClientRect().top
        : undefined;
      logPerformance("ui_history_render", {
        durationMs: performance.now() - pendingHistory.startedAt,
        addedCount: Math.max(0, visibleMessages.length - pendingHistory.beforeCount),
        scrollTop: messageListElement.scrollTop,
        scrollHeight: messageListElement.scrollHeight,
        anchorShiftPx: actualOffset === undefined
          ? undefined
          : Math.abs(actualOffset - pendingHistory.anchorOffset),
      });
    }

    previousLayoutRef.current = {
      key: currentScrollKey,
      firstId: firstVisibleMessageId,
      lastId: lastVisibleMessageId,
      searchActive,
    };
  }, [
    currentScrollKey,
    firstVisibleMessageId,
    lastVisibleMessageId,
    messageListElement,
    restoreAnchor,
    scheduleBottomPin,
    searchActive,
    updateNewMessageNotice,
    visibleMessages,
  ]);

  useLayoutEffect(() => {
    if (!currentScrollKey) return;
    markConversationSwitch(
      matchingMessageRequest?.performanceTraceId ??
        matchingLatestRequest?.performanceTraceId ??
        matchingEntryRequest?.performanceTraceId,
      "dataReady",
      { messageCount: visibleMessages.length, blockCount: virtualItemCount },
    );
    if (virtualItemCount === 0 && !historyLoading) completePositioning();
  }, [
    completePositioning,
    currentScrollKey,
    historyLoading,
    matchingEntryRequest?.performanceTraceId,
    matchingLatestRequest?.performanceTraceId,
    matchingMessageRequest?.performanceTraceId,
    virtualItemCount,
    visibleMessages.length,
  ]);

  useLayoutEffect(() => {
    if (
      !matchingLatestRequest ||
      matchingLatestRequest.requestId <= handledLatestRequestRef.current ||
      !messageListElement
    ) return;
    handledLatestRequestRef.current = matchingLatestRequest.requestId;
    jumpToLatest("auto");
  }, [jumpToLatest, matchingLatestRequest, messageListElement]);

  useLayoutEffect(() => {
    if (
      !matchingMessageRequest ||
      matchingMessageRequest.requestId <= handledMessageRequestRef.current ||
      !targetReady
    ) return;
    if (revealTarget(matchingMessageRequest.messageId, "smooth", true)) {
      handledMessageRequestRef.current = matchingMessageRequest.requestId;
    }
  }, [matchingMessageRequest, revealTarget, targetReady]);

  useLayoutEffect(() => {
    if (
      !matchingEntryRequest ||
      matchingEntryRequest.requestId <= handledEntryRequestRef.current
    ) return;
    if (!matchingEntryRequest.serverMessageId) {
      handledEntryRequestRef.current = matchingEntryRequest.requestId;
      completePositioning();
      return;
    }
    if (!targetReady) return;
    if (revealTarget(matchingEntryRequest.serverMessageId, "auto", false)) {
      handledEntryRequestRef.current = matchingEntryRequest.requestId;
    }
  }, [completePositioning, matchingEntryRequest, revealTarget, targetReady]);

  useLayoutEffect(() => {
    if (!searchActive || !messageListElement) return;
    if (virtualItemCount > 0) {
      virtuosoRef.current?.scrollToIndex({ index: 0, align: "start", behavior: "auto" });
    }
    completePositioning();
  }, [completePositioning, messageListElement, searchActive, virtualItemCount]);

  useLayoutEffect(() => {
    if (!currentScrollKey || searchActive) return;
    const key = currentScrollKey;
    const element = messageListRef.current;
    const handle = virtuosoRef.current;
    return () => {
      if (!element) return;
      const current = conversationScrollMemory.get(key);
      const followLatest = current?.followLatest ??
        distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
      const anchor = followLatest ? undefined : visibleAnchor(element);
      const layout = conversationLayouts.get(key);
      conversationScrollMemory.set(key, {
        scrollTop: element.scrollTop,
        followLatest,
        lastKnownMessageId: layout?.lastMessageId,
        pendingNewCount: followLatest ? 0 : (current?.pendingNewCount ?? 0),
        anchorMessageId: anchor?.messageId,
        anchorOffset: anchor?.offset,
      });
      if (!followLatest) {
        handle?.getState((state) => {
          conversationVirtuosoSnapshots.set(key, {
            state,
            firstMessageId: layout?.firstMessageId,
            lastMessageId: layout?.lastMessageId,
            virtualItemCount: layout?.virtualItemCount ?? 0,
          });
        });
      }
    };
  }, [currentScrollKey, searchActive]);

  useEffect(() => {
    const element = messageListRef.current;
    if (
      !element ||
      !currentScrollKey ||
      positionedIdentity !== initialLocationIdentity ||
      searchActive ||
      historyLoading ||
      !hasOlderMessages ||
      element.scrollHeight > element.clientHeight + 1
    ) return;
    const attemptKey = `${currentScrollKey}:${messageCount}`;
    if (autoFillAttemptRef.current === attemptKey) return;
    autoFillAttemptRef.current = attemptKey;
    loadOlder();
  }, [
    currentScrollKey,
    hasOlderMessages,
    historyLoading,
    initialLocationIdentity,
    loadOlder,
    messageCount,
    positionedIdentity,
    searchActive,
  ]);

  useEffect(() => () => {
    if (historyLoadFrameRef.current !== undefined) cancelAnimationFrame(historyLoadFrameRef.current);
    if (historyRestoreFrameRef.current !== undefined) cancelAnimationFrame(historyRestoreFrameRef.current);
    if (bottomFrameRef.current !== undefined) cancelAnimationFrame(bottomFrameRef.current);
    if (anchorFrameRef.current !== undefined) cancelAnimationFrame(anchorFrameRef.current);
    if (positioningFrameRef.current !== undefined) cancelAnimationFrame(positioningFrameRef.current);
    if (smoothScrollTimerRef.current) globalThis.clearTimeout(smoothScrollTimerRef.current);
    if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
  }, []);

  const followOutput = useCallback((): false => false, []);

  const onTotalListHeightChanged = useCallback(() => {
    if (!currentScrollKey || searchActive) return;
    const memory = conversationScrollMemory.get(currentScrollKey);
    if (memory?.followLatest !== false) {
      pinToBottom();
      return;
    }
    if (
      !memory.anchorMessageId ||
      memory.anchorOffset === undefined ||
      pointerActiveRef.current ||
      performance.now() <= userIntentUntilRef.current ||
      anchorFrameRef.current !== undefined
    ) return;
    const element = messageListRef.current;
    if (!element) return;
    anchorFrameRef.current = requestAnimationFrame(() => {
      anchorFrameRef.current = undefined;
      const latestMemory = conversationScrollMemory.get(currentScrollKey);
      if (
        latestMemory?.followLatest !== false ||
        !latestMemory.anchorMessageId ||
        latestMemory.anchorOffset === undefined
      ) return;
      restoreAnchor(element, latestMemory.anchorMessageId, latestMemory.anchorOffset);
    });
  }, [currentScrollKey, pinToBottom, restoreAnchor, searchActive]);

  const onInitialRangeChanged = useCallback(() => {
    markConversationSwitch(
      matchingMessageRequest?.performanceTraceId ??
        matchingLatestRequest?.performanceTraceId ??
        matchingEntryRequest?.performanceTraceId,
      "virtuosoRange",
      { messageCount: visibleMessagesRef.current.length, blockCount: virtualItemCountRef.current },
    );
    completePositioning();
  }, [
    completePositioning,
    matchingEntryRequest?.performanceTraceId,
    matchingLatestRequest?.performanceTraceId,
    matchingMessageRequest?.performanceTraceId,
  ]);

  const onInitialAtBottomStateChange = useCallback((atBottom: boolean) => {
    if (!atBottom || !currentScrollKey) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    if (current?.followLatest) {
      updateFollowingState(currentScrollKey, true);
      completePositioning();
    }
  }, [completePositioning, currentScrollKey, updateFollowingState]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (event.deltaY > 0 && distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX) {
      event.preventDefault();
      if (currentScrollKey) writeMemory(currentScrollKey, element, true, 0, false);
      pinToBottom();
      return;
    }
    if (event.deltaY !== 0) {
      userIntentUntilRef.current = performance.now() + 320;
      if (event.deltaY < 0) stopFollowingLatest();
    }
  };

  const onPointerDown = () => {
    pointerActiveRef.current = true;
    userIntentUntilRef.current = performance.now() + 320;
  };

  const onPointerUp = () => {
    pointerActiveRef.current = false;
    userIntentUntilRef.current = performance.now() + 180;
  };

  const onPointerCancel = () => {
    pointerActiveRef.current = false;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "End") {
      if (currentScrollKey) {
        writeMemory(currentScrollKey, event.currentTarget, true, 0, false);
      }
      userIntentUntilRef.current = performance.now() + 320;
      return;
    }
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
      userIntentUntilRef.current = performance.now() + 320;
      stopFollowingLatest();
    } else if (["ArrowDown", "PageDown", " "].includes(event.key)) {
      userIntentUntilRef.current = performance.now() + 320;
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (!currentScrollKey || searchActive) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    const userInitiated = pointerActiveRef.current ||
      performance.now() <= userIntentUntilRef.current;
    const atBottom = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
    const followLatest = userInitiated
      ? atBottom
      : atBottom || current?.followLatest === true;
    writeMemory(
      currentScrollKey,
      element,
      followLatest,
      current?.pendingNewCount ?? 0,
      !followLatest,
    );
    if (
      element.scrollTop <= HISTORY_TRIGGER_PX &&
      hasOlderMessages &&
      !historyLoading
    ) {
      scheduleOlderLoad();
    }
  };

  return {
    messageListRef,
    setMessageListRef,
    virtuosoRef,
    currentScrollKey,
    positioning: Boolean(
      currentScrollKey && (
        positionedIdentity !== initialLocationIdentity ||
        (messageCount > 0 && !hasRenderedRows)
      )
    ),
    virtuosoKey,
    initialTopMostItemIndex,
    initialAlignToBottom,
    restoreStateFrom,
    highlightedMessageId: highlightedMessage && highlightedMessage.key === currentScrollKey
      ? highlightedMessage.messageId
      : undefined,
    newMessageNotice,
    awayFromLatest: Boolean(
      currentScrollKey &&
      positionedIdentity === initialLocationIdentity &&
      followingState?.key === currentScrollKey &&
      !followingState.followLatest
    ),
    jumpToLatest,
    revealMessageStart,
    followOutput,
    onTotalListHeightChanged,
    onInitialRangeChanged,
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
