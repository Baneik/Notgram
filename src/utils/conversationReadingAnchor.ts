interface ReadingPoint {
  messageId: string;
  caption: boolean;
  selector?: string;
  offset: number;
  width: number;
  height: number;
  albumId?: string;
}

export interface ConversationReadingAnchor {
  points: readonly ReadingPoint[];
  activeIndex: number;
}

const rowSelector = "[data-message-id], [data-caption-message-id]";
const contentClasses = ["message-rich-text", "photo-preview", "attachment-message", "poll-message"];
const contentSelector = contentClasses.map(name => `.${name}`).join(", ");

/** Transaction-local content positions survive virtual remounts. Sender/day
 * headers may disappear during pagination, so their row top is not a reading point. */
export const captureConversationReadingAnchor = (
  list: HTMLElement,
  retainedIds: ReadonlyMap<string, number>,
): ConversationReadingAnchor | undefined => {
  const viewport = list.getBoundingClientRect();
  const points: ReadingPoint[] = [];
  for (const row of list.querySelectorAll<HTMLElement>(rowSelector)) {
    const messageId = row.dataset.messageId ?? row.dataset.captionMessageId;
    if (!messageId || !retainedIds.has(messageId)) continue;
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom <= viewport.top + 1 || bounds.top >= viewport.bottom - 1) continue;
    const content = [...row.querySelectorAll<HTMLElement>(contentSelector)].find(candidate => {
      if (candidate.closest(rowSelector) !== row) return false;
      const rect = candidate.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
    });
    const target = content ?? row;
    const targetBounds = target.getBoundingClientRect();
    points.push({ messageId, caption: Boolean(row.dataset.captionMessageId),
      selector: content ? contentClasses.find(name => content.classList.contains(name)) : undefined,
      offset: targetBounds.top - viewport.top, width: targetBounds.width, height: targetBounds.height,
      albumId: target.closest<HTMLElement>("[data-media-album-id]")?.dataset.mediaAlbumId });
    if (points.length === 3) break;
  }
  return points.length ? { points, activeIndex: 0 } : undefined;
};

export const measureConversationReadingAnchor = (list: HTMLElement, anchor: ConversationReadingAnchor) => {
  const viewportTop = list.getBoundingClientRect().top;
  const measured = anchor.points.flatMap((point, index) => {
    if (index < anchor.activeIndex) return [];
    const attribute = point.caption ? "data-caption-message-id" : "data-message-id";
    const row = list.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(point.messageId)}"]`);
    const target = point.selector ? row?.querySelector<HTMLElement>(`.${point.selector}`) : row;
    if (!target || (point.selector && target.closest(rowSelector) !== row)) return [];
    const bounds = target.getBoundingClientRect();
    if (bounds.height <= 0) return [];
    const unchanged = Math.abs(bounds.width - point.width) <= 1 && Math.abs(bounds.height - point.height) <= 1 &&
      target.closest<HTMLElement>("[data-media-album-id]")?.dataset.mediaAlbumId === point.albumId;
    return [{ index, unchanged, messageId: point.messageId, expectedOffset: point.offset,
      actualOffset: bounds.top - viewportTop, width: bounds.width, height: bounds.height }];
  });
  // A single photo can become an album tile, or a caption can reflow. Prefer
  // the captured surviving neighbor, without switching back during settlement.
  const stable = measured.filter(point => point.unchanged);
  const points = stable.length ? stable : measured;
  if (points[0]) anchor.activeIndex = points[0].index;
  return points;
};
