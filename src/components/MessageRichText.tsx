import { Fragment, lazy, Suspense, type MouseEvent, type ReactNode } from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { MessageTextEntity } from "../telegram/types";
import { handleExternalLinkClick, safeExternalHref as safeHref } from "../utils/externalLinks";
import { highlightedText, textHighlightRanges } from "../utils/textHighlight";
import { TextSpoiler, TextSpoilerGroup } from "./Spoiler";

const MarkdownText = lazy(() => import("./MarkdownText"));

interface MessageRichTextProps {
  text: string;
  entities?: MessageTextEntity[];
  className?: string;
  highlightQuery?: string;
  onOpenMention?: (username?: string, userId?: string) => void;
  onSearchHashtag?: (hashtag: string) => void;
}

const entityHref = (entity: MessageTextEntity, value: string) => {
  if (entity.kind === "textUrl") return safeHref(entity.href);
  if (entity.kind === "url") return safeHref(value);
  if (entity.kind === "email") return safeHref(`mailto:${value}`);
  if (entity.kind === "phone") return safeHref(`tel:${value}`);
  if (entity.kind === "mention" && /^@[A-Za-z0-9_]{5,32}$/.test(value)) {
    return safeHref(`https://t.me/${value.slice(1)}`);
  }
  if (entity.kind === "mentionName" && entity.userId && /^-?\d+$/.test(entity.userId)) {
    return safeHref(`tg://user?id=${encodeURIComponent(entity.userId)}`);
  }
  return undefined;
};

function MentionLink({
  entity,
  value,
  children,
  onOpenMention,
}: {
  entity: MessageTextEntity;
  value: string;
  children: ReactNode;
  onOpenMention?: (username?: string, userId?: string) => void;
}) {
  const username = entity.kind === "mention" && /^@[A-Za-z0-9_]{5,32}$/.test(value)
    ? value.slice(1)
    : undefined;
  const resolved = useTelegramStore((state) => {
    const userId = entity.userId ?? (username
      ? state.userIdsByUsername.get(username.toLocaleLowerCase())
      : undefined);
    const user = userId ? state.users.get(userId) : undefined;
    return user
      ? `${user.id}\u0000${user.displayName}\u0000${user.username ?? ""}`
      : "";
  });
  const [resolvedUserId, displayName, resolvedUsername] = resolved
    ? resolved.split("\u0000")
    : [];
  const targetUsername = (username ?? resolvedUsername) || undefined;
  const href = resolvedUserId && /^-?\d+$/.test(resolvedUserId)
    ? `tg://user?id=${encodeURIComponent(resolvedUserId)}`
    : targetUsername
      ? `https://t.me/${encodeURIComponent(targetUsername)}`
      : "#";
  const openMention = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpenMention) {
      handleExternalLinkClick(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onOpenMention(targetUsername, resolvedUserId || entity.userId);
  };
  return (
    <a href={href} onClick={openMention}>
      {displayName ? `@${displayName}` : children}
    </a>
  );
}

function HashtagLink({
  value,
  children,
  onSearchHashtag,
}: {
  value: string;
  children: ReactNode;
  onSearchHashtag?: (hashtag: string) => void;
}) {
  const hashtag = value.startsWith("#") ? value : `#${value}`;
  const searchHashtag = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSearchHashtag?.(hashtag);
  };
  return (
    <a
      className="message-hashtag"
      href={`#search-${encodeURIComponent(hashtag.slice(1))}`}
      onClick={searchHashtag}
    >
      {children}
    </a>
  );
}

const wrapEntity = (
  entity: MessageTextEntity,
  value: string,
  children: ReactNode,
  key: string,
  onOpenMention?: (username?: string, userId?: string) => void,
  onSearchHashtag?: (hashtag: string) => void,
) => {
  switch (entity.kind) {
    case "bold": return <strong key={key}>{children}</strong>;
    case "italic": return <em key={key}>{children}</em>;
    case "underline": return <u key={key}>{children}</u>;
    case "strikethrough": return <del key={key}>{children}</del>;
    case "spoiler": return (
      <TextSpoiler key={key} spoilerId={`${entity.offset}:${entity.length}`}>
        {children}
      </TextSpoiler>
    );
    case "customEmoji": return (
      <span key={key} className="rich-custom-emoji" data-custom-emoji-id={entity.customEmojiId}>
        {children}
      </span>
    );
    case "dateTime": return entity.dateTime
      ? <time key={key} dateTime={new Date(entity.dateTime.unixTime * 1_000).toISOString()}>{children}</time>
      : <Fragment key={key}>{children}</Fragment>;
    case "code": return <code key={key}>{children}</code>;
    case "pre": return <code key={key} className="rich-pre" data-language={entity.language}>{children}</code>;
    case "blockquote": return <span key={key} className="rich-blockquote">{children}</span>;
    case "hashtag": return (
      <HashtagLink key={key} value={value} onSearchHashtag={onSearchHashtag}>
        {children}
      </HashtagLink>
    );
    case "url":
    case "textUrl":
    case "email":
    case "phone": {
      const href = entityHref(entity, value);
      return href
        ? <a key={key} href={href} target="_blank" rel="noreferrer" onClick={handleExternalLinkClick}>{children}</a>
        : <Fragment key={key}>{children}</Fragment>;
    }
    case "mention":
    case "mentionName": {
      return (
        <MentionLink
          key={key}
          entity={entity}
          value={value}
          onOpenMention={onOpenMention}
        >
          {children}
        </MentionLink>
      );
    }
  }
};

