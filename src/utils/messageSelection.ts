import type { Message } from "../telegram/types";
import { segmentMediaAlbums } from "./mediaAlbums";

export const isSelectableMessage = (message: Message) =>
  !message.isRemoving && message.content.kind !== "service" && message.content.kind !== "unsupported";

export const messageSelectionGroups = (messages: Message[]) => segmentMediaAlbums(messages)
  .map(segment => (segment.kind === "album" ? segment.messages : [segment.message]).filter(isSelectableMessage))
  .filter(group => group.length > 0);

export function addMessageSelectionGroups(baseIds: ReadonlySet<string>, groups: Message[][]) {
  const next = new Set(baseIds);
  for (const group of groups) {
    const additions = group.filter(message => !next.has(message.id));
    // A range must never select only the first few tiles of an album at the cap.
    if (next.size + additions.length > 100) break;
    additions.forEach(message => next.add(message.id));
  }
  return next;
}

export function toggleMessageSelectionGroup(current: ReadonlySet<string>, messages: Message[]) {
  const selectable = messages.filter(isSelectableMessage);
  if (!selectable.every(message => current.has(message.id))) {
    return addMessageSelectionGroups(current, [selectable]);
  }
  const next = new Set(current);
  selectable.forEach(message => next.delete(message.id));
  return next;
}

export function messageSelectionDeleteScopes(messages: Message[]) {
  const available = messages.filter(message => !message.isRemoving);
  return {
    self: available.filter(message => message.isLocallyDeleted || message.permissions?.canDeleteOnlyForSelf === true),
    all: available.filter(message => !message.isLocallyDeleted && message.permissions?.canDeleteForAllUsers === true),
  };
}
