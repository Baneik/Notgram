import type { MessageReplyQuote, MessageTextEntity } from "../telegram/types";

export interface SelectionPointerPosition {
  x: number;
  y: number;
}

const containsNode = (element: HTMLElement, node: Node | null) =>
  Boolean(node && (node === element || element.contains(node)));

const selectionEdge = (
  surface: HTMLElement,
  focusNode: Node,
  pointer?: SelectionPointerPosition,
) => {
  if (pointer) {
    const bounds = surface.getBoundingClientRect();
    if (pointer.y < bounds.top) return "start" as const;
    if (pointer.y > bounds.bottom) return "end" as const;
    if (pointer.x < bounds.left) return "start" as const;
    if (pointer.x > bounds.right) return "end" as const;
  }

  const position = surface.compareDocumentPosition(focusNode);
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return "start" as const;
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return "end" as const;
  return "end" as const;
};

export const clampSelectionToMessageText = (
  selection: Selection,
  surface: HTMLElement,
  pointer?: SelectionPointerPosition,
  forceBoundary = false,
) => {
  if (
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !containsNode(surface, selection.anchorNode) ||
    (!forceBoundary && containsNode(surface, selection.focusNode))
  ) return false;

  const edge = selectionEdge(surface, selection.focusNode, pointer);
  selection.setBaseAndExtent(
    selection.anchorNode,
    selection.anchorOffset,
    surface,
    edge === "start" ? 0 : surface.childNodes.length,
  );
  return true;
};

const quoteAllowedEntityKinds = new Set<MessageTextEntity["kind"]>([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "customEmoji",
  "dateTime",
]);

// TDLib's message_reply_quote_length_max option defaults to 1024 Unicode
// characters. Keep locally-built quotes within that contract before sending.
const MAX_REPLY_QUOTE_CHARACTERS = 1_024;

const endAfterCodePoints = (
  text: string,
  start: number,
  end: number,
  limit: number,
) => start + Array.from(text.slice(start, end)).slice(0, limit).join("").length;

const sourceRangeForRenderedSelection = (
  sourceText: string,
  renderedText: string,
  renderedStart: number,
  renderedEnd: number,
) => {
  if (
    renderedStart < 0 ||
    renderedEnd <= renderedStart ||
    renderedEnd > renderedText.length
  ) return undefined;

  const selectedText = renderedText.slice(renderedStart, renderedEnd);
  if (sourceText.slice(renderedStart, renderedStart + selectedText.length) === selectedText) {
    return { start: renderedStart, end: renderedStart + selectedText.length };
  }

  // Markdown rendering removes syntax characters from the DOM. Build a
  // monotonic map from every rendered UTF-16 code unit back to the original
  // message so a selection can still produce an exact contiguous source
  // slice that Telegram accepts as an inputTextQuote.
  const sourceStarts = new Array<number>(renderedEnd);
  const sourceEnds = new Array<number>(renderedEnd + 1);
  let sourceCursor = 0;
  for (let index = 0; index < renderedEnd; index += 1) {
    const sourceIndex = sourceText.indexOf(renderedText[index], sourceCursor);
    if (sourceIndex < 0) {
      const candidates: number[] = [];
      let offset = sourceText.indexOf(selectedText);
      while (offset >= 0) {
        candidates.push(offset);
        offset = sourceText.indexOf(selectedText, offset + 1);
      }
      if (candidates.length === 0) return undefined;
      const nearest = candidates.reduce((current, candidate) =>
        Math.abs(candidate - renderedStart) < Math.abs(current - renderedStart)
          ? candidate
          : current,
      );
      return { start: nearest, end: nearest + selectedText.length };
    }
    sourceStarts[index] = sourceIndex;
    sourceEnds[index + 1] = sourceIndex + 1;
    sourceCursor = sourceIndex + 1;
  }

  const start = sourceStarts[renderedStart];
  const end = sourceEnds[renderedEnd];
  return start === undefined || end === undefined || end <= start
    ? undefined
    : { start, end };
};

export const replyQuoteFromRenderedSelection = (
  sourceText: string,
  renderedText: string,
  renderedStart: number,
  renderedEnd: number,
  sourceEntities?: MessageTextEntity[],
): MessageReplyQuote | undefined => {
  const range = sourceRangeForRenderedSelection(
    sourceText,
    renderedText,
    renderedStart,
    renderedEnd,
  );
  if (!range) return undefined;

  let { start, end } = range;
  for (const entity of sourceEntities ?? []) {
    if (entity.kind !== "customEmoji" && entity.kind !== "dateTime") continue;
    const entityEnd = entity.offset + entity.length;
    if (entity.offset < end && entityEnd > start) {
      start = Math.min(start, entity.offset);
      end = Math.max(end, entityEnd);
    }
  }

  const limitedEnd = endAfterCodePoints(
    sourceText,
    start,
    end,
    MAX_REPLY_QUOTE_CHARACTERS,
  );
  if (limitedEnd < end) {
    end = limitedEnd;
    for (const entity of sourceEntities ?? []) {
      if (entity.kind !== "customEmoji" && entity.kind !== "dateTime") continue;
      const entityEnd = entity.offset + entity.length;
      if (entity.offset < end && entityEnd > end) {
        if (entity.offset > start) {
          end = entity.offset;
        } else {
          if (Array.from(sourceText.slice(entity.offset, entityEnd)).length >
            MAX_REPLY_QUOTE_CHARACTERS) return undefined;
          end = entityEnd;
        }
      }
    }
  }

  const text = sourceText.slice(start, end);
  if (!text) return undefined;
  const entities = sourceEntities?.flatMap((entity) => {
    if (!quoteAllowedEntityKinds.has(entity.kind)) return [];
    const entityEnd = entity.offset + entity.length;
    const overlapStart = Math.max(start, entity.offset);
    const overlapEnd = Math.min(end, entityEnd);
    return overlapEnd > overlapStart
      ? [{
          ...entity,
          offset: overlapStart - start,
          length: overlapEnd - overlapStart,
        }]
      : [];
  });

  return {
    text,
    position: start,
    ...(entities && entities.length > 0 ? { entities } : {}),
  };
};

export const replyQuoteFromSelection = (
  selection: Selection | null,
  surface: HTMLElement,
  sourceText: string,
  sourceEntities?: MessageTextEntity[],
): MessageReplyQuote | undefined => {
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !containsNode(surface, selection.anchorNode) ||
    !containsNode(surface, selection.focusNode)
  ) return undefined;

  const range = selection.getRangeAt(0);
  const rawText = range.toString();
  if (!rawText.trim()) return undefined;

  const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
  const trailingWhitespaceLength = rawText.length - rawText.trimEnd().length;
  const prefix = document.createRange();
  prefix.selectNodeContents(surface);
  try {
    prefix.setEnd(range.startContainer, range.startOffset);
  } catch {
    return undefined;
  }
  const renderedStart = prefix.toString().length + leadingWhitespaceLength;
  const renderedEnd = renderedStart + rawText.length - leadingWhitespaceLength - trailingWhitespaceLength;
  const fullRange = document.createRange();
  fullRange.selectNodeContents(surface);
  return replyQuoteFromRenderedSelection(
    sourceText,
    fullRange.toString(),
    renderedStart,
    renderedEnd,
    sourceEntities,
  );
};