const renderInlineRange = (
  text: string,
  entities: MessageTextEntity[],
  startOffset: number,
  endOffset: number,
  keyPrefix: string,
  highlightRanges: ReturnType<typeof textHighlightRanges>,
  onOpenMention?: (username?: string, userId?: string) => void,
  onSearchHashtag?: (hashtag: string) => void,
) => {
  const overlapping = entities.filter((entity) =>
    entity.offset < endOffset && entity.offset + entity.length > startOffset,
  );
  const atomicLinkRanges = overlapping.filter((entity) =>
    entity.kind === "hashtag" || entity.kind === "mention" || entity.kind === "mentionName"
  );
  const boundaries = [...new Set([
    startOffset,
    endOffset,
    ...overlapping.flatMap((entity) => [
      Math.max(startOffset, entity.offset),
      Math.min(endOffset, entity.offset + entity.length),
    ]),
    ...highlightRanges
      .filter((range) => range.start < endOffset && range.end > startOffset)
      .flatMap((range) => [
        Math.max(startOffset, range.start),
        Math.min(endOffset, range.end),
      ]),
  ])].filter((boundary) => !atomicLinkRanges.some((entity) =>
    boundary > entity.offset && boundary < entity.offset + entity.length
  )).sort((left, right) => left - right);

  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    if (end <= start) return null;
    const value = text.slice(start, end);
    const active = overlapping
      .filter((entity) => entity.offset <= start && entity.offset + entity.length >= end)
      .sort((left, right) => left.offset - right.offset || right.length - left.length);
    let node = active.reduceRight<ReactNode>(
      (children, entity, entityIndex) => wrapEntity(
        entity,
        text.slice(entity.offset, entity.offset + entity.length),
        children,
        `${keyPrefix}:${start}:${end}:${entityIndex}`,
        onOpenMention,
        onSearchHashtag,
      ),
      value,
    );
    if (highlightRanges.some((range) => range.start <= start && range.end >= end)) {
      node = <mark className="message-search-highlight">{node}</mark>;
    }
    return <Fragment key={`${keyPrefix}:${start}:${end}`}>{node}</Fragment>;
  });
};

const renderEntities = (
  text: string,
  entities: MessageTextEntity[],
  highlightQuery?: string,
  onOpenMention?: (username?: string, userId?: string) => void,
  onSearchHashtag?: (hashtag: string) => void,
) => {
  const highlightRanges = textHighlightRanges(text, highlightQuery);
  const valid = entities.filter((entity) =>
    entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length,
  );
  const blockquotes = valid
    .filter((entity) => entity.kind === "blockquote")
    .sort((left, right) => left.offset - right.offset || right.length - left.length);
  const inlineEntities = valid.filter((entity) => entity.kind !== "blockquote");
  if (blockquotes.length === 0) {
    return renderInlineRange(
      text,
      inlineEntities,
      0,
      text.length,
      "inline",
      highlightRanges,
      onOpenMention,
      onSearchHashtag,
    );
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const quote of blockquotes) {
    const quoteStart = Math.max(cursor, quote.offset);
    const quoteEnd = quote.offset + quote.length;
    if (quoteEnd <= cursor) continue;
    if (quoteStart > cursor) {
      nodes.push(...renderInlineRange(
        text,
        inlineEntities,
        cursor,
        quoteStart,
        `plain:${cursor}`,
        highlightRanges,
        onOpenMention,
        onSearchHashtag,
      ));
    }
    nodes.push(
      <span className="rich-blockquote" key={`quote:${quote.offset}:${quote.length}`}>
        {renderInlineRange(
          text,
          inlineEntities,
          quoteStart,
          quoteEnd,
          `quote:${quote.offset}`,
          highlightRanges,
          onOpenMention,
          onSearchHashtag,
        )}
      </span>,
    );
    cursor = quoteEnd;
  }
  if (cursor < text.length) {
    nodes.push(...renderInlineRange(
      text,
      inlineEntities,
      cursor,
      text.length,
      `plain:${cursor}`,
      highlightRanges,
      onOpenMention,
      onSearchHashtag,
    ));
  }
  return nodes;
};

export function MessageRichText({
  text,
  entities,
  className = "",
  highlightQuery,
  onOpenMention,
  onSearchHashtag,
}: MessageRichTextProps) {
  if (entities && entities.length > 0) {
    return (
      <TextSpoilerGroup
        className={`message-rich-text ${className}`}
        data-rich-text="entities"
        resetKey={text}
      >
        {renderEntities(text, entities, highlightQuery, onOpenMention, onSearchHashtag)}
      </TextSpoilerGroup>
    );
  }

  return (
    <Suspense fallback={(
      <div className={`message-rich-text is-loading ${className}`} data-rich-text="loading">
        {highlightedText(text, highlightQuery)}
      </div>
    )}>
      <MarkdownText text={text} className={className} highlightQuery={highlightQuery} />
    </Suspense>
  );
}
