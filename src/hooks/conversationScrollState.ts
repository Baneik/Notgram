import type { StateSnapshot } from "react-virtuoso";
import type { Message } from "../telegram/types";
import type { AppPreferences } from "../store/preferencesStore";

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
  messageItemIndexes?: ReadonlyMap<string, number>;
  viewportWidth?: number;
  geometryKey?: string;
}>();
export const conversationLayouts = new Map<string, {
  firstMessageId?: string;
  lastMessageId?: string;
  virtualItemCount: number;
  messageItemIndexes?: ReadonlyMap<string, number>;
}>();

/** Equal row counts do not imply equal partitions or message order. */
export const matchesVirtualMessageLayout = (
  previous: ReadonlyMap<string, number> | undefined,
  current: ReadonlyMap<string, number>,
) => {
  if (!previous || previous.size !== current.size) return false;
  const entries = previous.entries();
  for (const [id, index] of current) {
    const old = entries.next().value;
    if (!old || old[0] !== id || old[1] !== index) return false;
  }
  return true;
};

export const conversationGeometryKey = (preferences: Pick<AppPreferences,
  "chatFontSize" | "interfaceScale" | "messageGroupSpacing" | "messageRowSpacing" | "messageBubblePadding"
>) => [preferences.chatFontSize, preferences.interfaceScale, preferences.messageGroupSpacing,
  preferences.messageRowSpacing, preferences.messageBubblePadding].join(":");

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
  options: { edge?: "start" | "end"; commit?: boolean } = {},
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
      const candidates = [...previous.messageItemIndexes.keys()];
      if (options.edge === "end") candidates.reverse();
      for (const messageId of candidates) {
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
  if (options.commit !== false) commitConversationVirtualIndex(key, firstItemIndex, messageItemIndexes);
  return firstItemIndex;
};

export const commitConversationVirtualIndex = (
  key: string,
  firstItemIndex: number,
  messageItemIndexes: ReadonlyMap<string, number>,
) => conversationVirtualIndexes.set(key, { firstItemIndex, messageItemIndexes });

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

export const isMessageFullyVisible = (element: HTMLElement, target: HTMLElement) => {
  const listBounds = element.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  return targetBounds.top >= listBounds.top + 1 &&
    targetBounds.bottom <= listBounds.bottom - 1;
};

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
