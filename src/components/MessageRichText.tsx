import { Fragment, lazy, Suspense, type ReactNode } from "react";
import type { MessageTextEntity } from "../telegram/types";
import { handleExternalLinkClick, safeExternalHref as safeHref } from "../utils/externalLinks";

const MarkdownText = lazy(() => import("./MarkdownText"));

interface MessageRichTextProps {
  text: string;
  entities?: MessageTextEntity[];
  className?: string;
}

const entityHref = (entity: MessageTextEntity, value: string) => {
  if (entity.kind === "textUrl") return safeHref(entity.href);
  if (entity.kind === "url") return safeHref(value);
  if (entity.kind === "email") return safeHref(`mailto:${value}`);
  if (entity.kind === "phone") return safeHref(`tel:${value}`);
  return undefined;
};

const wrapEntity = (
  entity: MessageTextEntity,
  value: string,
  children: ReactNode,
  key: string,
) => {
  switch (entity.kind) {
    case "bold": return <strong key={key}>{children}</strong>;
    case "italic": return <em key={key}>{children}</em>;
    case "underline": return <u key={key}>{children}</u>;
    case "strikethrough": return <del key={key}>{children}</del>;
    case "spoiler": return <span key={key} className="rich-spoiler" tabIndex={0}>{children}</span>;
    case "code": return <code key={key}>{children}</code>;
    case "pre": return <code key={key} className="rich-pre" data-language={entity.language}>{children}</code>;
    case "blockquote": return <span key={key} className="rich-blockquote">{children}</span>;
    case "url":
    case "textUrl":
    case "email":
    case "phone": {
      const href = entityHref(entity, value);
      return href
        ? <a key={key} href={href} target="_blank" rel="noreferrer" onClick={handleExternalLinkClick}>{children}</a>
        : <Fragment key={key}>{children}</Fragment>;
    }
  }
};

const renderInlineRange = (
  text: string,
  entities: MessageTextEntity[],
  startOffset: number,
  endOffset: number,
  keyPrefix: string,
) => {
  const overlapping = entities.filter((entity) =>
    entity.offset < endOffset && entity.offset + entity.length > startOffset,
  );
  const boundaries = [...new Set([
    startOffset,
    endOffset,
    ...overlapping.flatMap((entity) => [
      Math.max(startOffset, entity.offset),
      Math.min(endOffset, entity.offset + entity.length),
    ]),
  ])].sort((left, right) => left - right);

  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    if (end <= start) return null;
    const value = text.slice(start, end);
    const active = overlapping
      .filter((entity) => entity.offset <= start && entity.offset + entity.length >= end)
      .sort((left, right) => left.offset - right.offset || right.length - left.length);
    const node = active.reduceRight<ReactNode>(
      (children, entity, entityIndex) => wrapEntity(
        entity,
        text.slice(entity.offset, entity.offset + entity.length),
        children,
        `${keyPrefix}:${start}:${end}:${entityIndex}`,
      ),
      value,
    );
    return <Fragment key={`${keyPrefix}:${start}:${end}`}>{node}</Fragment>;
  });
};

const renderEntities = (text: string, entities: MessageTextEntity[]) => {
  const valid = entities.filter((entity) =>
    entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length,
  );
  const blockquotes = valid
    .filter((entity) => entity.kind === "blockquote")
    .sort((left, right) => left.offset - right.offset || right.length - left.length);
  const inlineEntities = valid.filter((entity) => entity.kind !== "blockquote");
  if (blockquotes.length === 0) {
    return renderInlineRange(text, inlineEntities, 0, text.length, "inline");
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const quote of blockquotes) {
    const quoteStart = Math.max(cursor, quote.offset);
    const quoteEnd = quote.offset + quote.length;
    if (quoteEnd <= cursor) continue;
    if (quoteStart > cursor) {
      nodes.push(...renderInlineRange(text, inlineEntities, cursor, quoteStart, `plain:${cursor}`));
    }
    nodes.push(
      <span className="rich-blockquote" key={`quote:${quote.offset}:${quote.length}`}>
        {renderInlineRange(text, inlineEntities, quoteStart, quoteEnd, `quote:${quote.offset}`)}
      </span>,
    );
    cursor = quoteEnd;
  }
  if (cursor < text.length) {
    nodes.push(...renderInlineRange(text, inlineEntities, cursor, text.length, `plain:${cursor}`));
  }
  return nodes;
};

export function MessageRichText({ text, entities, className = "" }: MessageRichTextProps) {
  if (entities && entities.length > 0) {
    return (
      <div className={`message-rich-text ${className}`} data-rich-text="entities">
        {renderEntities(text, entities)}
      </div>
    );
  }

  return (
    <Suspense fallback={(
      <div className={`message-rich-text ${className}`} data-rich-text="loading">{text}</div>
    )}>
      <MarkdownText text={text} className={className} />
    </Suspense>
  );
}
