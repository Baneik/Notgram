import type { StateSnapshot } from "react-virtuoso";
import type { Message } from "../telegram/types";

export interface ConversationScrollMemory {
  scrollTop: number;
  followLatest: boolean;
  lastKnownMessageId?: string;
  pendingNewCount: number;
  anchorMessageId?: string;
  anchorOffset?: number;
}

export interface ConversationLayoutSnapshot {
  key?: string;
  firstId?: string;
  lastId?: string;
  searchActive: boolean;
}

export interface PendingHistoryRestore {
  key: string;
  previousFirstId?: string;
  anchorMessageId: string;
  anchorOffset: number;
  startedAt: number;
  beforeCount: number;
}

export interface InitialLocation {
  identity: string;
  location: import("react-virtuoso").IndexLocationWithAlign | number;
  mode: "empty" | "bottom" | "anchor" | "search" | "pending";
  targetMessageId?: string;
  targetOffset?: number;
}

export const conversationScrollMemory = new Map<string, ConversationScrollMemory>();
export const conversationVirtuosoSnapshots = new Map<string, {
  state: StateSnapshot;
  firstMessageId?: string;
  lastMessageId?: string;
  virtualItemCount: number;
}>();
export const conversationLayouts = new Map<string, {
  firstMessageId?: string;
  lastMessageId?: string;
  virtualItemCount: number;
}>();

const VIRTUAL_ITEM_INDEX_BASE = 1_000_000;

interface ConversationVirtualIndexState {
  firstItemIndex: number;
  messageItemIndexes: ReadonlyMap<string, number>;
}

const conversationVirtualIndexes = new Map<string, ConversationVirtualIndexState>();

// Virtuoso can retain measured geometry through prepends only while existing
// blocks keep the same logical indexes.
export const resolveConversationVirtualIndex = (
  key: string,
  messageItemIndexes: ReadonlyMap<string, number>,
  preferredAnchorId?: string,
) => {
  const previous = conversationVirtualIndexes.get(key);
  if (previous?.messageItemIndexes === messageItemIndexes) return previous.firstItemIndex;

  let firstItemIndex = previous?.firstItemIndex ?? VIRTUAL_ITEM_INDEX_BASE;
  if (previous && previous.messageItemIndexes.size > 0 && messageItemIndexes.size > 0) {
    let sharedMessageId = preferredAnchorId &&
      previous.messageItemIndexes.has(preferredAnchorId) &&
      messageItemIndexes.has(preferredAnchorId)
      ? preferredAnchorId
      : undefined;
    if (!sharedMessageId) {
      for (const messageId of previous.messageItemIndexes.keys()) {
        if (!messageItemIndexes.has(messageId)) continue;
        sharedMessageId = messageId;
        break;
      }
    }
    if (sharedMessageId) {
      firstItemIndex += previous.messageItemIndexes.get(sharedMessageId)! -
        messageItemIndexes.get(sharedMessageId)!;
    } else {
      firstItemIndex = VIRTUAL_ITEM_INDEX_BASE;
    }
  }
  firstItemIndex = Math.max(0, firstItemIndex);
  conversationVirtualIndexes.set(key, { firstItemIndex, messageItemIndexes });
  return firstItemIndex;
};

let activeConversationScrollStateCapture: (() => void) | undefined;

export const registerConversationScrollStateCapture = (capture: () => void) => {
  activeConversationScrollStateCapture = capture;
  return () => {
    if (activeConversationScrollStateCapture === capture) {
      activeConversationScrollStateCapture = undefined;
    }
  };
};

export const captureActiveConversationScrollState = () => {
  activeConversationScrollStateCapture?.();
};

export const scrollMemoryKey = (scope: string, chatId?: string) =>
  chatId ? `${scope}:${chatId}` : undefined;

export const hasConversationScrollMemory = (scope: string, chatId: string) =>
  conversationScrollMemory.has(scrollMemoryKey(scope, chatId)!);

export const distanceFromBottom = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);

export const visibleAnchor = (element: HTMLElement) => {
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

export const appendedMessageCount = (messages: Message[], previousLastId?: string) => {
  if (!previousLastId) return 0;
  const previousIndex = messages.findIndex((message) => message.id === previousLastId);
  return previousIndex < 0 ? 0 : Math.max(0, messages.length - previousIndex - 1);
};
