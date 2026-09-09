import type { Message, SponsoredMessage } from "../telegram/types";
import { localDateKey } from "./formatters";
import {
  groupConsecutiveMessages,
  messageGroupPosition,
  type MessageGroupPosition,
} from "./messageGrouping";
import { belongsToSameAlbum, segmentMediaAlbums, type MediaAlbumSegment } from "./mediaAlbums";

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

const messageRenderKey = (message: Message) => message.renderKey ?? message.id;

/** Reconcile against committed partitions. Pagination must not repack existing
 * rows just because the beginning of a sender group moved. Only new segments
 * are packed; albums remain indivisible and semantic group changes stay local. */
const splitSegments = (
  segments: MediaAlbumSegment[],
  maximumMessages: number,
  previousOwners: ReadonlyMap<string, string>,
  usedIds: Set<string>,
) => {
  const chunks: Array<{ id: string; segments: MediaAlbumSegment[] }> = [];
  let current: MediaAlbumSegment[] = [];
  let currentMessageCount = 0;
  let currentOwner: string | undefined;

  const flush = () => {
    if (current.length === 0) return;
    const firstKey = messageRenderKey(segmentMessages(current[0]!)[0]!);
    let id = currentOwner ?? firstKey;
    // A sender/date edit can split an old partition. Only one part can retain
    // its identity; do not give unrelated virtual rows the same React key.
    if (usedIds.has(id)) id = firstKey;
    while (usedIds.has(id)) id = `partition:${id}`;
    usedIds.add(id);
    chunks.push({ id, segments: current });
    current = [];
    currentMessageCount = 0;
    currentOwner = undefined;
  };

  for (const segment of segments) {
    const messages = segmentMessages(segment);
    const messageCount = messages.length;
    const owner = messages.map(messageRenderKey).map((key) => previousOwners.get(key))
      .find((key) => key !== undefined);
    if (current.length > 0 && (
      currentMessageCount + messageCount > maximumMessages ||
      (owner !== undefined && owner !== currentOwner)
    )) flush();
    if (current.length === 0) currentOwner = owner;
    current.push(segment);
    currentMessageCount += messageCount;
  }
  flush();
  return chunks;
};

const groupMediaAlbumsOnly = (messages: Message[]): Message[][] =>
  messages.reduce<Message[][]>((groups, message) => {
    const current = groups.at(-1);
    if (current && belongsToSameAlbum(current.at(-1)!, message)) current.push(message);
    else groups.push([message]);
    return groups;
  }, []);

export const virtualizeMessageGroups = (
  messages: Message[],
  maximumMessages = MAX_MESSAGES_PER_VIRTUAL_BLOCK,
  groupAdjacentMessages = true,
  previousBlocks: readonly VirtualMessageBlock[] = [],
): VirtualMessageBlock[] => {
  if (!Number.isInteger(maximumMessages) || maximumMessages < 1) {
    throw new Error("maximumMessages must be a positive integer");
  }

  const previousOwners = new Map(previousBlocks.flatMap((block) =>
    block.messages.map((message) => [messageRenderKey(message), block.id] as const),
  ));
  const usedIds = new Set<string>();
  const groups = groupAdjacentMessages
    ? groupConsecutiveMessages(messages)
    : groupMediaAlbumsOnly(messages);
  return groups.flatMap((group, groupIndex) => {
    const positions = new Map(group.map((message, messageIndex) => [
      message.id,
      messageGroupPosition(group, messageIndex),
    ]));
    const chunks = splitSegments(segmentMediaAlbums(group), maximumMessages, previousOwners, usedIds);
    for (const segment of chunks.flatMap((chunk) => chunk.segments)) {
      if (segment.kind !== "album") continue;
      segment.messages.forEach((message, messageIndex) => {
        positions.set(
          message.id,
          messageGroupPosition(segment.messages, messageIndex),
        );
      });
    }

    return chunks.map(({ id, segments }, chunkIndex) => {
      const chunkMessages = segments.flatMap(segmentMessages);
      const firstMessage = chunkMessages[0]!;
      return {
        id,
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
  previousBlocks: readonly VirtualMessageBlock[] = [],
): VirtualMessageBlock[] => {
  const blocks = virtualizeMessageGroups(messages, maximumMessages, groupAdjacentMessages, previousBlocks);
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
