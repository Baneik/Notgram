import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { IndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import type { Message } from "../telegram/types";
import { usePreferencesStore } from "../store/preferencesStore";
import { motionScrollBehavior } from "../utils/motionPreference";
import { conversationJumpMotion } from "../utils/conversationJumpMotion";
import { motionDuration } from "../utils/motionTokens";
import {
  captureConversationJumpSnapshot,
  removeConversationJumpSnapshot,
  type ConversationJumpSnapshot,
} from "../utils/conversationJumpSnapshot";
import {
  appendedMessageCount,
  conversationLayouts,
  conversationScrollMemory,
  conversationVirtuosoSnapshots,
  distanceFromBottom,
  registerConversationScrollStateCapture,
  scrollMemoryKey,
  visibleAnchor,
  type ConversationLayoutSnapshot,
  type ConversationScrollMemory,
  type InitialLocation,
  type PendingHistoryRestore,
} from "./conversationScrollState";
export {
  captureActiveConversationScrollState,
  hasConversationScrollMemory,
} from "./conversationScrollState";
import {
  logPerformance,
  markConversationSwitch,
  markHistoryInteraction,
} from "../utils/performanceMonitor";
import {
  popAvailableConversationJumpAnchor,
  pushConversationJumpAnchor,
  type ConversationJumpAnchor,
} from "./conversationJumpHistory";
import {
  advanceBottomReconcile,
  latestScrollMode,
  latestScrollProgress,
  startBottomReconcile,
  type BottomReconcileState,
} from "./conversationBottomState";

const BOTTOM_PROXIMITY_PX = 32;
// Includes the 12px end sentinel so downward input cannot bounce between the
// browser's raw scroll maximum and Virtuoso's visual end alignment.
const BOTTOM_WHEEL_GUARD_PX = 13;
const HISTORY_TRIGGER_PX = 64;
const BOTTOM_RECONCILE_MAX_FRAMES = 8;
const BOTTOM_RECONCILE_STABLE_FRAMES = 2;
const BOTTOM_MOTION_RECONCILE_MAX_FRAMES = 36;
const BOTTOM_MOTION_RECONCILE_STABLE_FRAMES = BOTTOM_MOTION_RECONCILE_MAX_FRAMES + 1;
const ANCHOR_RECONCILE_STABLE_FRAMES = 6;
const CONTENT_ANCHOR_RECONCILE_MAX_FRAMES = 18;
const CONTENT_ANCHOR_RECONCILE_STABLE_FRAMES = 6;
const NAVIGATION_RECONCILE_STABLE_FRAMES = 6;

const bottomScrollTop = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight);

type ScrollControlMode = "following" | "detached" | "restoring" | "navigating";
type UserScrollDirection = "up" | "down";

export interface ConversationUserScroll {
  element: HTMLDivElement;
  direction: UserScrollDirection;
  atBottom: boolean;
}

interface ScrollControlState {
  identity: string;
  generation: number;
  mode: ScrollControlMode;
}

interface BottomPinRequest {
  identity: string;
  generation: number;
  mountCommitted: boolean;
  continuous: boolean;
  stableFrameCount: number;
  state: BottomReconcileState;
  onSettled: Set<() => void>;
}

interface JumpToLatestOptions {
  onSettled?: () => void;
  publishPositioned?: boolean;
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
  behavior?: "auto" | "smooth";
  highlight?: boolean;
}

export type ConversationScrollRequest =
  | {
      kind: "entry";
      chatId: string;
      serverMessageId?: string;
      requestId: number;
      performanceTraceId?: number;
    }
  | {
      kind: "latest";
      chatId: string;
      requestId: number;
      performanceTraceId?: number;
    }
  | (MessageConversationScrollRequest & { kind: "message" });

export type ConversationScrollRequestInput = ConversationScrollRequest extends infer Request
  ? Request extends ConversationScrollRequest
    ? Omit<Request, "requestId">
    : never
  : never;

interface ConversationScrollOptions {
  scope: string;
  chatId?: string;
  request?: ConversationScrollRequest;
  visibleMessages: Message[];
  messageItemIndexes: ReadonlyMap<string, number>;
  virtualItemCount: number;
  search: string;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  messageCount: number;
  onLoadOlder: () => Promise<void>;
  onUserScroll?: (scroll: ConversationUserScroll) => void;
}

