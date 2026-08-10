import type { MessageReplyQuote } from "../telegram/types";

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

const sourceOffsetForSelection = (
  sourceText: string,
  selectedText: string,
  renderedOffset: number,
) => {
  if (sourceText.slice(renderedOffset, renderedOffset + selectedText.length) === selectedText) {
    return renderedOffset;
  }

  const candidates: number[] = [];
  let offset = sourceText.indexOf(selectedText);
  while (offset >= 0) {
    candidates.push(offset);
    offset = sourceText.indexOf(selectedText, offset + 1);
  }
  if (candidates.length === 0) return undefined;
  return candidates.reduce((nearest, candidate) =>
    Math.abs(candidate - renderedOffset) < Math.abs(nearest - renderedOffset)
      ? candidate
      : nearest,
  );
};

export const replyQuoteFromSelection = (
  selection: Selection | null,
  surface: HTMLElement,
  sourceText: string,
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
  const text = rawText.trim();
  if (!text) return undefined;

  const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
  const prefix = document.createRange();
  prefix.selectNodeContents(surface);
  try {
    prefix.setEnd(range.startContainer, range.startOffset);
  } catch {
    return undefined;
  }
  const renderedOffset = prefix.toString().length + leadingWhitespaceLength;
  const position = sourceOffsetForSelection(sourceText, text, renderedOffset);
  return position === undefined ? undefined : { text, position };
};
