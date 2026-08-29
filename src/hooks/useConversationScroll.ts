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
import {
  conversationJumpMotion,
  conversationJumpAcceleration,
  type ConversationJumpDirection,
} from "../utils/conversationJumpMotion";
import { conversationJumpTiming, motionDuration } from "../utils/motionTokens";
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
  isMessageFullyVisible,
  registerConversationScrollStateCapture,
  resolveConversationVirtualIndex,
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
  restartBottomReconcileAfterWrite,
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
const BOTTOM_RECONCILE_MAX_VERIFICATION_PASSES = 2;
const BOTTOM_MOTION_RECONCILE_MAX_FRAMES = 36;
const BOTTOM_MOTION_RECONCILE_STABLE_FRAMES = BOTTOM_MOTION_RECONCILE_MAX_FRAMES + 1;
const ANCHOR_RECONCILE_STABLE_FRAMES = 6;
const CONTENT_ANCHOR_RECONCILE_MAX_FRAMES = 18;
const CONTENT_ANCHOR_RECONCILE_STABLE_FRAMES = 6;
const NAVIGATION_RECONCILE_STABLE_FRAMES = 6;
const HISTORY_SNAPSHOT_MAX_MS = 750;

const bottomScrollTop = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight);

type ScrollControlMode = "following" | "detached" | "restoring" | "navigating";
type UserScrollDirection = "up" | "down";
type BottomPinMode = "settle" | "track" | "motion";

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
  mode: BottomPinMode;
  maxFrames: number;
  stableFrameCount: number;
  verificationPassCount: number;
  state: BottomReconcileState;
  onSettled: Set<() => void>;
}

interface HistorySnapshotState {
  key: string;
  snapshot: ConversationJumpSnapshot;
  releaseTimer?: ReturnType<typeof globalThis.setTimeout>;
}

interface JumpToLatestOptions {
  onSettled?: () => void;
  preserveVisualBottom?: boolean;
  publishPositioned?: boolean;
}

interface RevealTargetOptions {
  direction?: ConversationJumpDirection;
  forceTransition?: boolean;
  onSettled?: () => void;
  prepareTarget?: () => void;
  resolveTargetOffset?: (target: HTMLElement, list: HTMLElement) => number | undefined;
}

