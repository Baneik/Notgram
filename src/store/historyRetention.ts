import type { Message } from "../telegram/types";

export const HISTORY_MESSAGE_LIMIT = 2_400;
export const HISTORY_MESSAGE_TARGET = 2_000;
const RECENT_MESSAGE_RESERVE = 300;

export interface HistoryRetentionViewport {
  anchorId?: string;
  following: boolean;
  protectedIds: readonly string[];
  topicId?: string;
  busy?: boolean;
}

export const isOrdinaryHistoryMessage = (message: Message) => !message.isLocallyDeleted && !message.isPending &&
  message.delivery !== "sending" && message.delivery !== "failed";

/** Retained local records and reply references cannot keep an entire dormant chat alive. */
export const protectedHistoryMessages = (messages: Message[], protectedIds: ReadonlySet<string>) => {
  const keep = new Set(messages.filter(message => !isOrdinaryHistoryMessage(message) || protectedIds.has(message.id)).map(message => message.id));
  const albums = new Set(messages.filter(message => keep.has(message.id) && message.mediaAlbumId).map(message => message.mediaAlbumId));
  return messages.filter(message => keep.has(message.id) || (message.mediaAlbumId && albums.has(message.mediaAlbumId)));
};

/** Keep a contiguous reading interval and a small recent tail. The history
 * controller gives disjoint intervals separate cursors rather than joining gaps. */
export const retainedHistoryMessages = (
  messages: Message[],
  viewports: readonly HistoryRetentionViewport[],
  protectedIds: ReadonlySet<string>,
) => {
  const ordinary = messages.filter(isOrdinaryHistoryMessage);
  if (ordinary.length <= HISTORY_MESSAGE_LIMIT || viewports.some(viewport => viewport.busy)) return messages;
  const keep = new Set(protectedIds);
  for (const viewport of viewports) for (const id of viewport.protectedIds) keep.add(id);
  for (const message of ordinary.slice(-RECENT_MESSAGE_RESERVE)) keep.add(message.id);
  const readers = viewports.filter(viewport => !viewport.following && viewport.anchorId);
  const budget = readers.length ? Math.floor((HISTORY_MESSAGE_TARGET - RECENT_MESSAGE_RESERVE) / readers.length) : HISTORY_MESSAGE_TARGET;
  if (!readers.length) for (const message of ordinary.slice(-budget)) keep.add(message.id);
  for (const reader of readers) {
    const scoped = reader.topicId ? ordinary.filter(message => message.topicId === reader.topicId) : ordinary;
    const anchor = scoped.findIndex(message => message.id === reader.anchorId);
    if (anchor < 0) continue;
    const start = Math.max(0, Math.min(anchor - Math.floor(budget / 2), scoped.length - budget));
    for (const message of scoped.slice(start, start + budget)) keep.add(message.id);
  }
  return protectedHistoryMessages(messages, keep);
};
