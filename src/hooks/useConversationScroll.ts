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
import type { IndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import type { Message } from "../telegram/types";
import {
  appendedMessageCount,
  conversationLayouts,
  conversationScrollMemory,
  conversationVirtuosoSnapshots,
  distanceFromBottom,
  scrollMemoryKey,
  visibleAnchor,
  type ConversationLayoutSnapshot,
  type ConversationScrollMemory,
  type InitialLocation,
  type PendingHistoryRestore,
} from "./conversationScrollState";
export { hasConversationScrollMemory } from "./conversationScrollState";
import {
  logPerformance,
  markConversationSwitch,
  markHistoryInteraction,
} from "../utils/performanceMonitor";

const BOTTOM_PROXIMITY_PX = 32;
const BOTTOM_EPSILON_PX = 1;
const HISTORY_TRIGGER_PX = 64;
const SMOOTH_SCROLL_DURATION_MS = 480;

type ScrollControlMode = "following" | "detached" | "restoring" | "navigating";

interface ScrollControlState {
  identity: string;
  generation: number;
  mode: ScrollControlMode;
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
  const bottomSettleFrameRef = useRef<number | undefined>(undefined);
  const anchorFrameRef = useRef<number | undefined>(undefined);
  const contentAnchorFrameRef = useRef<number | undefined>(undefined);
  const positioningAnchorFrameRef = useRef<number | undefined>(undefined);
  const positioningFrameRef = useRef<number | undefined>(undefined);
  const positioningIdentityRef = useRef<string | undefined>(undefined);
  const smoothScrollTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const smoothScrollUntilRef = useRef(0);
  const userIntentUntilRef = useRef(0);
  const pointerActiveRef = useRef(false);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const handledEntryRequestRef = useRef(0);
  const handledLatestRequestRef = useRef(0);
  const handledMessageRequestRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const revealTargetTokenRef = useRef<symbol | undefined>(undefined);
  const navigationRequestIdentityRef = useRef("");
  const initialLocationRef = useRef<InitialLocation | undefined>(undefined);
  const positionedIdentityRef = useRef<string | undefined>(undefined);
  const scrollControlRef = useRef<ScrollControlState>({
    identity: "",
    generation: 0,
    mode: "restoring",
  });

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
  const navigationRequestIdentity = [
    matchingEntryRequest?.requestId ?? 0,
    matchingLatestRequest?.requestId ?? 0,
    matchingMessageRequest?.requestId ?? 0,
  ].join(":");
  if (matchingEntryRequest || matchingLatestRequest || matchingMessageRequest) {
    navigationRequestIdentityRef.current = navigationRequestIdentity;
  }
  const pendingEntryRequest = matchingEntryRequest &&
    matchingEntryRequest.requestId > handledEntryRequestRef.current
    ? matchingEntryRequest
    : undefined;
  const pendingLatestRequest = matchingLatestRequest &&
    matchingLatestRequest.requestId > handledLatestRequestRef.current
    ? matchingLatestRequest
    : undefined;
  const pendingMessageRequest = matchingMessageRequest &&
    matchingMessageRequest.requestId > handledMessageRequestRef.current
    ? matchingMessageRequest
    : undefined;
  const requestedTargetId = pendingMessageRequest?.messageId ?? pendingEntryRequest?.serverMessageId;
  const targetReady = requestedTargetId ? messageItemIndexes.has(requestedTargetId) : false;
  const requestIdentityTargetId = matchingMessageRequest?.messageId ??
    matchingEntryRequest?.serverMessageId;
  const searchActive = Boolean(search);
  const dataPhase = virtualItemCount > 0 ? "ready" : historyLoading ? "loading" : "empty";
  const targetPhase = !requestIdentityTargetId
    ? "none"
    : messageItemIndexes.has(requestIdentityTargetId)
      ? "ready"
      : "pending";
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
    let targetOffset: number | undefined;

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
      } else if (pendingLatestRequest || memory?.followLatest !== false) {
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
        targetOffset = memory?.anchorOffset;
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
      targetOffset,
    };
  }

  const initialLocation = initialLocationRef.current!;
  if (scrollControlRef.current.identity !== initialLocationIdentity) {
    scrollControlRef.current = {
      identity: initialLocationIdentity,
      generation: scrollControlRef.current.generation + 1,
      mode: searchActive ? "navigating" : "restoring",
    };
  }
  const initialTopMostItemIndex = initialLocation.location;
  const initialAlignToBottom = initialLocation.mode === "bottom";
  const storedMemory = currentScrollKey
    ? conversationScrollMemory.get(currentScrollKey)
    : undefined;
  const storedSnapshot = currentScrollKey
    ? conversationVirtuosoSnapshots.get(currentScrollKey)
    : undefined;
  const restoreStateFrom = !searchActive && !pendingLatestRequest && !requestedTargetId &&
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
    const expectedControl = scrollControlRef.current;
    bottomFrameRef.current = requestAnimationFrame(() => {
      bottomFrameRef.current = undefined;
      if (
        scrollControlRef.current.identity !== expectedControl.identity ||
        scrollControlRef.current.generation !== expectedControl.generation
      ) return;
      pinToBottom();
    });
  }, [currentScrollKey, pinToBottom, searchActive]);

  const settleBottomPosition = useCallback((
    identity: string,
    expectedVirtuosoKey: string,
    generation: number,
    onSettled?: () => void,
  ) => {
    if (!currentScrollKey || searchActive) return;
    if (bottomSettleFrameRef.current !== undefined) {
      cancelAnimationFrame(bottomSettleFrameRef.current);
    }
    let remainingFrames = 24;
    let stableFrames = 0;
    let previousSignature = "";
    const settle = () => {
      bottomSettleFrameRef.current = undefined;
      const element = messageListRef.current;
      if (
        !element ||
        initialLocationRef.current?.identity !== identity ||
        element.dataset.conversationVirtuosoKey !== expectedVirtuosoKey ||
        scrollControlRef.current.identity !== identity ||
        scrollControlRef.current.generation !== generation ||
        conversationScrollMemory.get(currentScrollKey)?.followLatest === false ||
        pointerActiveRef.current ||
        performance.now() <= userIntentUntilRef.current
      ) return;
      pinToBottom();
      const signature = `${element.scrollHeight}:${element.clientHeight}:${element.scrollTop.toFixed(1)}`;
      if (distanceFromBottom(element) <= BOTTOM_EPSILON_PX) {
        stableFrames = signature === previousSignature ? stableFrames + 1 : 1;
      } else {
        stableFrames = 0;
      }
      previousSignature = signature;
      remainingFrames -= 1;
      if (stableFrames >= 2 || remainingFrames <= 0) {
        onSettled?.();
      } else {
        bottomSettleFrameRef.current = requestAnimationFrame(settle);
      }
    };
    bottomSettleFrameRef.current = requestAnimationFrame(settle);
  }, [currentScrollKey, pinToBottom, searchActive]);

  const interruptControlledPositioning = useCallback((mode: "following" | "detached") => {
    if (bottomSettleFrameRef.current !== undefined) {
      cancelAnimationFrame(bottomSettleFrameRef.current);
      bottomSettleFrameRef.current = undefined;
    }
    if (positioningAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningAnchorFrameRef.current);
      positioningAnchorFrameRef.current = undefined;
    }
    if (positioningFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningFrameRef.current);
      positioningFrameRef.current = undefined;
    }
    revealTargetTokenRef.current = undefined;
    positioningIdentityRef.current = undefined;
    const current = scrollControlRef.current;
    scrollControlRef.current = {
      ...current,
      generation: current.generation + 1,
      mode,
    };
    if (current.identity === initialLocationIdentity) {
      positionedIdentityRef.current = initialLocationIdentity;
      setPositionedIdentity(initialLocationIdentity);
    }
  }, [initialLocationIdentity]);

  const stopFollowingLatest = useCallback(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    interruptControlledPositioning("detached");
    const current = conversationScrollMemory.get(currentScrollKey);
    writeMemory(
      currentScrollKey,
      element,
      false,
      current?.pendingNewCount ?? 0,
      true,
    );
  }, [currentScrollKey, interruptControlledPositioning, writeMemory]);

  const jumpToLatest = useCallback((
    behavior: "auto" | "smooth" = "smooth",
    converge = false,
  ) => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const needsConvergence = converge || distanceFromBottom(element) > BOTTOM_PROXIMITY_PX;
    interruptControlledPositioning("following");
    const generation = scrollControlRef.current.generation;
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
      if (needsConvergence) {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "end",
          behavior: "auto",
        });
      }
      pinToBottom();
      if (needsConvergence) {
        scheduleBottomPin();
        settleBottomPosition(initialLocationIdentity, virtuosoKey, generation);
      }
    }
  }, [
    currentScrollKey,
    initialLocationIdentity,
    interruptControlledPositioning,
    pinToBottom,
    scheduleBottomPin,
    settleBottomPosition,
    virtuosoKey,
    writeMemory,
  ]);

  const pinFollowingMessageMount = useCallback(() => {
    if (!currentScrollKey || searchActive) return;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest !== true) return;
    scheduleBottomPin();
  }, [currentScrollKey, scheduleBottomPin, searchActive]);

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

  const settleAnchorPosition = useCallback((
    element: HTMLElement,
    messageId: string,
    expectedOffset: number,
    identity: string,
    expectedVirtuosoKey: string,
    generation: number,
    onSettled?: () => void,
  ) => {
    if (positioningAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningAnchorFrameRef.current);
    }
    let remainingFrames = 18;
    let stableFrames = 0;
    let previousSignature = "";
    const settle = () => {
      positioningAnchorFrameRef.current = undefined;
      if (
        initialLocationRef.current?.identity !== identity ||
        element.dataset.conversationVirtuosoKey !== expectedVirtuosoKey ||
        scrollControlRef.current.identity !== identity ||
        scrollControlRef.current.generation !== generation
      ) return;
      restoreAnchor(element, messageId, expectedOffset);
      const anchor = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      const actualOffset = anchor
        ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
        : undefined;
      const signature = actualOffset === undefined
        ? "missing"
        : `${element.scrollHeight}:${element.scrollTop.toFixed(1)}:${actualOffset.toFixed(1)}`;
      if (actualOffset !== undefined && Math.abs(actualOffset - expectedOffset) <= 1) {
        stableFrames = signature === previousSignature ? stableFrames + 1 : 1;
      } else {
        stableFrames = 0;
      }
      previousSignature = signature;
      remainingFrames -= 1;
      if (stableFrames >= 2 || remainingFrames <= 0) {
        onSettled?.();
      } else {
        positioningAnchorFrameRef.current = requestAnimationFrame(settle);
      }
    };
    positioningAnchorFrameRef.current = requestAnimationFrame(settle);
  }, [restoreAnchor]);

  const settleContentAnchorPosition = useCallback((
    element: HTMLElement,
    messageId: string,
    expectedOffset: number,
    expectedVirtuosoKey: string,
    onSettled?: () => void,
  ) => {
    if (contentAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(contentAnchorFrameRef.current);
    }
    let remainingFrames = 18;
    const settle = () => {
      contentAnchorFrameRef.current = undefined;
      if (
        messageListRef.current !== element ||
        element.dataset.conversationVirtuosoKey !== expectedVirtuosoKey
      ) return;
      restoreAnchor(element, messageId, expectedOffset);
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        contentAnchorFrameRef.current = requestAnimationFrame(settle);
      } else onSettled?.();
    };
    settle();
  }, [restoreAnchor]);

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
    if (scrollControlRef.current.identity === initialLocationIdentity) {
      scrollControlRef.current.mode = "detached";
    }
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
    initialLocationIdentity,
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
    const identity = initialLocationIdentity;
    if (positioningFrameRef.current !== undefined) {
      if (positioningIdentityRef.current === identity) return;
      cancelAnimationFrame(positioningFrameRef.current);
      positioningFrameRef.current = undefined;
    }
    positioningIdentityRef.current = identity;
    const expectedVirtuosoKey = virtuosoKey;
    const generation = scrollControlRef.current.generation;
    const finishScrollControl = () => {
      const control = scrollControlRef.current;
      if (
        control.identity !== identity ||
        control.generation !== generation ||
        initialLocationRef.current?.identity !== identity
      ) return;
      const memory = conversationScrollMemory.get(currentScrollKey);
      control.mode = memory?.followLatest === false ? "detached" : "following";
    };
    let attempts = 0;
    const finishWhenRendered = () => {
      attempts += 1;
      positioningFrameRef.current = requestAnimationFrame(() => {
        positioningFrameRef.current = undefined;
        if (initialLocationRef.current?.identity !== identity) {
          positioningIdentityRef.current = undefined;
          return;
        }
        if (messageListRef.current?.dataset.conversationVirtuosoKey !== expectedVirtuosoKey) {
          if (attempts < 12) finishWhenRendered();
          else positioningIdentityRef.current = undefined;
          return;
        }
        if (revealTargetTokenRef.current) {
          finishWhenRendered();
          return;
        }
        const hasRenderedContent = visibleMessagesRef.current.length === 0 || Boolean(
          messageListRef.current?.querySelector("[data-message-id]"),
        );
        if (!hasRenderedContent && attempts < 12) {
          finishWhenRendered();
          return;
        }
        if (initialLocationRef.current.mode === "bottom") {
          pinToBottom();
          settleBottomPosition(identity, expectedVirtuosoKey, generation, finishScrollControl);
        } else if (
          initialLocationRef.current.mode === "anchor" &&
          initialLocationRef.current.targetMessageId &&
          initialLocationRef.current.targetOffset !== undefined &&
          messageListRef.current
        ) {
          settleAnchorPosition(
            messageListRef.current,
            initialLocationRef.current.targetMessageId,
            initialLocationRef.current.targetOffset,
            identity,
            expectedVirtuosoKey,
            generation,
            finishScrollControl,
          );
        } else finishScrollControl();
        positionedIdentityRef.current = identity;
        positioningIdentityRef.current = undefined;
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
    settleAnchorPosition,
    settleBottomPosition,
  ]);

  const revealTarget = useCallback((
    messageId: string,
    behavior: "auto" | "smooth",
    highlight: boolean,
    onSettled?: () => void,
  ) => {
    const element = messageListRef.current;
    const itemIndex = messageItemIndexesRef.current.get(messageId);
    if (!element || !currentScrollKey || itemIndex === undefined) return false;
    const expectedNavigationIdentity = navigationRequestIdentityRef.current;
    const revealToken = Symbol(messageId);
    userIntentUntilRef.current = 0;
    pointerActiveRef.current = false;
    stopFollowingLatest();
    const currentControl = scrollControlRef.current;
    const navigationGeneration = currentControl.generation + 1;
    scrollControlRef.current = {
      ...currentControl,
      generation: navigationGeneration,
      mode: "navigating",
    };
    revealTargetTokenRef.current = revealToken;
    const mounted = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    const centerMountedTarget = (target: HTMLElement) => {
      if (!target.closest(".media-album")) {
        target.scrollIntoView({ block: "center", behavior });
        return;
      }
      const listBounds = element.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      const offset = (targetBounds.top + targetBounds.bottom) / 2 -
        (listBounds.top + listBounds.bottom) / 2;
      if (behavior === "smooth") element.scrollBy({ top: offset, behavior });
      else element.scrollTop += offset;
    };
    const persistTargetPosition = () => {
      const current = conversationScrollMemory.get(currentScrollKey);
      writeMemory(
        currentScrollKey,
        element,
        false,
        current?.pendingNewCount ?? 0,
        true,
      );
    };
    const settleMountedTarget = () => {
      let remainingFrames = 18;
      const finish = () => {
        const invalid =
          messageListRef.current !== element ||
          navigationRequestIdentityRef.current !== expectedNavigationIdentity ||
          revealTargetTokenRef.current !== revealToken ||
          scrollControlRef.current.generation !== navigationGeneration ||
          pointerActiveRef.current ||
          performance.now() <= userIntentUntilRef.current;
        if (invalid) {
          if (revealTargetTokenRef.current === revealToken) {
            revealTargetTokenRef.current = undefined;
          }
          return;
        }
        const target = element.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        if (target) {
          const listBounds = element.getBoundingClientRect();
          const targetBounds = target.getBoundingClientRect();
          const offset = (targetBounds.top + targetBounds.bottom) / 2 -
            (listBounds.top + listBounds.bottom) / 2;
          if (Math.abs(offset) > 0.5) element.scrollTop += offset;
        }
        revealTargetTokenRef.current = undefined;
        persistTargetPosition();
        if (scrollControlRef.current.generation === navigationGeneration) {
          scrollControlRef.current.mode = "detached";
        }
        onSettled?.();
        completePositioning();
      };
      const settle = () => {
        const invalid =
          messageListRef.current !== element ||
          navigationRequestIdentityRef.current !== expectedNavigationIdentity ||
          revealTargetTokenRef.current !== revealToken ||
          scrollControlRef.current.generation !== navigationGeneration ||
          pointerActiveRef.current ||
          performance.now() <= userIntentUntilRef.current;
        if (invalid) {
          if (revealTargetTokenRef.current === revealToken) {
            revealTargetTokenRef.current = undefined;
          }
          return;
        }
        const latestItemIndex = messageItemIndexesRef.current.get(messageId);
        if (latestItemIndex !== undefined) {
          virtuosoRef.current?.scrollToIndex({
            index: latestItemIndex,
            align: "center",
            behavior: "auto",
          });
        }
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          requestAnimationFrame(settle);
        } else requestAnimationFrame(finish);
      };
      requestAnimationFrame(settle);
    };
    let settleScheduled = false;
    const scheduleTargetSettlement = () => {
      if (settleScheduled) return;
      settleScheduled = true;
      settleMountedTarget();
    };
    if (mounted) {
      centerMountedTarget(mounted);
      scheduleTargetSettlement();
    } else {
      virtuosoRef.current?.scrollToIndex({
        index: itemIndex,
        align: "center",
        behavior: "auto",
      });
      scheduleTargetSettlement();
    }
    requestAnimationFrame(() => {
      if (!settleScheduled && revealTargetTokenRef.current === revealToken) {
        revealTargetTokenRef.current = undefined;
        persistTargetPosition();
        if (scrollControlRef.current.generation === navigationGeneration) {
          scrollControlRef.current.mode = "detached";
        }
        completePositioning();
      }
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
  }, [
    completePositioning,
    currentScrollKey,
    navigationRequestIdentity,
    stopFollowingLatest,
    writeMemory,
  ]);

  const revealMessageStart = useCallback((messageId: string) => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    stopFollowingLatest();
    const current = conversationScrollMemory.get(currentScrollKey);
    conversationScrollMemory.set(currentScrollKey, {
      scrollTop: element.scrollTop,
      followLatest: false,
      lastKnownMessageId: current?.lastKnownMessageId,
      pendingNewCount: current?.pendingNewCount ?? 0,
      anchorMessageId: messageId,
      anchorOffset: 0,
    });
    settleContentAnchorPosition(element, messageId, 0, virtuosoKey, () => {
      const current = conversationScrollMemory.get(currentScrollKey);
      writeMemory(
        currentScrollKey,
        element,
        false,
        current?.pendingNewCount ?? 0,
        true,
      );
    });
  }, [
    currentScrollKey,
    settleContentAnchorPosition,
    stopFollowingLatest,
    virtuosoKey,
    writeMemory,
  ]);

  const revealAttentionMessage = useCallback(
    (messageId: string) => revealTarget(messageId, "auto", true),
    [revealTarget],
  );

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
      settleContentAnchorPosition(
        messageListElement,
        pendingHistory.anchorMessageId,
        pendingHistory.anchorOffset,
        virtuosoKey,
        () => {
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
        },
      );
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
    searchActive,
    settleContentAnchorPosition,
    updateNewMessageNotice,
    visibleMessages,
    virtuosoKey,
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
    jumpToLatest("auto", true);
  }, [jumpToLatest, matchingLatestRequest, messageListElement]);

  useLayoutEffect(() => {
    if (
      !matchingMessageRequest ||
      matchingMessageRequest.requestId <= handledMessageRequestRef.current ||
      !targetReady
    ) return;
    const requestId = matchingMessageRequest.requestId;
    revealTarget(matchingMessageRequest.messageId, "smooth", true, () => {
      handledMessageRequestRef.current = Math.max(
        handledMessageRequestRef.current,
        requestId,
      );
    });
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
    const requestId = matchingEntryRequest.requestId;
    revealTarget(matchingEntryRequest.serverMessageId, "auto", false, () => {
      handledEntryRequestRef.current = Math.max(
        handledEntryRequestRef.current,
        requestId,
      );
    });
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
    const controlIdentity = scrollControlRef.current.identity;
    const controlGeneration = scrollControlRef.current.generation;
    return () => {
      if (!element) return;
      if (
        scrollControlRef.current.identity !== controlIdentity ||
        scrollControlRef.current.generation !== controlGeneration
      ) return;
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
    if (bottomSettleFrameRef.current !== undefined) cancelAnimationFrame(bottomSettleFrameRef.current);
    if (anchorFrameRef.current !== undefined) cancelAnimationFrame(anchorFrameRef.current);
    if (contentAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(contentAnchorFrameRef.current);
    }
    if (positioningAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningAnchorFrameRef.current);
    }
    if (positioningFrameRef.current !== undefined) cancelAnimationFrame(positioningFrameRef.current);
    positioningIdentityRef.current = undefined;
    if (smoothScrollTimerRef.current) globalThis.clearTimeout(smoothScrollTimerRef.current);
    if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
  }, []);

  const followOutput = useCallback(() => {
    if (!currentScrollKey || searchActive) return false;
    const control = scrollControlRef.current;
    if (
      control.identity === initialLocationIdentity &&
      control.mode === "following" &&
      conversationScrollMemory.get(currentScrollKey)?.followLatest === true
    ) return "auto" as const;
    return false;
  }, [currentScrollKey, initialLocationIdentity, searchActive]);

  const onTotalListHeightChanged = useCallback(() => {
    if (!currentScrollKey || searchActive) return;
    const memory = conversationScrollMemory.get(currentScrollKey);
    const control = scrollControlRef.current;
    if (
      memory?.followLatest !== false &&
      (control.mode === "following" ||
        (control.mode === "restoring" && initialLocationRef.current?.mode === "bottom"))
    ) {
      scheduleBottomPin();
      return;
    }
    if (
      control.mode === "navigating" ||
      !memory?.anchorMessageId ||
      memory.anchorOffset === undefined ||
      revealTargetTokenRef.current !== undefined ||
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
  }, [currentScrollKey, restoreAnchor, scheduleBottomPin, searchActive]);

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

  useEffect(() => {
    if (!messageListElement) return;
    const preventBottomOverscroll = (event: WheelEvent) => {
      const rawDistance = messageListElement.scrollHeight -
        messageListElement.clientHeight - messageListElement.scrollTop;
      if (event.deltaY > 0 && rawDistance <= BOTTOM_EPSILON_PX) {
        event.preventDefault();
      }
    };
    messageListElement.addEventListener("wheel", preventBottomOverscroll, { passive: false });
    return () => messageListElement.removeEventListener("wheel", preventBottomOverscroll);
  }, [messageListElement]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const rawDistance = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (event.deltaY > 0 && rawDistance <= BOTTOM_EPSILON_PX) {
      event.preventDefault();
      if (currentScrollKey) {
        interruptControlledPositioning("following");
        const memory = conversationScrollMemory.get(currentScrollKey);
        if (memory?.followLatest !== true || memory.pendingNewCount !== 0) {
          writeMemory(currentScrollKey, element, true, 0, false);
        }
      }
      return;
    }
    if (event.deltaY !== 0) {
      if (contentAnchorFrameRef.current !== undefined) {
        cancelAnimationFrame(contentAnchorFrameRef.current);
        contentAnchorFrameRef.current = undefined;
      }
      userIntentUntilRef.current = performance.now() + 320;
      if (event.deltaY < 0) stopFollowingLatest();
      else {
        const followLatest = currentScrollKey
          ? conversationScrollMemory.get(currentScrollKey)?.followLatest !== false
          : false;
        interruptControlledPositioning(followLatest ? "following" : "detached");
      }
    }
  };

  const onPointerDown = () => {
    if (contentAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(contentAnchorFrameRef.current);
      contentAnchorFrameRef.current = undefined;
    }
    pointerActiveRef.current = true;
    userIntentUntilRef.current = performance.now() + 320;
    const followLatest = currentScrollKey
      ? conversationScrollMemory.get(currentScrollKey)?.followLatest !== false
      : false;
    interruptControlledPositioning(followLatest ? "following" : "detached");
  };

  const onPointerUp = () => {
    pointerActiveRef.current = false;
    userIntentUntilRef.current = performance.now() + 320;
  };

  const onPointerCancel = () => {
    pointerActiveRef.current = false;
    userIntentUntilRef.current = performance.now() + 320;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "End") {
      if (currentScrollKey) {
        interruptControlledPositioning("following");
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
      const followLatest = currentScrollKey
        ? conversationScrollMemory.get(currentScrollKey)?.followLatest !== false
        : false;
      interruptControlledPositioning(followLatest ? "following" : "detached");
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (!currentScrollKey || searchActive) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    const userInitiated = pointerActiveRef.current ||
      performance.now() <= userIntentUntilRef.current;
    if (!userInitiated) return;
    const atBottom = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
    let control = scrollControlRef.current;
    if (control.mode === "restoring" || control.mode === "navigating") {
      interruptControlledPositioning(atBottom ? "following" : "detached");
      control = scrollControlRef.current;
    }
    const followLatest = atBottom;
    control.mode = followLatest ? "following" : "detached";
    writeMemory(
      currentScrollKey,
      element,
      followLatest,
      current?.pendingNewCount ?? 0,
      !followLatest,
    );
    if (
      element.scrollTop <= HISTORY_TRIGGER_PX &&
      userInitiated &&
      hasOlderMessages &&
      !historyLoading
    ) {
      scheduleOlderLoad();
    }
  };

  const previousLayout = previousLayoutRef.current;
  const appendMountMessageId = currentScrollKey && !searchActive && lastVisibleMessageId &&
    previousLayout?.key === currentScrollKey &&
    previousLayout.lastId !== lastVisibleMessageId &&
    appendedMessageCount(visibleMessages, previousLayout.lastId) > 0 &&
    conversationScrollMemory.get(currentScrollKey)?.followLatest !== false
    ? lastVisibleMessageId
    : undefined;

  return {
    messageListRef,
    messageListElement,
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
    pinFollowingMessageMount,
    appendMountMessageId,
    revealAttentionMessage,
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