export const useConversationScroll = ({
  scope,
  chatId,
  request,
  visibleMessages,
  messageItemIndexes,
  virtualItemCount,
  search,
  historyLoading,
  hasOlderMessages,
  messageCount,
  onLoadOlder,
  onUserScroll,
}: ConversationScrollOptions) => {
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const messageListRef = useRef<HTMLDivElement>(null);
  const virtuosoKeyRef = useRef("");
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
  const bottomPinRequestRef = useRef<BottomPinRequest | undefined>(undefined);
  const anchorFrameRef = useRef<number | undefined>(undefined);
  const contentAnchorFrameRef = useRef<number | undefined>(undefined);
  const positioningAnchorFrameRef = useRef<number | undefined>(undefined);
  const positioningFrameRef = useRef<number | undefined>(undefined);
  const positioningIdentityRef = useRef<string | undefined>(undefined);
  const smoothScrollFrameRef = useRef<number | undefined>(undefined);
  const smoothScrollUntilRef = useRef(0);
  const anchorCorrectionUntilRef = useRef(0);
  const userIntentUntilRef = useRef(0);
  const trustedUserIntentUntilRef = useRef(0);
  const userScrollDirectionRef = useRef<UserScrollDirection | undefined>(undefined);
  const userScrollTopRef = useRef<number | undefined>(undefined);
  const pointerActiveRef = useRef(false);
  const pointerScrolledRef = useRef(false);
  const resumeBottomPinOnReleaseRef = useRef(false);
  const trustedPointerActiveRef = useRef(false);
  // Chromium keeps middle-button autoscroll active after pointerup.
  const middleAutoScrollRef = useRef(false);
  const trustedMiddleAutoScrollRef = useRef(false);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const olderLoadArmedRef = useRef(false);
  const handledEntryRequestRef = useRef(0);
  const handledLatestRequestRef = useRef(0);
  const handledMessageRequestRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const revealTargetTokenRef = useRef<symbol | undefined>(undefined);
  const jumpSnapshotRef = useRef<{
    token: symbol;
    snapshot: ConversationJumpSnapshot;
  } | undefined>(undefined);
  const navigationRequestIdentityRef = useRef("");
  const initialLocationRef = useRef<InitialLocation | undefined>(undefined);
  const positionedIdentityRef = useRef<string | undefined>(undefined);
  const scrollControlRef = useRef<ScrollControlState>({
    identity: "",
    generation: 0,
    mode: "restoring",
  });
  const jumpHistoryRef = useRef(new Map<string, ConversationJumpAnchor[]>());
  const preparedJumpRef = useRef<{ key: string; messageId: string } | undefined>(undefined);

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
  const [jumpHistoryState, setJumpHistoryState] = useState<{
    key: string;
    count: number;
  }>();

  const currentScrollKey = scrollMemoryKey(scope, chatId);
  const firstVisibleMessageId = visibleMessages[0]?.id;
  const lastVisibleMessageId = visibleMessages.at(-1)?.id;
  const matchingRequest = request?.chatId === chatId ? request : undefined;
  const matchingEntryRequest = matchingRequest?.kind === "entry" ? matchingRequest : undefined;
  const matchingLatestRequest = matchingRequest?.kind === "latest" ? matchingRequest : undefined;
  const matchingMessageRequest = matchingRequest?.kind === "message" ? matchingRequest : undefined;
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

  useEffect(() => {
    jumpHistoryRef.current.clear();
    preparedJumpRef.current = undefined;
    userIntentUntilRef.current = 0;
    userScrollDirectionRef.current = undefined;
    pointerActiveRef.current = false;
    pointerScrolledRef.current = false;
    resumeBottomPinOnReleaseRef.current = false;
    trustedPointerActiveRef.current = false;
    middleAutoScrollRef.current = false;
    trustedMiddleAutoScrollRef.current = false;
    anchorCorrectionUntilRef.current = 0;
    olderLoadArmedRef.current = false;
    setJumpHistoryState(currentScrollKey ? { key: currentScrollKey, count: 0 } : undefined);
  }, [currentScrollKey]);
  const dataPhase = virtualItemCount > 0 ? "ready" : "empty";
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
    dataPhase,
    targetPhase,
  ].join(":");
  const virtuosoKey = `${currentScrollKey ?? scope}:${searchActive ? "search" : "conversation"}`;
  virtuosoKeyRef.current = virtuosoKey;
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
      storedMemory && storedSnapshot &&
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

  const publishJumpHistory = useCallback((key: string, history: ConversationJumpAnchor[]) => {
    if (history.length > 0) jumpHistoryRef.current.set(key, history);
    else jumpHistoryRef.current.delete(key);
    setJumpHistoryState({ key, count: history.length });
  }, []);

  const setMessageListRef = useCallback((ref: HTMLElement | Window | null) => {
    const element = ref instanceof HTMLDivElement ? ref : null;
    if (element) element.dataset.conversationVirtuosoKey = virtuosoKeyRef.current;
    messageListRef.current = element;
    setMessageListElement((current) => current === element ? current : element);
  }, []);

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
    const target = bottomScrollTop(element);
    if (Math.abs(element.scrollTop - target) > 0.5) element.scrollTop = target;
  }, [currentScrollKey, searchActive]);

  const scheduleBottomPin = useCallback((onSettled?: () => void, continuous = false) => {
    if (!currentScrollKey || searchActive) return;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest === false) return;
    if (performance.now() < smoothScrollUntilRef.current) return;
    if (middleAutoScrollRef.current) return;
    if (pointerActiveRef.current) {
      resumeBottomPinOnReleaseRef.current = true;
      return;
    }
    if (
      performance.now() <= userIntentUntilRef.current &&
      userScrollDirectionRef.current === "up"
    ) return;
    const control = scrollControlRef.current;
    const pendingRequest = bottomPinRequestRef.current;
    if (
      pendingRequest?.identity === control.identity &&
      pendingRequest.generation === control.generation
    ) {
      const element = messageListRef.current;
      if (
        !pendingRequest.mountCommitted &&
        element?.querySelector("[data-message-id]")
      ) {
        pendingRequest.mountCommitted = true;
        pinToBottom();
      }
      if (continuous && !pendingRequest.continuous) {
        pendingRequest.continuous = true;
        pendingRequest.stableFrameCount = BOTTOM_MOTION_RECONCILE_STABLE_FRAMES;
        pendingRequest.state = startBottomReconcile(BOTTOM_MOTION_RECONCILE_MAX_FRAMES);
      }
      if (onSettled) pendingRequest.onSettled.add(onSettled);
    } else {
      if (bottomFrameRef.current !== undefined) {
        cancelAnimationFrame(bottomFrameRef.current);
        bottomFrameRef.current = undefined;
      }
      bottomPinRequestRef.current = {
        identity: control.identity,
        generation: control.generation,
        mountCommitted: false,
        continuous,
        stableFrameCount: continuous
          ? BOTTOM_MOTION_RECONCILE_STABLE_FRAMES
          : BOTTOM_RECONCILE_STABLE_FRAMES,
        state: startBottomReconcile(
          continuous ? BOTTOM_MOTION_RECONCILE_MAX_FRAMES : BOTTOM_RECONCILE_MAX_FRAMES,
        ),
        onSettled: new Set(onSettled ? [onSettled] : []),
      };
    }
    if (bottomFrameRef.current !== undefined) return;
    const reconcile = () => {
      bottomFrameRef.current = undefined;
      const request = bottomPinRequestRef.current;
      const element = messageListRef.current;
      if (
        !request ||
        !element ||
        scrollControlRef.current.identity !== request.identity ||
        scrollControlRef.current.generation !== request.generation ||
        conversationScrollMemory.get(currentScrollKey)?.followLatest === false ||
        pointerActiveRef.current ||
        middleAutoScrollRef.current ||
        (performance.now() <= userIntentUntilRef.current &&
          userScrollDirectionRef.current === "up")
      ) {
        bottomPinRequestRef.current = undefined;
        return;
      }
      if (!request.mountCommitted && element.querySelector("[data-message-id]")) {
        request.mountCommitted = true;
        pinToBottom();
      }
      if (request.continuous) pinToBottom();
      const signature = [
        element.scrollHeight,
        element.clientHeight,
        element.scrollTop.toFixed(1),
      ].join(":");
      const step = advanceBottomReconcile(
        request.state,
        signature,
        request.stableFrameCount,
      );
      request.state = step.state;
      if (step.settled) {
        // Virtuoso has finished applying its own measurement correction. One
        // final write is enough to align the end sentinel with the viewport.
        pinToBottom();
        bottomPinRequestRef.current = undefined;
        request.onSettled.forEach((callback) => callback());
      } else {
        bottomFrameRef.current = requestAnimationFrame(reconcile);
      }
    };
    bottomFrameRef.current = requestAnimationFrame(reconcile);
  }, [currentScrollKey, pinToBottom, searchActive]);

  const settleBottomPosition = useCallback((
    identity: string,
    expectedVirtuosoKey: string,
    generation: number,
    onSettled?: () => void,
  ) => {
    if (!currentScrollKey || searchActive) return;
    const element = messageListRef.current;
    if (
      !element ||
      initialLocationRef.current?.identity !== identity ||
      element.dataset.conversationVirtuosoKey !== expectedVirtuosoKey ||
      scrollControlRef.current.identity !== identity ||
      scrollControlRef.current.generation !== generation
    ) return;
    scheduleBottomPin(onSettled);
  }, [currentScrollKey, scheduleBottomPin, searchActive]);

  useLayoutEffect(() => {
    if (!messageListElement) return;
    const viewport = messageListElement.closest<HTMLElement>(".message-list-shell") ??
      messageListElement;
    let previousHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = viewport.clientHeight;
      if (Math.abs(nextHeight - previousHeight) <= 0.5) return;
      previousHeight = nextHeight;
      const control = scrollControlRef.current;
      const followsLatest = control.mode === "following" ||
        (control.mode === "restoring" && initialLocationRef.current?.mode === "bottom");
      const memory = currentScrollKey
        ? conversationScrollMemory.get(currentScrollKey)
        : undefined;
      if (memory?.followLatest === false || !followsLatest) return;
      scheduleBottomPin();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [currentScrollKey, messageListElement, scheduleBottomPin]);

  const clearJumpTransition = useCallback((token?: symbol) => {
    const active = jumpSnapshotRef.current;
    if (token && active?.token !== token) return;
    if (active) removeConversationJumpSnapshot(active.snapshot);
    jumpSnapshotRef.current = undefined;
    messageListRef.current?.classList.remove("is-jump-transitioning");
  }, []);

  const interruptControlledPositioning = useCallback((
    mode: "following" | "detached",
    publishPositioned = true,
  ) => {
    if (bottomFrameRef.current !== undefined) {
      cancelAnimationFrame(bottomFrameRef.current);
      bottomFrameRef.current = undefined;
    }
    bottomPinRequestRef.current = undefined;
    if (smoothScrollFrameRef.current !== undefined) {
      cancelAnimationFrame(smoothScrollFrameRef.current);
      smoothScrollFrameRef.current = undefined;
    }
    smoothScrollUntilRef.current = 0;
    if (positioningAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningAnchorFrameRef.current);
      positioningAnchorFrameRef.current = undefined;
    }
    if (positioningFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningFrameRef.current);
      positioningFrameRef.current = undefined;
    }
    if (contentAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(contentAnchorFrameRef.current);
      contentAnchorFrameRef.current = undefined;
    }
    revealTargetTokenRef.current = undefined;
    clearJumpTransition();
    positioningIdentityRef.current = undefined;
    const current = scrollControlRef.current;
    scrollControlRef.current = {
      ...current,
      generation: current.generation + 1,
      mode,
    };
    if (publishPositioned && current.identity === initialLocationIdentity) {
      positionedIdentityRef.current = initialLocationIdentity;
      setPositionedIdentity(initialLocationIdentity);
    }
  }, [clearJumpTransition, initialLocationIdentity]);

  const adoptUserScrollMode = useCallback((mode: "following" | "detached") => {
    const current = scrollControlRef.current;
    if (current.identity === initialLocationIdentity && current.mode === mode) return;
    interruptControlledPositioning(mode);
  }, [initialLocationIdentity, interruptControlledPositioning]);

  const stopFollowingLatest = useCallback((preservePositioning = false) => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    interruptControlledPositioning("detached", !preservePositioning);
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
    options?: JumpToLatestOptions,
  ) => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const resolvedBehavior = motionScrollBehavior(behavior, {
      reduceMotion,
      systemReduceMotion: false,
    });
    const needsConvergence = converge || distanceFromBottom(element) > BOTTOM_PROXIMITY_PX;
    interruptControlledPositioning("following", options?.publishPositioned !== false);
    const generation = scrollControlRef.current.generation;
    userIntentUntilRef.current = 0;
    userScrollDirectionRef.current = undefined;
    pointerActiveRef.current = false;
    preparedJumpRef.current = undefined;
    publishJumpHistory(currentScrollKey, []);
    writeMemory(currentScrollKey, element, true, 0, false);
    if (smoothScrollFrameRef.current !== undefined) {
      cancelAnimationFrame(smoothScrollFrameRef.current);
      smoothScrollFrameRef.current = undefined;
    }
    if (resolvedBehavior === "smooth") {
      // Keep bottom movement under one writer. Virtuoso's smooth animation and
      // the measurement callback otherwise race and produce the 30-50px rebound.
      smoothScrollUntilRef.current = Number.POSITIVE_INFINITY;
      const valid = () => messageListRef.current === element &&
        scrollControlRef.current.generation === generation &&
        conversationScrollMemory.get(currentScrollKey)?.followLatest === true;
      const finishSmoothScroll = () => {
        smoothScrollFrameRef.current = undefined;
        if (!valid()) return;
        smoothScrollUntilRef.current = 0;
        pinToBottom();
        scheduleBottomPin(options?.onSettled, true);
      };
      const animateSegment = (
        duration: number,
        target: () => number,
        onFinished: () => void,
      ) => {
        const startedAt = performance.now();
        const startTop = element.scrollTop;
        const animate = (now: number) => {
          smoothScrollFrameRef.current = undefined;
          if (!valid()) return;
          const progress = latestScrollProgress((now - startedAt) / duration);
          element.scrollTop = startTop + (target() - startTop) * progress;
          if (progress < 1) smoothScrollFrameRef.current = requestAnimationFrame(animate);
          else onFinished();
        };
        smoothScrollFrameRef.current = requestAnimationFrame(animate);
      };
      const bottomTarget = () => bottomScrollTop(element);
      const distance = distanceFromBottom(element);
      if (latestScrollMode(distance, element.clientHeight) === "near") {
        animateSegment(motionDuration.standard + motionDuration.fast, bottomTarget, finishSmoothScroll);
      } else {
        const approachTop = Math.min(
          bottomTarget(),
          element.scrollTop + Math.max(120, element.clientHeight * 0.35),
        );
        animateSegment(motionDuration.fast, () => approachTop, () => {
          if (!valid()) return;
          virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
          smoothScrollFrameRef.current = requestAnimationFrame(() => {
            if (!valid()) return;
            const settleDistance = Math.min(48, Math.max(24, element.clientHeight * 0.05));
            element.scrollTop = Math.max(0, bottomTarget() - settleDistance);
            animateSegment(motionDuration.slow, bottomTarget, finishSmoothScroll);
          });
        });
      }
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
      if (needsConvergence || options?.onSettled) {
        settleBottomPosition(
          initialLocationIdentity,
          virtuosoKey,
          generation,
          options?.onSettled,
        );
      }
    }
  }, [
    currentScrollKey,
    initialLocationIdentity,
    interruptControlledPositioning,
    pinToBottom,
    publishJumpHistory,
    reduceMotion,
    scheduleBottomPin,
    settleBottomPosition,
    virtuosoKey,
    writeMemory,
  ]);

  const pinFollowingMessageMount = useCallback((onSettled?: () => void) => {
    if (!currentScrollKey || searchActive) return false;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest !== true) return false;
    // The mounted row is already measurable, so expose it after the first pin.
    // The coordinator continues reconciling later Virtuoso measurements.
    pinToBottom();
    scheduleBottomPin();
    onSettled?.();
    return true;
  }, [currentScrollKey, pinToBottom, scheduleBottomPin, searchActive]);

  const restoreAnchor = useCallback((
    element: HTMLElement,
    messageId: string,
    expectedOffset: number,
  ) => {
    const markControlledCorrection = () => {
      anchorCorrectionUntilRef.current = performance.now() + 120;
    };
    const correctMountedAnchor = () => {
      const anchor = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!anchor) return false;
      const actualOffset = anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      const correction = actualOffset - expectedOffset;
      if (Math.abs(correction) > 0.5) {
        markControlledCorrection();
        element.scrollTop += correction;
      }
      return true;
    };
    if (correctMountedAnchor()) return;
    const itemIndex = messageItemIndexesRef.current.get(messageId);
    if (itemIndex === undefined) return;
    markControlledCorrection();
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
      if (stableFrames >= ANCHOR_RECONCILE_STABLE_FRAMES || remainingFrames <= 0) {
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
    let remainingFrames = CONTENT_ANCHOR_RECONCILE_MAX_FRAMES;
    let stableFrames = 0;
    let previousSignature = "";
    const settle = () => {
      contentAnchorFrameRef.current = undefined;
      if (
        messageListRef.current !== element ||
        element.dataset.conversationVirtuosoKey !== expectedVirtuosoKey
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
      if (stableFrames < CONTENT_ANCHOR_RECONCILE_STABLE_FRAMES && remainingFrames > 0) {
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
    ) return false;
    const anchor = visibleAnchor(element);
    if (!anchor?.messageId) return false;
    olderLoadArmedRef.current = false;
    userIntentUntilRef.current = 0;
    trustedUserIntentUntilRef.current = 0;
    userScrollDirectionRef.current = undefined;
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
    return true;
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
    if (!olderLoadArmedRef.current || historyLoadFrameRef.current !== undefined) return;
    let remainingFrames = 4;
    const attempt = () => {
      historyLoadFrameRef.current = requestAnimationFrame(() => {
        historyLoadFrameRef.current = undefined;
        if (!olderLoadArmedRef.current || loadOlder()) return;
        const element = messageListRef.current;
        remainingFrames -= 1;
        if (
          remainingFrames > 0 &&
          element &&
          element.scrollTop <= HISTORY_TRIGGER_PX
        ) attempt();
      });
    };
    attempt();
  }, [loadOlder]);

  const completePositioning = useCallback((bottomAlreadySettled = false) => {
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
    const finishPositioning = () => {
      const control = scrollControlRef.current;
      if (
        control.identity !== identity ||
        control.generation !== generation ||
        initialLocationRef.current?.identity !== identity ||
        positionedIdentityRef.current === identity
      ) return;
      const memory = conversationScrollMemory.get(currentScrollKey);
      control.mode = memory?.followLatest === false ? "detached" : "following";
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
          if (bottomAlreadySettled) finishPositioning();
          else settleBottomPosition(identity, expectedVirtuosoKey, generation, finishPositioning);
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
            finishPositioning,
          );
        } else finishPositioning();
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

  const captureJumpAnchor = useCallback((destinationMessageId: string) => {
    const element = messageListRef.current;
    if (
      !element || !currentScrollKey ||
      element.dataset.conversationVirtuosoKey !== virtuosoKey
    ) return;
    const bounds = element.getBoundingClientRect();
    let activeNavigationAnchor: HTMLElement | undefined;
    if (highlightedMessage?.key === currentScrollKey) {
      const activeTarget = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(highlightedMessage.messageId)}"]`,
      );
      if (activeTarget) {
        const targetBounds = activeTarget.getBoundingClientRect();
        const targetOffset = (targetBounds.top + targetBounds.bottom) / 2 -
          (bounds.top + bounds.bottom) / 2;
        if (Math.abs(targetOffset) > 0.5) element.scrollTop += targetOffset;
        activeNavigationAnchor = activeTarget;
      }
    }
    const destination = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(destinationMessageId)}"]`,
    );
    if (destination) {
      const destinationBounds = destination.getBoundingClientRect();
      if (
        destinationBounds.bottom > bounds.top + 1 &&
        destinationBounds.top < bounds.bottom - 1
      ) return;
    }
    const anchor = activeNavigationAnchor ??
      [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((row) => {
          const rowBounds = row.getBoundingClientRect();
          return rowBounds.bottom > bounds.top + 1 && rowBounds.top < bounds.bottom - 1;
        });
    if (!anchor?.dataset.messageId) return;
    publishJumpHistory(
      currentScrollKey,
      pushConversationJumpAnchor(
        jumpHistoryRef.current.get(currentScrollKey) ?? [],
        {
          messageId: anchor.dataset.messageId,
          offset: anchor.getBoundingClientRect().top - bounds.top,
          followLatest: distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX,
        },
      ),
    );
    preparedJumpRef.current = { key: currentScrollKey, messageId: destinationMessageId };
  }, [currentScrollKey, highlightedMessage, publishJumpHistory, virtuosoKey]);

  const revealTarget = useCallback((
    messageId: string,
    behavior: "auto" | "smooth",
    highlight: boolean,
    onSettled?: () => void,
  ) => {
    const element = messageListRef.current;
    const itemIndex = messageItemIndexesRef.current.get(messageId);
    if (!element || !currentScrollKey || itemIndex === undefined) return false;
    const resolvedBehavior = motionScrollBehavior(behavior, {
      reduceMotion,
      systemReduceMotion: false,
    });
    const expectedNavigationIdentity = navigationRequestIdentityRef.current;
    const revealToken = Symbol(messageId);
    userIntentUntilRef.current = 0;
    pointerActiveRef.current = false;
    stopFollowingLatest(true);
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
    const visibleAnchorRow = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => {
        const listBounds = element.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        return rowBounds.bottom > listBounds.top + 1 && rowBounds.top < listBounds.bottom - 1;
      });
    const visibleAnchorIndex = visibleAnchorRow?.dataset.messageId
      ? messageItemIndexesRef.current.get(visibleAnchorRow.dataset.messageId)
      : undefined;
    const centerMountedTarget = (target: HTMLElement) => {
      const listBounds = element.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      const offset = (targetBounds.top + targetBounds.bottom) / 2 -
        (listBounds.top + listBounds.bottom) / 2;
      if (Math.abs(offset) <= 0.5) return;
      element.scrollBy({ top: offset, behavior: resolvedBehavior });
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
    const publishHighlight = () => {
      if (!highlight) return;
      setHighlightedMessage({ key: currentScrollKey, messageId });
      if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = globalThis.setTimeout(() => {
        highlightTimerRef.current = undefined;
        setHighlightedMessage((current) =>
          current?.key === currentScrollKey && current.messageId === messageId
            ? undefined
            : current);
      }, 1_600);
    };
    let revealTransitionReady: ((onReady: () => void) => void) | undefined;
    const settleMountedTarget = () => {
      let remainingFrames = resolvedBehavior === "smooth" ? 36 : 18;
      let stableFrames = 0;
      let previousScrollTop = element.scrollTop;
      let requestedMissingTarget = false;
      const finish = () => {
        const invalid =
          messageListRef.current !== element ||
          navigationRequestIdentityRef.current !== expectedNavigationIdentity ||
          revealTargetTokenRef.current !== revealToken ||
          scrollControlRef.current.generation !== navigationGeneration ||
          pointerActiveRef.current ||
          performance.now() <= userIntentUntilRef.current;
        if (invalid) {
          clearJumpTransition(revealToken);
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
        const completeReveal = () => {
          if (
            messageListRef.current !== element ||
            navigationRequestIdentityRef.current !== expectedNavigationIdentity ||
            revealTargetTokenRef.current !== revealToken ||
            scrollControlRef.current.generation !== navigationGeneration
          ) return;
          publishHighlight();
          revealTargetTokenRef.current = undefined;
          persistTargetPosition();
          scrollControlRef.current.mode = "detached";
          onSettled?.();
          completePositioning();
        };
        if (revealTransitionReady) revealTransitionReady(completeReveal);
        else completeReveal();
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
          clearJumpTransition(revealToken);
          if (revealTargetTokenRef.current === revealToken) {
            revealTargetTokenRef.current = undefined;
          }
          return;
        }
        const target = element.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        if (!target && !requestedMissingTarget) {
          const latestItemIndex = messageItemIndexesRef.current.get(messageId);
          requestedMissingTarget = true;
          virtuosoRef.current?.scrollToIndex({
            index: latestItemIndex ?? itemIndex,
            align: "center",
            behavior: "auto",
          });
        }
        const currentScrollTop = element.scrollTop;
        const scrollStable = Math.abs(currentScrollTop - previousScrollTop) <= 0.5;
        if (target && scrollStable) {
          const listBounds = element.getBoundingClientRect();
          const targetBounds = target.getBoundingClientRect();
          const targetOffset = (targetBounds.top + targetBounds.bottom) / 2 -
            (listBounds.top + listBounds.bottom) / 2;
          if (Math.abs(targetOffset) > 0.5) {
            element.scrollTop += targetOffset;
            stableFrames = 0;
          } else stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        previousScrollTop = currentScrollTop;
        remainingFrames -= 1;
        if (stableFrames < NAVIGATION_RECONCILE_STABLE_FRAMES && remainingFrames > 0) {
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
    const mountedTargetIsVisible = mounted ? (() => {
      const listBounds = element.getBoundingClientRect();
      const targetBounds = mounted.getBoundingClientRect();
      return targetBounds.bottom > listBounds.top + 1 && targetBounds.top < listBounds.bottom - 1;
    })() : false;
    if (mountedTargetIsVisible && mounted) {
      centerMountedTarget(mounted);
      scheduleTargetSettlement();
    } else if (resolvedBehavior === "smooth" && typeof element.animate === "function") {
      settleScheduled = true;
      const motion = conversationJumpMotion(
        visibleAnchorIndex !== undefined && itemIndex < visibleAnchorIndex ? "older" : "newer",
      );
      const snapshot = captureConversationJumpSnapshot(element);
      if (!snapshot) {
        virtuosoRef.current?.scrollToIndex({
          index: itemIndex,
          align: "center",
          behavior: "auto",
        });
        settleMountedTarget();
      } else {
        clearJumpTransition();
        jumpSnapshotRef.current = { token: revealToken, snapshot };
        element.classList.add("is-jump-transitioning");
        revealTransitionReady = (onReady) => {
          if (jumpSnapshotRef.current?.token !== revealToken) return;
          clearJumpTransition(revealToken);
          const nextContent = element.querySelector<HTMLElement>(".message-list-content") ?? element;
          const enter = nextContent.animate(motion.enter, motion.enterTiming);
          void enter.finished.catch(() => undefined).then(onReady);
        };
        const exit = snapshot.content.animate(motion.exit, motion.exitTiming);
        void exit.finished.catch(() => undefined).then(() => {
          const invalid =
            messageListRef.current !== element ||
            navigationRequestIdentityRef.current !== expectedNavigationIdentity ||
            revealTargetTokenRef.current !== revealToken ||
            scrollControlRef.current.generation !== navigationGeneration;
          if (invalid) {
            exit.cancel();
            clearJumpTransition(revealToken);
            return;
          }
          virtuosoRef.current?.scrollToIndex({
            index: itemIndex,
            align: "center",
            behavior: "auto",
          });
          requestAnimationFrame(() => {
            exit.cancel();
            settleMountedTarget();
          });
        });
      }
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
        publishHighlight();
        revealTargetTokenRef.current = undefined;
        persistTargetPosition();
        if (scrollControlRef.current.generation === navigationGeneration) {
          scrollControlRef.current.mode = "detached";
        }
        completePositioning();
      }
    });
    return true;
  }, [
    completePositioning,
    clearJumpTransition,
    currentScrollKey,
    navigationRequestIdentity,
    reduceMotion,
    stopFollowingLatest,
    writeMemory,
  ]);

  const revealAttentionMessage = useCallback((messageId: string) => {
    captureJumpAnchor(messageId);
    return revealTarget(messageId, "smooth", true);
  }, [captureJumpAnchor, revealTarget]);

  const returnFromJump = useCallback(() => {
    const element = messageListRef.current;
    if (!currentScrollKey || !element) return false;
    const result = popAvailableConversationJumpAnchor(
      jumpHistoryRef.current.get(currentScrollKey) ?? [],
      new Set(messageItemIndexesRef.current.keys()),
    );
    publishJumpHistory(currentScrollKey, result.history);
    if (!result.anchor) return false;
    if (result.anchor.followLatest) {
      // Returning to a bottom-origin jump must settle in one synchronous
      // viewport commit. A second smooth animation races the virtual list's
      // measurement correction and briefly rebounds above the bottom.
      jumpToLatest("auto", true);
      return true;
    }
    stopFollowingLatest();
    const current = conversationScrollMemory.get(currentScrollKey);
    conversationScrollMemory.set(currentScrollKey, {
      scrollTop: element.scrollTop,
      followLatest: false,
      lastKnownMessageId: current?.lastKnownMessageId,
      pendingNewCount: current?.pendingNewCount ?? 0,
      anchorMessageId: result.anchor.messageId,
      anchorOffset: result.anchor.offset,
    });
    settleContentAnchorPosition(
      element,
      result.anchor.messageId,
      result.anchor.offset,
      virtuosoKey,
      () => {
        const current = conversationScrollMemory.get(currentScrollKey);
        writeMemory(
          currentScrollKey,
          element,
          false,
          current?.pendingNewCount ?? 0,
          true,
        );
      },
    );
    return true;
  }, [
    currentScrollKey,
    jumpToLatest,
    publishJumpHistory,
    settleContentAnchorPosition,
    stopFollowingLatest,
    virtuosoKey,
    writeMemory,
  ]);

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
      !messageListElement ||
      messageListElement !== messageListRef.current ||
      messageListElement.dataset.conversationVirtuosoKey !== virtuosoKey
    ) return;
    handledLatestRequestRef.current = matchingLatestRequest.requestId;
    jumpToLatest("auto", true, {
      publishPositioned: false,
      onSettled: () => completePositioning(true),
    });
  }, [completePositioning, jumpToLatest, matchingLatestRequest, messageListElement, virtuosoKey]);

  useLayoutEffect(() => {
    if (
      !matchingMessageRequest ||
      matchingMessageRequest.requestId <= handledMessageRequestRef.current ||
      !targetReady ||
      !messageListElement ||
      messageListElement !== messageListRef.current ||
      messageListElement.dataset.conversationVirtuosoKey !== virtuosoKey
    ) return;
    const requestId = matchingMessageRequest.requestId;
    handledMessageRequestRef.current = requestId;
    const prepared = preparedJumpRef.current;
    if (
      prepared && prepared.key === currentScrollKey &&
      prepared.messageId === matchingMessageRequest.messageId
    ) {
      preparedJumpRef.current = undefined;
    } else {
      captureJumpAnchor(matchingMessageRequest.messageId);
    }
    revealTarget(
      matchingMessageRequest.messageId,
      matchingMessageRequest.behavior ?? "smooth",
      matchingMessageRequest.highlight !== false,
    );
  }, [
    captureJumpAnchor,
    matchingMessageRequest,
    messageListElement,
    revealTarget,
    targetReady,
    virtuosoKey,
  ]);

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
    if (
      !targetReady ||
      !messageListElement ||
      messageListElement !== messageListRef.current ||
      messageListElement.dataset.conversationVirtuosoKey !== virtuosoKey
    ) return;
    const requestId = matchingEntryRequest.requestId;
    handledEntryRequestRef.current = requestId;
    revealTarget(matchingEntryRequest.serverMessageId, "auto", false);
  }, [
    completePositioning,
    matchingEntryRequest,
    messageListElement,
    revealTarget,
    targetReady,
    virtuosoKey,
  ]);

  useLayoutEffect(() => {
    if (!searchActive || !messageListElement) return;
    completePositioning();
  }, [completePositioning, messageListElement, searchActive]);

  useLayoutEffect(() => {
    if (!currentScrollKey || searchActive) return;
    const key = currentScrollKey;
    const element = messageListRef.current;
    const handle = virtuosoRef.current;
    const controlIdentity = scrollControlRef.current.identity;
    const controlGeneration = scrollControlRef.current.generation;
    const captureScrollState = () => {
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
      handle?.getState((state) => {
        conversationVirtuosoSnapshots.set(key, {
          state,
          firstMessageId: layout?.firstMessageId,
          lastMessageId: layout?.lastMessageId,
          virtualItemCount: layout?.virtualItemCount ?? 0,
        });
      });
    };
    const unregisterCapture = registerConversationScrollStateCapture(captureScrollState);
    return () => {
      unregisterCapture();
      if (
        scrollControlRef.current.identity !== controlIdentity ||
        scrollControlRef.current.generation !== controlGeneration
      ) return;
      captureScrollState();
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
    bottomPinRequestRef.current = undefined;
    if (anchorFrameRef.current !== undefined) cancelAnimationFrame(anchorFrameRef.current);
    if (contentAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(contentAnchorFrameRef.current);
    }
    if (positioningAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningAnchorFrameRef.current);
    }
    if (positioningFrameRef.current !== undefined) cancelAnimationFrame(positioningFrameRef.current);
    positioningIdentityRef.current = undefined;
    removeConversationJumpSnapshot(jumpSnapshotRef.current?.snapshot);
    jumpSnapshotRef.current = undefined;
    if (smoothScrollFrameRef.current !== undefined) cancelAnimationFrame(smoothScrollFrameRef.current);
    if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
  }, []);

  const onTotalListHeightChanged = useCallback(() => {
    if (!currentScrollKey || searchActive) return;
    if (performance.now() < smoothScrollUntilRef.current) return;
    const memory = conversationScrollMemory.get(currentScrollKey);
    const control = scrollControlRef.current;
    if (
      memory?.followLatest !== false &&
      (control.mode === "following" ||
        (control.mode === "restoring" && initialLocationRef.current?.mode === "bottom"))
    ) {
      pinToBottom();
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
  }, [currentScrollKey, pinToBottom, restoreAnchor, scheduleBottomPin, searchActive]);

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
      if (event.deltaY > 0 && rawDistance <= BOTTOM_WHEEL_GUARD_PX) {
        event.preventDefault();
      }
    };
    messageListElement.addEventListener("wheel", preventBottomOverscroll, { passive: false });
    return () => messageListElement.removeEventListener("wheel", preventBottomOverscroll);
  }, [messageListElement]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const rawDistance = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (event.deltaY !== 0) {
      anchorCorrectionUntilRef.current = 0;
      setHighlightedMessage(undefined);
      middleAutoScrollRef.current = false;
      trustedMiddleAutoScrollRef.current = false;
      userScrollDirectionRef.current = event.deltaY < 0 ? "up" : "down";
      if (
        event.deltaY < 0 &&
        !historyLoading &&
        historyLoadFrameRef.current === undefined &&
        historyLoadKeyRef.current !== currentScrollKey
      ) olderLoadArmedRef.current = true;
      userIntentUntilRef.current = performance.now() + 320;
      if (event.nativeEvent.isTrusted) trustedUserIntentUntilRef.current = performance.now() + 320;
    }
    if (event.deltaY > 0 && rawDistance <= BOTTOM_WHEEL_GUARD_PX) {
      event.preventDefault();
      if (currentScrollKey) {
        adoptUserScrollMode("following");
        const memory = conversationScrollMemory.get(currentScrollKey);
        if (memory?.followLatest !== true || memory.pendingNewCount !== 0) {
          writeMemory(currentScrollKey, element, true, 0, false);
        }
        publishJumpHistory(currentScrollKey, []);
      }
      return;
    }
    if (event.deltaY !== 0) {
      if (contentAnchorFrameRef.current !== undefined) {
        cancelAnimationFrame(contentAnchorFrameRef.current);
        contentAnchorFrameRef.current = undefined;
      }
      if (event.deltaY < 0) stopFollowingLatest();
      else {
        const followLatest = currentScrollKey
          ? conversationScrollMemory.get(currentScrollKey)?.followLatest !== false
          : false;
        adoptUserScrollMode(followLatest ? "following" : "detached");
      }
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    anchorCorrectionUntilRef.current = 0;
    const wasMiddleAutoScrolling = middleAutoScrollRef.current;
    middleAutoScrollRef.current = false;
    trustedMiddleAutoScrollRef.current = false;
    if (event.pointerType === "mouse" && event.button > 1) return;
    const interactiveTarget = event.target instanceof Element && event.target.closest(
      "a, button, input, textarea, select, video, audio, [role='button']",
    );
    if (
      event.pointerType === "mouse" &&
      event.button === 1 &&
      !wasMiddleAutoScrolling &&
      !interactiveTarget
    ) {
      middleAutoScrollRef.current = true;
      trustedMiddleAutoScrollRef.current = event.nativeEvent.isTrusted;
    }
    pointerActiveRef.current = true;
    pointerScrolledRef.current = false;
    resumeBottomPinOnReleaseRef.current = wasMiddleAutoScrolling ||
      bottomPinRequestRef.current !== undefined;
    trustedPointerActiveRef.current = event.nativeEvent.isTrusted;
    userScrollDirectionRef.current = undefined;
    userScrollTopRef.current = event.currentTarget.scrollTop;
    userIntentUntilRef.current = performance.now() + 320;
  };

  const releasePointerControl = useCallback(() => {
    if (!pointerActiveRef.current) return;
    const trustedPointer = trustedPointerActiveRef.current;
    const pointerScrolled = pointerScrolledRef.current;
    const resumeBottomPin = resumeBottomPinOnReleaseRef.current;
    pointerActiveRef.current = false;
    pointerScrolledRef.current = false;
    resumeBottomPinOnReleaseRef.current = false;
    trustedPointerActiveRef.current = false;
    userIntentUntilRef.current = performance.now() + 320;
    if (trustedPointer) trustedUserIntentUntilRef.current = performance.now() + 320;
    if (
      !middleAutoScrollRef.current &&
      (pointerScrolled || resumeBottomPin) &&
      currentScrollKey &&
      conversationScrollMemory.get(currentScrollKey)?.followLatest
    ) {
      scheduleBottomPin();
    }
  }, [currentScrollKey, scheduleBottomPin]);

  useEffect(() => {
    const stopMiddleAutoScrollOutside = (event: PointerEvent) => {
      if (!middleAutoScrollRef.current) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && messageListRef.current?.contains(target)) return;
      middleAutoScrollRef.current = false;
      trustedMiddleAutoScrollRef.current = false;
      if (currentScrollKey && conversationScrollMemory.get(currentScrollKey)?.followLatest) {
        scheduleBottomPin();
      }
    };
    globalThis.addEventListener("pointerdown", stopMiddleAutoScrollOutside, true);
    globalThis.addEventListener("pointerup", releasePointerControl, true);
    globalThis.addEventListener("pointercancel", releasePointerControl, true);
    globalThis.addEventListener("mouseup", releasePointerControl, true);
    const releaseWindowControl = () => {
      middleAutoScrollRef.current = false;
      trustedMiddleAutoScrollRef.current = false;
      releasePointerControl();
    };
    globalThis.addEventListener("blur", releaseWindowControl);
    return () => {
      globalThis.removeEventListener("pointerdown", stopMiddleAutoScrollOutside, true);
      globalThis.removeEventListener("pointerup", releasePointerControl, true);
      globalThis.removeEventListener("pointercancel", releasePointerControl, true);
      globalThis.removeEventListener("mouseup", releasePointerControl, true);
      globalThis.removeEventListener("blur", releaseWindowControl);
    };
  }, [currentScrollKey, releasePointerControl, scheduleBottomPin]);

  const onPointerUp = releasePointerControl;
  const onPointerCancel = useCallback(() => {
    middleAutoScrollRef.current = false;
    trustedMiddleAutoScrollRef.current = false;
    releasePointerControl();
  }, [releasePointerControl]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    anchorCorrectionUntilRef.current = 0;
    setHighlightedMessage(undefined);
    middleAutoScrollRef.current = false;
    trustedMiddleAutoScrollRef.current = false;
    if (event.nativeEvent.isTrusted) trustedUserIntentUntilRef.current = performance.now() + 320;
    if (event.key === "End") {
      userScrollDirectionRef.current = "down";
      if (currentScrollKey) {
        adoptUserScrollMode("following");
        writeMemory(currentScrollKey, event.currentTarget, true, 0, false);
        scheduleBottomPin();
        publishJumpHistory(currentScrollKey, []);
      }
      userIntentUntilRef.current = performance.now() + 320;
      return;
    }
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
      userScrollDirectionRef.current = "up";
      if (
        !historyLoading &&
        historyLoadFrameRef.current === undefined &&
        historyLoadKeyRef.current !== currentScrollKey
      ) olderLoadArmedRef.current = true;
      userIntentUntilRef.current = performance.now() + 320;
      stopFollowingLatest();
    } else if (["ArrowDown", "PageDown", " "].includes(event.key)) {
      userScrollDirectionRef.current = "down";
      userIntentUntilRef.current = performance.now() + 320;
      const followLatest = currentScrollKey
        ? conversationScrollMemory.get(currentScrollKey)?.followLatest !== false
        : false;
      adoptUserScrollMode(followLatest ? "following" : "detached");
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (!currentScrollKey || searchActive) return;
    const current = conversationScrollMemory.get(currentScrollKey);
    const middleAutoScroll = middleAutoScrollRef.current;
    const pointerInitiated = pointerActiveRef.current || middleAutoScroll;
    const timedIntent = !pointerInitiated &&
      userScrollDirectionRef.current !== undefined &&
      performance.now() <= userIntentUntilRef.current;
    const userInitiated = pointerInitiated || timedIntent;
    if (!userInitiated) return;
    if (
      !pointerInitiated &&
      performance.now() <= anchorCorrectionUntilRef.current
    ) return;
    const atBottom = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
    const previousScrollTop = userScrollTopRef.current;
    const measuredDirection = previousScrollTop === undefined
      ? undefined
      : element.scrollTop < previousScrollTop - 0.5
        ? "up"
        : element.scrollTop > previousScrollTop + 0.5
          ? "down"
          : undefined;
    userScrollTopRef.current = element.scrollTop;
    const direction = timedIntent ? userScrollDirectionRef.current ?? measuredDirection : measuredDirection;
    if (pointerInitiated && measuredDirection) {
      setHighlightedMessage(undefined);
      if (pointerActiveRef.current) pointerScrolledRef.current = true;
      if (contentAnchorFrameRef.current !== undefined) {
        cancelAnimationFrame(contentAnchorFrameRef.current);
        contentAnchorFrameRef.current = undefined;
      }
    }
    if (direction === "up" && pointerInitiated) {
      if (
        !historyLoading &&
        historyLoadFrameRef.current === undefined &&
        historyLoadKeyRef.current !== currentScrollKey
      ) olderLoadArmedRef.current = true;
    } else if (direction === "down") {
      olderLoadArmedRef.current = false;
    }
    const trustedUserInitiated = trustedPointerActiveRef.current ||
      (middleAutoScroll && trustedMiddleAutoScrollRef.current) ||
      performance.now() <= trustedUserIntentUntilRef.current;
    if (direction && trustedUserInitiated) onUserScroll?.({ element, direction, atBottom });
    let control = scrollControlRef.current;
    if (control.mode === "restoring" || control.mode === "navigating") {
      interruptControlledPositioning(atBottom ? "following" : "detached");
      control = scrollControlRef.current;
    }
    const followLatest = atBottom || (
      !pointerInitiated &&
      direction === "down" &&
      current?.followLatest === true
    );
    control.mode = followLatest ? "following" : "detached";
    writeMemory(
      currentScrollKey,
      element,
      followLatest,
      current?.pendingNewCount ?? 0,
      !followLatest,
    );
    if (followLatest && !atBottom) scheduleBottomPin();
    if (atBottom) publishJumpHistory(currentScrollKey, []);
    if (
      element.scrollTop <= HISTORY_TRIGGER_PX &&
      userInitiated &&
      olderLoadArmedRef.current &&
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
    jumpHistoryCount: jumpHistoryState && jumpHistoryState.key === currentScrollKey
      ? jumpHistoryState.count
      : 0,
    rememberJumpOrigin: captureJumpAnchor,
    returnFromJump,
    jumpToLatest,
    pinFollowingMessageMount,
    appendMountMessageId,
    revealAttentionMessage,
    onTotalListHeightChanged,
    onInitialRangeChanged,
    onInitialAtBottomStateChange,
    messageListHandlers: {
      onWheel,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onContextMenu: releasePointerControl,
      onKeyDown,
      onScroll,
    },
  };
};
