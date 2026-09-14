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
  atBottom?: boolean;
  anchorSentAt?: string;
  nearbyAnchors?: readonly { messageId: string; offset: number }[];
  leadingSpace?: number;
}

/** A following viewport and a saved reading position have different lifetimes. */
export const restoreConversationBottom = (
  memory: ConversationScrollMemory | undefined,
  messages: readonly Message[],
) => !memory || (memory.followLatest && memory.atBottom !== false &&
  memory.lastKnownMessageId === messages.at(-1)?.id);

export const resolveConversationReadingAnchor = (
  memory: ConversationScrollMemory | undefined,
  messages: readonly Message[],
  unavailable = false,
) => {
  if (!memory?.anchorMessageId) return undefined;
  const anchor = { messageId: memory.anchorMessageId, offset: memory.anchorOffset ?? 0 };
  if (!unavailable || messages.some(message => message.id === anchor.messageId)) return anchor;
  const ids = new Set(messages.map(message => message.id));
  const neighbor = memory.nearbyAnchors?.find(candidate => ids.has(candidate.messageId));
  if (neighbor) return neighbor;
  // If the whole saved viewport was deleted, prefer the next chronological
  // message, then the closest predecessor. Never interpret absence as latest.
  const nearest = memory.anchorSentAt
    ? messages.find(message => message.sentAt >= memory.anchorSentAt!) ?? messages.at(-1)
    : messages[0];
  return nearest ? { messageId: nearest.id, offset: anchor.offset } : undefined;
};

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
  blockIds: readonly string[];
}

const conversationVirtualIndexes = new Map<string, ConversationVirtualIndexState>();

// firstItemIndex shifts Virtuoso's entire size cache. Only a complete prefix
// insertion/removal has that meaning; a viewport anchor cannot determine it.
export const resolveConversationVirtualIndex = (
  key: string,
  blockIds: readonly string[],
  options: { commit?: boolean } = {},
) => {
  const previous = conversationVirtualIndexes.get(key);
  if (previous?.blockIds === blockIds) return previous.firstItemIndex;

  let firstItemIndex = previous?.firstItemIndex ?? VIRTUAL_ITEM_INDEX_BASE;
  if (previous && previous.blockIds.length > 0 && blockIds.length > 0) {
    const delta = blockIds.length - previous.blockIds.length;
    const prepended = delta > 0 && previous.blockIds.every((id, index) => blockIds[index + delta] === id);
    const removedPrefix = delta < 0 && blockIds.every((id, index) => previous.blockIds[index - delta] === id);
    if (prepended || removedPrefix) firstItemIndex -= delta;
    // Interior edits, repartitioning and window replacement keep the cache
    // origin. Mounted rows remeasure in place; the viewport transaction owns
    // bottom/reading-position correction, including mixed head/tail changes.
  }
  firstItemIndex = Math.max(0, firstItemIndex);
  if (options.commit !== false) commitConversationVirtualIndex(key, firstItemIndex, blockIds);
  return firstItemIndex;
};

export const commitConversationVirtualIndex = (
  key: string,
  firstItemIndex: number,
  blockIds: readonly string[],
) => conversationVirtualIndexes.set(key, { firstItemIndex, blockIds });

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