export interface LatestConversationScrollRequest {
  chatId: string;
  requestId: number;
  performanceTraceId?: number;
  preserveVisualBottom?: boolean;
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
  revealLocallyBlocked?: boolean;
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
      preserveVisualBottom?: boolean;
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
  const middleFocusRestoreRef = useRef<HTMLElement | null>(null);
  const middleFocusRestoreFrameRef = useRef<number | undefined>(undefined);
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
  const historySnapshotRef = useRef<HistorySnapshotState | undefined>(undefined);
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
    middleFocusRestoreRef.current = null;
    if (middleFocusRestoreFrameRef.current !== undefined) {
      cancelAnimationFrame(middleFocusRestoreFrameRef.current);
      middleFocusRestoreFrameRef.current = undefined;
    }
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
  // A pending server cursor is already a stable entry intent. Including the
  // transient empty/ready data phase here would restart the positioning
  // generation while the cursor is being hydrated and expose an intermediate
  // viewport before the final target is available.
  const locationDataPhase = requestIdentityTargetId ? "pending-target" : dataPhase;
  const initialLocationIdentity = [
    currentScrollKey ?? scope,
    matchingEntryRequest?.requestId ?? 0,
    matchingLatestRequest?.requestId ?? 0,
    matchingMessageRequest?.requestId ?? 0,
    searchActive ? "search" : "conversation",
    locationDataPhase,
    targetPhase,
  ].join(":");
  const virtuosoKey = `${currentScrollKey ?? scope}:${searchActive ? "search" : "conversation"}`;
  virtuosoKeyRef.current = virtuosoKey;
  const pendingHistoryRestore = pendingHistoryRestoreRef.current;
  let pendingHistoryAnchorId: string | undefined;
  if (pendingHistoryRestore && pendingHistoryRestore.key === currentScrollKey) {
    pendingHistoryAnchorId = pendingHistoryRestore.anchorMessageId;
  }
  const virtuosoFirstItemIndex = resolveConversationVirtualIndex(
    virtuosoKey,
    messageItemIndexes,
    pendingHistoryAnchorId,
  );
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
    if (!element || !currentScrollKey || searchActive) return false;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest === false) return false;
    const target = bottomScrollTop(element);
    if (Math.abs(element.scrollTop - target) <= 0.5) return false;
    element.scrollTop = target;
    return true;
  }, [currentScrollKey, searchActive]);

  const scheduleBottomPin = useCallback((
    onSettled?: () => void,
    mode: BottomPinMode = "settle",
  ) => {
    if (!currentScrollKey || searchActive) return false;
    if (conversationScrollMemory.get(currentScrollKey)?.followLatest === false) return false;
    if (performance.now() < smoothScrollUntilRef.current) return false;
    if (middleAutoScrollRef.current) return false;
    if (pointerActiveRef.current) {
      resumeBottomPinOnReleaseRef.current = true;
      return false;
    }
    if (
      performance.now() <= userIntentUntilRef.current &&
      userScrollDirectionRef.current === "up"
    ) return false;
    const control = scrollControlRef.current;
    const pendingRequest = bottomPinRequestRef.current;
    const maxFrames = mode === "motion"
      ? BOTTOM_MOTION_RECONCILE_MAX_FRAMES
      : BOTTOM_RECONCILE_MAX_FRAMES;
    const stableFrameCount = mode === "motion"
      ? BOTTOM_MOTION_RECONCILE_STABLE_FRAMES
      : BOTTOM_RECONCILE_STABLE_FRAMES;
    const modePriority: Record<BottomPinMode, number> = {
      settle: 0,
      track: 1,
      motion: 2,
    };
    if (
      pendingRequest?.identity === control.identity &&
      pendingRequest.generation === control.generation
    ) {
      const element = messageListRef.current;
      let shouldPinImmediately = false;
      if (
        !pendingRequest.mountCommitted &&
        element?.querySelector("[data-message-id]")
      ) {
        pendingRequest.mountCommitted = true;
        shouldPinImmediately = true;
      }
      if (modePriority[mode] > modePriority[pendingRequest.mode]) {
        pendingRequest.mode = mode;
        pendingRequest.maxFrames = maxFrames;
        pendingRequest.stableFrameCount = stableFrameCount;
        pendingRequest.verificationPassCount = 0;
        pendingRequest.state = startBottomReconcile(maxFrames);
        shouldPinImmediately = pendingRequest.mountCommitted && mode !== "settle";
      }
      if (onSettled) pendingRequest.onSettled.add(onSettled);
      if (shouldPinImmediately) pinToBottom();
    } else {
      if (bottomFrameRef.current !== undefined) {
        cancelAnimationFrame(bottomFrameRef.current);
        bottomFrameRef.current = undefined;
      }
      const mountCommitted = Boolean(
        messageListRef.current?.querySelector("[data-message-id]"),
      );
      bottomPinRequestRef.current = {
        identity: control.identity,
        generation: control.generation,
        mountCommitted,
        mode,
        maxFrames,
        stableFrameCount,
        verificationPassCount: 0,
        state: startBottomReconcile(maxFrames),
        onSettled: new Set(onSettled ? [onSettled] : []),
      };
      if (mountCommitted && mode !== "settle") pinToBottom();
    }
    if (bottomFrameRef.current !== undefined) return true;
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
        if (request && positioningIdentityRef.current === request.identity) {
          positioningIdentityRef.current = undefined;
        }
        return;
      }
      const mountedThisFrame = !request.mountCommitted &&
        Boolean(element.querySelector("[data-message-id]"));
      if (mountedThisFrame) {
        request.mountCommitted = true;
      }
      if (mountedThisFrame || request.mode !== "settle") pinToBottom();
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
        const restart = restartBottomReconcileAfterWrite(
          pinToBottom(),
          request.verificationPassCount,
          BOTTOM_RECONCILE_MAX_VERIFICATION_PASSES,
          request.maxFrames,
        );
        if (restart) {
          request.verificationPassCount = restart.verificationPassCount;
          request.state = restart.state;
          bottomFrameRef.current = requestAnimationFrame(reconcile);
          return;
        }
        bottomPinRequestRef.current = undefined;
        request.onSettled.forEach((callback) => callback());
      } else {
        bottomFrameRef.current = requestAnimationFrame(reconcile);
      }
    };
    bottomFrameRef.current = requestAnimationFrame(reconcile);
    return true;
  }, [currentScrollKey, pinToBottom, searchActive]);

  const settleBottomPosition = useCallback((
    identity: string,
    expectedVirtuosoKey: string,
    generation: number,
    onSettled?: () => void,
  ) => {
    const releasePositioning = () => {
      if (positioningIdentityRef.current === identity) {
        positioningIdentityRef.current = undefined;
      }
    };
    if (!currentScrollKey || searchActive) {
      releasePositioning();
      return;
    }
    const element = messageListRef.current;
    if (
      !element ||
      initialLocationRef.current?.identity !== identity ||
      element.dataset.conversationVirtuosoKey !== expectedVirtuosoKey ||
      scrollControlRef.current.identity !== identity ||
      scrollControlRef.current.generation !== generation
    ) {
      releasePositioning();
      return;
    }
    if (!scheduleBottomPin(onSettled)) releasePositioning();
  }, [currentScrollKey, scheduleBottomPin, searchActive]);

  const reconcileBottomViewport = useCallback(() => {
    const control = scrollControlRef.current;
    const followsLatest = control.mode === "following" ||
      (control.mode === "restoring" && initialLocationRef.current?.mode === "bottom");
    const memory = currentScrollKey
      ? conversationScrollMemory.get(currentScrollKey)
      : undefined;
    if (memory?.followLatest === false || !followsLatest) return false;
    return scheduleBottomPin(undefined, "track");
  }, [currentScrollKey, scheduleBottomPin]);

  useLayoutEffect(() => {
    if (!messageListElement) return;
    const viewport = messageListElement.closest<HTMLElement>(".message-list-shell") ??
      messageListElement;
    let previousViewportHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextViewportHeight = viewport.clientHeight;
      const viewportChanged = Math.abs(nextViewportHeight - previousViewportHeight) > 0.5;
      previousViewportHeight = nextViewportHeight;
      if (!viewportChanged) return;
      reconcileBottomViewport();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [messageListElement, reconcileBottomViewport]);

  const clearJumpTransition = useCallback((token?: symbol) => {
    const active = jumpSnapshotRef.current;
    if (token && active?.token !== token) return;
    if (active) removeConversationJumpSnapshot(active.snapshot);
    jumpSnapshotRef.current = undefined;
    messageListRef.current?.classList.remove("is-jump-transitioning");
  }, []);

  const clearHistorySnapshot = useCallback(() => {
    const active = historySnapshotRef.current;
    if (!active) return;
    if (active.releaseTimer) globalThis.clearTimeout(active.releaseTimer);
    removeConversationJumpSnapshot(active.snapshot);
    historySnapshotRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const active = historySnapshotRef.current;
    if (active && active.key !== currentScrollKey) clearHistorySnapshot();
  }, [clearHistorySnapshot, currentScrollKey]);

  const publishPositionedIdentity = useCallback((identity: string) => {
    if (positioningIdentityRef.current === identity) {
      positioningIdentityRef.current = undefined;
    }
    if (positionedIdentityRef.current === identity) return;
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
  }, [
    matchingEntryRequest?.performanceTraceId,
    matchingLatestRequest?.performanceTraceId,
    matchingMessageRequest?.performanceTraceId,
  ]);

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
    clearHistorySnapshot();
    positioningIdentityRef.current = undefined;
    const current = scrollControlRef.current;
    scrollControlRef.current = {
      ...current,
      generation: current.generation + 1,
      mode,
    };
    if (publishPositioned && current.identity === initialLocationIdentity) {
      publishPositionedIdentity(initialLocationIdentity);
    }
  }, [
    clearHistorySnapshot,
    clearJumpTransition,
    initialLocationIdentity,
    publishPositionedIdentity,
  ]);

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
    const distance = distanceFromBottom(element);
    // The footer sentinel is part of the scrollable area, so Virtuoso may
    // leave the raw scroll position up to 12px before its browser maximum
    // while the latest message is already visually at the viewport bottom.
    // Treat that bounded interval as settled instead of rewriting scrollTop.
    const alreadyAtVisualBottom = options?.preserveVisualBottom === true &&
      distance <= BOTTOM_WHEEL_GUARD_PX;
    const needsConvergence = !alreadyAtVisualBottom && (
      converge || distance > BOTTOM_PROXIMITY_PX
    );
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
        scheduleBottomPin(options?.onSettled, "motion");
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
      if (!alreadyAtVisualBottom) pinToBottom();
      if (needsConvergence || options?.onSettled) {
        if (alreadyAtVisualBottom) {
          options?.onSettled?.();
          return;
        }
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
    scheduleBottomPin(undefined, "track");
    onSettled?.();
    return true;
  }, [currentScrollKey, scheduleBottomPin, searchActive]);

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
      ) {
        if (positioningIdentityRef.current === identity) {
          positioningIdentityRef.current = undefined;
        }
        return;
      }
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
    clearHistorySnapshot();
    const historySnapshot = captureConversationJumpSnapshot(element, { isolate: true });
    if (historySnapshot) {
      historySnapshot.element.dataset.conversationHistorySnapshot = "true";
      historySnapshot.element.remove();
      historySnapshotRef.current = { key: currentScrollKey, snapshot: historySnapshot };
    }
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
      const activeSnapshot = historySnapshotRef.current;
      if (activeSnapshot?.key === currentScrollKey && !activeSnapshot.snapshot.element.isConnected) {
        clearHistorySnapshot();
      }
    });
    return true;
  }, [
    clearHistorySnapshot,
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
    if (positioningIdentityRef.current === identity) return;
    if (positioningFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningFrameRef.current);
      positioningFrameRef.current = undefined;
    }
    if (positioningAnchorFrameRef.current !== undefined) {
      cancelAnimationFrame(positioningAnchorFrameRef.current);
      positioningAnchorFrameRef.current = undefined;
    }
    positioningIdentityRef.current = identity;
    const expectedVirtuosoKey = virtuosoKey;
    const generation = scrollControlRef.current.generation;
    const releasePositioning = () => {
      if (positioningIdentityRef.current === identity) {
        positioningIdentityRef.current = undefined;
      }
    };
    const finishPositioning = () => {
      const control = scrollControlRef.current;
      if (
        control.identity !== identity ||
        control.generation !== generation ||
        initialLocationRef.current?.identity !== identity ||
        positionedIdentityRef.current === identity
      ) {
        releasePositioning();
        return;
      }
      const memory = conversationScrollMemory.get(currentScrollKey);
      control.mode = memory?.followLatest === false ? "detached" : "following";
      publishPositionedIdentity(identity);
    };
    let attempts = 0;
    const finishWhenRendered = () => {
      attempts += 1;
      positioningFrameRef.current = requestAnimationFrame(() => {
        positioningFrameRef.current = undefined;
        if (initialLocationRef.current?.identity !== identity) {
          releasePositioning();
          return;
        }
        if (messageListRef.current?.dataset.conversationVirtuosoKey !== expectedVirtuosoKey) {
          if (attempts < 12) finishWhenRendered();
          else releasePositioning();
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
        // Do not release the switch snapshot while an entry cursor is still
        // waiting for its message. The first range callback can otherwise
        // settle the temporary `pending` location and the later target load
        // starts a second visible positioning pass.
        if (initialLocationRef.current.mode === "pending") {
          releasePositioning();
          return;
        }
        if (initialLocationRef.current.mode === "bottom") {
          if (bottomAlreadySettled) {
            finishPositioning();
          } else {
            pinToBottom();
            settleBottomPosition(identity, expectedVirtuosoKey, generation, finishPositioning);
          }
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
    virtuosoKey,
    pinToBottom,
    publishPositionedIdentity,
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
    const destination = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(destinationMessageId)}"]`,
    );
    // Resolve this before touching the previous highlight anchor. A fully
    // visible destination must remain a true no-op for scroll position.
    if (destination && isMessageFullyVisible(element, destination)) return;
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
    options?: RevealTargetOptions,
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
    // Cancel a previous controlled jump without changing the user's follow
    // state. A destination that is already visible is a highlight-only noop.
    interruptControlledPositioning("detached", false);
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
    const resolveTargetOffset = (target: HTMLElement) => {
      if (options?.resolveTargetOffset) return options.resolveTargetOffset(target, element);
      const listBounds = element.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      return (targetBounds.top + targetBounds.bottom) / 2 -
        (listBounds.top + listBounds.bottom) / 2;
    };
    const jumpDirection = options?.direction ?? (
      visibleAnchorIndex !== undefined && itemIndex < visibleAnchorIndex ? "older" : "newer"
    );
    const scrollDirection = jumpDirection === "older" ? -1 : 1;
    const isLongNavigation = visibleAnchorIndex !== undefined
      ? Math.abs(itemIndex - visibleAnchorIndex) > 8
      : !mounted;
    const setControlledScrollTop = (nextTop: number) => {
      element.scrollTop = nextTop;
    };
    const animateScrollSegments = (
      fromTop: number,
      finalTop: number,
      onFinished: () => void,
    ) => {
      const midpoint = fromTop + (finalTop - fromTop) * 0.46;
      const animateSegment = (
        duration: number,
        targetTop: number,
        progressFor: (elapsed: number) => number,
        next: () => void,
      ) => {
        const startedAt = performance.now();
        const segmentStartTop = element.scrollTop;
        const animate = (now: number) => {
          smoothScrollFrameRef.current = undefined;
          if (
            messageListRef.current !== element ||
            revealTargetTokenRef.current !== revealToken ||
            scrollControlRef.current.generation !== navigationGeneration
          ) return;
          const progress = progressFor((now - startedAt) / duration);
          setControlledScrollTop(segmentStartTop + (targetTop - segmentStartTop) * progress);
          if (progress < 1) {
            smoothScrollFrameRef.current = requestAnimationFrame(animate);
          } else {
            next();
          }
        };
        smoothScrollFrameRef.current = requestAnimationFrame(animate);
      };
      animateSegment(
        conversationJumpTiming.accelerate,
        midpoint,
        conversationJumpAcceleration,
        () => animateSegment(
          conversationJumpTiming.decelerate,
          finalTop,
          latestScrollProgress,
          onFinished,
        ),
      );
    };
    const animateDeceleration = (
      fromTop: number,
      finalTop: number,
      onFinished: () => void,
    ) => {
      const startedAt = performance.now();
      const animate = (now: number) => {
        smoothScrollFrameRef.current = undefined;
        if (
          messageListRef.current !== element ||
          revealTargetTokenRef.current !== revealToken ||
          scrollControlRef.current.generation !== navigationGeneration
        ) return;
        const progress = latestScrollProgress(
          (now - startedAt) / conversationJumpTiming.decelerate,
        );
        setControlledScrollTop(fromTop + (finalTop - fromTop) * progress);
        if (progress < 1) smoothScrollFrameRef.current = requestAnimationFrame(animate);
        else {
          onFinished();
        }
      };
      smoothScrollFrameRef.current = requestAnimationFrame(animate);
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
    const finishVisibleTarget = () => {
      const invalid =
        messageListRef.current !== element ||
        navigationRequestIdentityRef.current !== expectedNavigationIdentity ||
        revealTargetTokenRef.current !== revealToken ||
        scrollControlRef.current.generation !== navigationGeneration;
      if (invalid) {
        clearJumpTransition(revealToken);
        if (revealTargetTokenRef.current === revealToken) {
          revealTargetTokenRef.current = undefined;
        }
        return;
      }
      publishHighlight();
      revealTargetTokenRef.current = undefined;
      options?.onSettled?.();
      completePositioning();
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
          options?.onSettled?.();
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
          const targetOffset = resolveTargetOffset(target);
          if (targetOffset === undefined) {
            stableFrames = 0;
          } else if (Math.abs(targetOffset) > 0.5) {
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
    const mountedTargetIsFullyVisible = mounted
      ? isMessageFullyVisible(element, mounted)
      : false;
    if (!mountedTargetIsFullyVisible || options?.forceTransition) {
      const current = conversationScrollMemory.get(currentScrollKey);
      writeMemory(
        currentScrollKey,
        element,
        false,
        current?.pendingNewCount ?? 0,
        true,
      );
    }
    let targetPrepared = false;
    const prepareTarget = () => {
      if (targetPrepared) return;
      targetPrepared = true;
      options?.prepareTarget?.();
    };
    if (mountedTargetIsFullyVisible && mounted && !options?.forceTransition) {
      prepareTarget();
      // A fully visible destination does not need a viewport change. Let the
      // existing highlight lifecycle provide feedback without disturbing the
      // user's reading position.
      settleScheduled = true;
      scrollControlRef.current.mode = "detached";
      finishVisibleTarget();
    } else if (
      mounted &&
      !options?.forceTransition &&
      resolvedBehavior === "smooth" &&
      !isLongNavigation
    ) {
      // The target is just outside the viewport but still mounted in the
      // overscan range. Keep it in the live list and animate directly to it.
      prepareTarget();
      const offset = resolveTargetOffset(mounted);
      if (offset === undefined || Math.abs(offset) <= 0.5) {
        scheduleTargetSettlement();
      } else {
        settleScheduled = true;
        animateScrollSegments(element.scrollTop, element.scrollTop + offset, settleMountedTarget);
      }
    } else if (resolvedBehavior === "smooth" && typeof element.animate === "function") {
      settleScheduled = true;
      const motion = conversationJumpMotion(jumpDirection);
      const snapshot = captureConversationJumpSnapshot(element);
      const exitTiming = {
        ...motion.exitTiming,
        duration: conversationJumpTiming.accelerate,
      };
      const enterTiming = {
        ...motion.enterTiming,
        duration: conversationJumpTiming.decelerate,
      };
      if (!snapshot) {
        prepareTarget();
        virtuosoRef.current?.scrollToIndex({
          index: itemIndex,
          align: "center",
          behavior: "auto",
        });
        requestAnimationFrame(() => settleMountedTarget());
      } else {
        clearJumpTransition();
        jumpSnapshotRef.current = { token: revealToken, snapshot };
        element.classList.add("is-jump-transitioning");
        revealTransitionReady = (onReady) => {
          if (jumpSnapshotRef.current?.token !== revealToken) {
            const nextContent = element.querySelector<HTMLElement>(".message-list-content") ?? element;
            const enter = nextContent.animate(motion.enter, enterTiming);
            void enter.finished.catch(() => undefined).then(onReady);
            return;
          }
          clearJumpTransition(revealToken);
          const nextContent = element.querySelector<HTMLElement>(".message-list-content") ?? element;
          const enter = nextContent.animate(motion.enter, enterTiming);
          void enter.finished.catch(() => undefined).then(onReady);
        };
        const exit = snapshot.content.animate(motion.exit, exitTiming);
        prepareTarget();
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
          let previousTargetOffset: number | undefined;
          let previousScrollTop: number | undefined;
          let previousScrollHeight: number | undefined;
          let stableTargetFrames = 0;
          let quietSince = performance.now();
          const prepareDeceleration = (attempt = 0) => {
            if (
              messageListRef.current !== element ||
              revealTargetTokenRef.current !== revealToken ||
              scrollControlRef.current.generation !== navigationGeneration
            ) return;
            const target = element.querySelector<HTMLElement>(
              `[data-message-id="${CSS.escape(messageId)}"]`,
            );
            if (!target && attempt < 90) {
              quietSince = performance.now();
              previousTargetOffset = undefined;
              previousScrollTop = undefined;
              previousScrollHeight = undefined;
              requestAnimationFrame(() => prepareDeceleration(attempt + 1));
              return;
            }
            const targetOffset = target ? resolveTargetOffset(target) : undefined;
            const now = performance.now();
            const geometryChanged = previousTargetOffset === undefined ||
              targetOffset === undefined ||
              Math.abs(targetOffset - previousTargetOffset) > 0.5 ||
              previousScrollTop === undefined ||
              Math.abs(element.scrollTop - previousScrollTop) > 0.5 ||
              previousScrollHeight === undefined ||
              element.scrollHeight !== previousScrollHeight;
            if (geometryChanged) quietSince = now;
            if (
              targetOffset !== undefined &&
              previousTargetOffset !== undefined &&
              Math.abs(targetOffset - previousTargetOffset) <= 0.5
            ) stableTargetFrames += 1;
            else stableTargetFrames = 0;
            previousTargetOffset = targetOffset;
            previousScrollTop = element.scrollTop;
            previousScrollHeight = element.scrollHeight;
            if (
              target &&
              targetOffset !== undefined &&
              (stableTargetFrames < 3 || now - quietSince < conversationJumpTiming.relocationQuiet) &&
              attempt < 90
            ) {
              requestAnimationFrame(() => prepareDeceleration(attempt + 1));
              return;
            }
            if (targetOffset !== undefined && isLongNavigation) {
              const targetCenterTop = element.scrollTop + targetOffset;
              const leadDistance = Math.min(
                96,
                Math.max(48, element.clientHeight * 0.16),
              );
              const decelerationStart = targetCenterTop - scrollDirection * leadDistance;
              setControlledScrollTop(decelerationStart);
              clearJumpTransition(revealToken);
              animateDeceleration(decelerationStart, targetCenterTop, settleMountedTarget);
              return;
            }
            if (targetOffset !== undefined && Math.abs(targetOffset) > 0.5) {
              clearJumpTransition(revealToken);
              animateScrollSegments(
                element.scrollTop,
                element.scrollTop + targetOffset,
                settleMountedTarget,
              );
            } else {
              clearJumpTransition(revealToken);
              settleMountedTarget();
            }
          };
          requestAnimationFrame(() => {
            exit.cancel();
            prepareDeceleration();
          });
        });
      }
    } else {
      prepareTarget();
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
    interruptControlledPositioning,
    navigationRequestIdentity,
    reduceMotion,
    writeMemory,
  ]);

  const collapseExpandedQuote = useCallback((
    messageId: string,
    collapse: () => void,
    pointerClientY: number,
    getCollapsedAnchor: () => Element | null,
  ) => {
    const started = revealTarget(messageId, "smooth", false, {
      direction: "older",
      forceTransition: true,
      prepareTarget: collapse,
      resolveTargetOffset: () => {
        const anchor = getCollapsedAnchor();
        if (!anchor) return undefined;
        const anchorBounds = anchor.getBoundingClientRect();
        return (anchorBounds.top + anchorBounds.bottom) / 2 - pointerClientY;
      },
    });
    if (!started) collapse();
  }, [revealTarget]);

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
      const historySnapshot = historySnapshotRef.current;
      if (historySnapshot?.key === currentScrollKey) {
        const bounds = messageListElement.getBoundingClientRect();
        Object.assign(historySnapshot.snapshot.element.style, {
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        });
        document.body.append(historySnapshot.snapshot.element);
        historySnapshot.releaseTimer = globalThis.setTimeout(
          clearHistorySnapshot,
          HISTORY_SNAPSHOT_MAX_MS,
        );
      }
      settleContentAnchorPosition(
        messageListElement,
        pendingHistory.anchorMessageId,
        pendingHistory.anchorOffset,
        virtuosoKey,
        () => {
          clearHistorySnapshot();
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
    clearHistorySnapshot,
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
      preserveVisualBottom: matchingLatestRequest.preserveVisualBottom,
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
    clearHistorySnapshot();
    if (smoothScrollFrameRef.current !== undefined) cancelAnimationFrame(smoothScrollFrameRef.current);
    if (highlightTimerRef.current) globalThis.clearTimeout(highlightTimerRef.current);
  }, [clearHistorySnapshot]);

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
      scheduleBottomPin(undefined, "track");
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
      !interactiveTarget
    ) {
      const active = document.activeElement;
      const editable = active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement &&
          !["checkbox", "radio", "range", "file"].includes(active.type)) ||
        (active instanceof HTMLElement && active.isContentEditable);
      const listElement = event.currentTarget;
      middleFocusRestoreRef.current = editable ? active : null;
      if (middleFocusRestoreFrameRef.current !== undefined) {
        cancelAnimationFrame(middleFocusRestoreFrameRef.current);
      }
      middleFocusRestoreFrameRef.current = requestAnimationFrame(() => {
        middleFocusRestoreFrameRef.current = undefined;
        const target = middleFocusRestoreRef.current;
        const current = document.activeElement;
        if (
          !target?.isConnected ||
          (current !== listElement &&
            current !== document.body &&
            current !== document.documentElement)
        ) return;
        target.focus({ preventScroll: true });
        middleFocusRestoreRef.current = null;
      });
    } else {
      middleFocusRestoreRef.current = null;
    }
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
        scheduleBottomPin(undefined, "track");
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
    if (!userInitiated) {
      const control = scrollControlRef.current;
      const pendingRequest = bottomPinRequestRef.current;
      const followsLatest = current?.followLatest !== false && (
        control.mode === "following" ||
        (control.mode === "restoring" && initialLocationRef.current?.mode === "bottom")
      );
      if (
        followsLatest &&
        pendingRequest?.identity === control.identity &&
        pendingRequest.generation === control.generation &&
        pendingRequest.mode !== "settle" &&
        distanceFromBottom(element) > 0.5
      ) {
        scheduleBottomPin(undefined, "track");
      }
      return;
    }
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
    virtuosoFirstItemIndex,
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
    collapseExpandedQuote,
    reconcileBottomViewport,
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
