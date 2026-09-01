import type { Message, SponsoredMessage } from "../telegram/types";
import { localDateKey } from "./formatters";
import {
  groupConsecutiveMessages,
  messageGroupPosition,
  type MessageGroupPosition,
} from "./messageGrouping";
import { segmentMediaAlbums, type MediaAlbumSegment } from "./mediaAlbums";

// Bound consecutive groups while keeping albums atomic. The group wrapper is
// also the sticky boundary used by incoming sender avatars.
export const MAX_MESSAGES_PER_VIRTUAL_BLOCK = 4;

export interface VirtualMessageBlock {
  id: string;
  firstMessage: Message;
  messages: Message[];
  sponsoredMessage?: SponsoredMessage;
  segments: MediaAlbumSegment[];
  positions: ReadonlyMap<string, MessageGroupPosition>;
  startsNewDay: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface SponsoredTimelineOptions {
  messagesBetween: number;
}

const segmentMessages = (segment: MediaAlbumSegment) =>
  segment.kind === "message" ? [segment.message] : segment.messages;

const splitSegments = (segments: MediaAlbumSegment[], maximumMessages: number) => {
  const chunks: MediaAlbumSegment[][] = [];
  let current: MediaAlbumSegment[] = [];
  let currentMessageCount = 0;

  for (const segment of segments) {
    const messageCount = segmentMessages(segment).length;
    if (current.length > 0 && currentMessageCount + messageCount > maximumMessages) {
      chunks.push(current);
      current = [];
      currentMessageCount = 0;
    }
    current.push(segment);
    currentMessageCount += messageCount;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

export const virtualizeMessageGroups = (
  messages: Message[],
  maximumMessages = MAX_MESSAGES_PER_VIRTUAL_BLOCK,
  groupAdjacentMessages = true,
): VirtualMessageBlock[] => {
  if (!Number.isInteger(maximumMessages) || maximumMessages < 1) {
    throw new Error("maximumMessages must be a positive integer");
  }

  const groups = groupAdjacentMessages
    ? groupConsecutiveMessages(messages)
    : messages.map((message) => [message]);
  return groups.flatMap((group, groupIndex) => {
    const positions = new Map(group.map((message, messageIndex) => [
      message.id,
      messageGroupPosition(group, messageIndex),
    ]));
    const chunks = splitSegments(segmentMediaAlbums(group), maximumMessages);
    for (const segment of chunks.flat()) {
      if (segment.kind !== "album") continue;
      segment.messages.forEach((message, messageIndex) => {
        positions.set(
          message.id,
          messageGroupPosition(segment.messages, messageIndex),
        );
      });
    }

    return chunks.map((segments, chunkIndex) => {
      const chunkMessages = segments.flatMap(segmentMessages);
      const firstMessage = chunkMessages[0]!;
      return {
        id: firstMessage.renderKey ?? firstMessage.id,
        firstMessage,
        messages: chunkMessages,
        segments,
        positions,
        startsNewDay: chunkIndex === 0 && (
          groupIndex === 0 ||
          localDateKey(groups[groupIndex - 1]![0]!.sentAt) !== localDateKey(firstMessage.sentAt)
        ),
        continuesBefore: chunkIndex > 0,
        continuesAfter: chunkIndex < chunks.length - 1,
      };
    });
  });
};

export const indexMessagesByVirtualBlock = (blocks: VirtualMessageBlock[]) => {
  const indexes = new Map<string, number>();
  blocks.forEach((block, blockIndex) => {
    block.messages.forEach((message) => indexes.set(message.id, blockIndex));
  });
  return indexes;
};

/** Inserts sponsored blocks without turning them into ordinary message records. */
export const virtualizeMessageTimeline = (
  messages: Message[],
  sponsoredMessages: SponsoredMessage[],
  options: SponsoredTimelineOptions,
  maximumMessages = MAX_MESSAGES_PER_VIRTUAL_BLOCK,
  groupAdjacentMessages = true,
): VirtualMessageBlock[] => {
  const blocks = virtualizeMessageGroups(messages, maximumMessages, groupAdjacentMessages);
  if (sponsoredMessages.length === 0) return blocks;
  const interval = Math.max(0, Math.floor(options.messagesBetween));
  if (interval === 0) {
    const first = blocks[0]?.firstMessage;
    if (!first) return sponsoredMessages.map((sponsored) => ({
      id: `sponsored:${sponsored.id}`,
      firstMessage: undefined as never,
      messages: [],
      sponsoredMessage: sponsored,
      segments: [],
      positions: new Map(),
      startsNewDay: false,
      continuesBefore: false,
      continuesAfter: false,
    }));
    return [
      ...sponsoredMessages.map((sponsored) => ({
        id: `sponsored:${sponsored.id}`,
        firstMessage: first,
        messages: [],
        sponsoredMessage: sponsored,
        segments: [],
        positions: new Map(),
        startsNewDay: false,
        continuesBefore: false,
        continuesAfter: false,
      })),
      ...blocks,
    ];
  }
  const result: VirtualMessageBlock[] = [];
  let ordinaryCount = 0;
  let sponsoredIndex = 0;
  for (const block of blocks) {
    result.push(block);
    ordinaryCount += block.messages.length;
    while (sponsoredIndex < sponsoredMessages.length && ordinaryCount >= interval) {
      const sponsored = sponsoredMessages[sponsoredIndex++]!;
      result.push({
        id: `sponsored:${sponsored.id}`,
        firstMessage: block.firstMessage,
        messages: [],
        sponsoredMessage: sponsored,
        segments: [],
        positions: new Map(),
        startsNewDay: false,
        continuesBefore: false,
        continuesAfter: false,
      });
      ordinaryCount = 0;
    }
  }
  return result.concat(sponsoredMessages.slice(sponsoredIndex).map((sponsored) => ({
    id: `sponsored:${sponsored.id}`,
    firstMessage: blocks.at(-1)?.firstMessage as Message,
    messages: [],
    sponsoredMessage: sponsored,
    segments: [],
    positions: new Map(),
    startsNewDay: false,
    continuesBefore: false,
    continuesAfter: false,
  })));
};
