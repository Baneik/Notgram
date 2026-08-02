import { Fragment, lazy, Suspense, type ReactNode } from "react";
import type { MessageTextEntity } from "../telegram/types";

const MarkdownText = lazy(() => import("./MarkdownText"));

interface MessageRichTextProps {
  text: string;
  entities?: MessageTextEntity[];
  className?: string;
}

const safeHref = (value?: string) => {
  if (!value) return undefined;
  if (/^(?:https?:|mailto:|tel:|tg:)/i.test(value)) return value;
  return undefined;
};

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
        ? <a key={key} href={href} target={/^https?:/i.test(href) ? "_blank" : undefined} rel="noreferrer">{children}</a>
        : <Fragment key={key}>{children}</Fragment>;
    }
  }
};

const renderEntities = (text: string, entities: MessageTextEntity[]) => {
  const valid = entities.filter((entity) =>
    entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length,
  );
  const boundaries = [...new Set([
    0,
    text.length,
    ...valid.flatMap((entity) => [entity.offset, entity.offset + entity.length]),
  ])].sort((left, right) => left - right);

  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const value = text.slice(start, end);
    const active = valid
      .filter((entity) => entity.offset <= start && entity.offset + entity.length >= end)
      .sort((left, right) => left.offset - right.offset || right.length - left.length);
    const node = active.reduceRight<ReactNode>(
      (children, entity, entityIndex) => wrapEntity(
        entity,
        text.slice(entity.offset, entity.offset + entity.length),
        children,
        `${start}:${end}:${entityIndex}`,
      ),
      value,
    );
    return <Fragment key={`${start}:${end}`}>{node}</Fragment>;
  });
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
