import { Children, cloneElement, isValidElement, type ReactNode } from "react";

export interface TextHighlightRange {
  start: number;
  end: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const textHighlightRanges = (text: string, query?: string): TextHighlightRange[] => {
  const normalized = query?.trim();
  if (!normalized || !text) return [];
  const expression = new RegExp(escapeRegExp(normalized), "giu");
  return [...text.matchAll(expression)].flatMap((match) => {
    const start = match.index ?? -1;
    return start < 0 ? [] : [{ start, end: start + match[0].length }];
  });
};

export const highlightedText = (text: string, query?: string): ReactNode => {
  const ranges = textHighlightRanges(text, query);
  if (ranges.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark className="message-search-highlight" key={`match:${range.start}:${index}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

export const highlightTextNodes = (children: ReactNode, query?: string): ReactNode =>
  Children.map(children, (child) => {
    if (typeof child === "string") return highlightedText(child, query);
    if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return child;
    if (child.type === "mark" && child.props.className === "message-search-highlight") return child;
    if (child.props.children === undefined) return child;
    return cloneElement(child, undefined, highlightTextNodes(child.props.children, query));
  });
