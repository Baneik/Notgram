import type { Message } from "../telegram/types";
import { localDateKey } from "./formatters";
import {
  groupConsecutiveMessages,
  messageGroupPosition,
  type MessageGroupPosition,
} from "./messageGrouping";
import { segmentMediaAlbums, type MediaAlbumSegment } from "./mediaAlbums";

export const MAX_MESSAGES_PER_VIRTUAL_BLOCK = 4;

export interface VirtualMessageBlock {
  id: string;
  firstMessage: Message;
  messages: Message[];
  segments: MediaAlbumSegment[];
  positions: ReadonlyMap<string, MessageGroupPosition>;
  startsNewDay: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
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
): VirtualMessageBlock[] => {
  if (!Number.isInteger(maximumMessages) || maximumMessages < 1) {
    throw new Error("maximumMessages must be a positive integer");
  }

  const groups = groupConsecutiveMessages(messages);
  return groups.flatMap((group, groupIndex) => {
    const positions = new Map(group.map((message, messageIndex) => [
      message.id,
      messageGroupPosition(group, messageIndex),
    ]));
    const chunks = splitSegments(segmentMediaAlbums(group), maximumMessages);

    return chunks.map((segments, chunkIndex) => {
      const chunkMessages = segments.flatMap(segmentMessages);
      const firstMessage = chunkMessages[0]!;
      return {
        id: firstMessage.id,
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
