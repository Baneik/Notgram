import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent,
} from "react";
import type { Message } from "../telegram/types";

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

interface ConversationScrollOptions {
  scope: string;
  chatId?: string;
  latestRequest?: LatestConversationScrollRequest;
  visibleMessages: Message[];
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

const captureScrollMemory = (
  element: HTMLElement,
  lastKnownMessageId: string | undefined,
  pendingNewCount: number,
  followLatest = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX,
): ConversationScrollMemory => {
  const listBounds = element.getBoundingClientRect();
  const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((row) => row.getBoundingClientRect().bottom > listBounds.top + 1);
  const atBottom = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
  const shouldFollowLatest = atBottom || followLatest;
  return {
    scrollTop: element.scrollTop,
    followLatest: shouldFollowLatest,
    lastKnownMessageId,
    pendingNewCount: shouldFollowLatest ? 0 : pendingNewCount,
    anchorMessageId: anchor?.dataset.messageId,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - listBounds.top : undefined,
  };
};

const restoreScrollMemory = (element: HTMLElement, memory: ConversationScrollMemory) => {
  element.scrollTop = memory.scrollTop;
  if (!memory.anchorMessageId || memory.anchorOffset === undefined) return;
  const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((row) => row.dataset.messageId === memory.anchorMessageId);
  if (!anchor) return;
  const currentOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
  element.scrollTop += currentOffset - memory.anchorOffset;
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
  visibleMessages,
  search,
  historyLoading,
  hasOlderMessages,
  messageCount,
  onLoadOlder,
}: ConversationScrollOptions) => {
  const messageListRef = useRef<HTMLDivElement>(null);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const previousLayoutRef = useRef<ConversationLayoutSnapshot | undefined>(undefined);
  const handledLatestRequestRef = useRef(0);
  const scrollPointerActiveRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const [newMessageNotice, setNewMessageNotice] = useState<{
    key: string;
    count: number;
  }>();
  const currentScrollKey = scrollMemoryKey(scope, chatId);
  const lastVisibleMessageId = visibleMessages.at(-1)?.id;

  const jumpToLatest = () => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    scrollPointerActiveRef.current = false;
    userScrollIntentUntilRef.current = 0;
    element.scrollTop = element.scrollHeight;
    const memory = captureScrollMemory(element, lastVisibleMessageId, 0, true);
    conversationScrollMemory.set(currentScrollKey, {
      ...memory,
      followLatest: true,
      pendingNewCount: 0,
    });
    setNewMessageNotice({ key: currentScrollKey, count: 0 });
  };

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const previous = previousLayoutRef.current;
    const firstId = visibleMessages[0]?.id;
    const lastId = lastVisibleMessageId;
    const stored = conversationScrollMemory.get(currentScrollKey);

    if (search) {
      if (!previous || previous.key !== currentScrollKey || previous.search !== search) {
        element.scrollTop = 0;
      }
      setNewMessageNotice({
        key: currentScrollKey,
        count: stored?.pendingNewCount ?? 0,
      });
      previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
      return;
    }

    let pendingNewCount = stored?.pendingNewCount ?? 0;
    let followLatest = stored?.followLatest ?? true;
    const enteringChat = !previous || previous.key !== currentScrollKey;
    const leavingSearch = previous?.key === currentScrollKey && Boolean(previous.search);
    if (enteringChat || leavingSearch) {
      if (!stored || stored.followLatest) {
        element.scrollTop = element.scrollHeight;
        pendingNewCount = 0;
        followLatest = true;
      } else {
        restoreScrollMemory(element, stored);
        pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
        followLatest = false;
      }
    } else if (stored) {
      const firstMessageChanged = previous.firstId !== firstId;
      const previousFirstStillPresent = Boolean(
        previous.firstId && visibleMessages.some((message) => message.id === previous.firstId),
      );
      if (firstMessageChanged && previousFirstStillPresent) {
        if (stored.followLatest) element.scrollTop = element.scrollHeight;
        else restoreScrollMemory(element, stored);
      }

      if (previous.lastId !== lastId) {
        if (stored.followLatest) {
          element.scrollTop = element.scrollHeight;
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
    setNewMessageNotice({ key: currentScrollKey, count: memory.pendingNewCount });
    previousLayoutRef.current = { key: currentScrollKey, firstId, lastId, search };
  }, [currentScrollKey, lastVisibleMessageId, search, visibleMessages]);

  useLayoutEffect(() => {
    if (
      !latestRequest ||
      latestRequest.chatId !== chatId ||
      latestRequest.requestId <= handledLatestRequestRef.current
    ) return;
    handledLatestRequestRef.current = latestRequest.requestId;
    jumpToLatest();
  }, [chatId, latestRequest]);

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
        if (stored.followLatest) element.scrollTop = element.scrollHeight;
        else restoreScrollMemory(element, stored);
        const memory = captureScrollMemory(
          element,
          visibleMessages.at(-1)?.id,
          stored.pendingNewCount,
          stored.followLatest,
        );
        conversationScrollMemory.set(currentScrollKey, memory);
        setNewMessageNotice({ key: currentScrollKey, count: memory.pendingNewCount });
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  }, [currentScrollKey, search, visibleMessages]);

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
    void onLoadOlder();
  }, [chatId, hasOlderMessages, historyLoading, messageCount, onLoadOlder, search]);

  const onWheel = () => {
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
      const memory = captureScrollMemory(
        element,
        lastVisibleMessageId,
        stored?.pendingNewCount ?? 0,
        followLatest,
      );
      conversationScrollMemory.set(currentScrollKey, memory);
      setNewMessageNotice({ key: currentScrollKey, count: memory.pendingNewCount });
    }
    if (element.scrollTop <= 64 && !search && hasOlderMessages && !historyLoading) {
      void onLoadOlder();
    }
  };

  return {
    messageListRef,
    currentScrollKey,
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
