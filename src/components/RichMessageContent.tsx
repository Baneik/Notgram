import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { Download, Image as ImageIcon, LoaderCircle, MapPin } from "lucide-react";
import katex from "katex";
import { createElement, Fragment, useState, type CSSProperties, type ReactNode } from "react";
import "katex/dist/katex.min.css";
import type {
  MessageRichBlock,
  MessageRichCaption,
  MessageRichMedia,
  MessageRichTableCell,
  MessageRichTextRun,
} from "../telegram/types";
import { AudioPlayer } from "./AudioPlayer";
import { VideoPlayer } from "./VideoPlayer";

interface RichMessageContentProps {
  blocks: MessageRichBlock[];
  isRtl: boolean;
  isFull: boolean;
  messageId: string;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onCancelDownload: (fileId: number) => Promise<void>;
  onStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number) => Promise<void>;
}

interface RenderContext extends Omit<RichMessageContentProps, "blocks" | "isRtl" | "isFull"> {
  scope: string;
}

const safeHref = (value?: string) => {
  if (!value) return undefined;
  return /^(?:https?:|mailto:|tel:|tg:)/i.test(value) ? value : undefined;
};

const localSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};

const scopedAnchor = (context: RenderContext, kind: "anchor" | "reference", name: string) =>
  `${context.scope}-${kind}-${encodeURIComponent(name || "top")}`;

const relativeDateTime = (unixTime: number) => {
  const seconds = unixTime - Date.now() / 1_000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, unitSize]) => Math.abs(seconds) >= unitSize) ?? units.at(-1)!;
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(seconds / size),
    unit,
  );
};

const absoluteDateTime = (run: MessageRichTextRun) => {
  const details = run.dateTime;
  if (!details) return run.text;
  const options: Intl.DateTimeFormatOptions = {};
  if (details.datePrecision === "short") {
    Object.assign(options, { year: "numeric", month: "2-digit", day: "2-digit" });
  } else if (details.datePrecision === "long") {
    Object.assign(options, { year: "numeric", month: "long", day: "numeric" });
  }
  if (details.timePrecision === "short") {
    Object.assign(options, { hour: "2-digit", minute: "2-digit" });
  } else if (details.timePrecision === "long") {
    Object.assign(options, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  if (details.showDayOfWeek) options.weekday = "short";
  return Object.keys(options).length > 0
    ? new Intl.DateTimeFormat(undefined, options).format(new Date(details.unixTime * 1_000))
    : run.text;
};

const richDateTimeText = (run: MessageRichTextRun) => {
  if (!run.dateTime || run.dateTime.mode === "original") return run.text;
  if (run.dateTime.mode === "relative") return relativeDateTime(run.dateTime.unixTime);
  return absoluteDateTime(run);
};

const MathExpression = ({ expression, displayMode }: { expression: string; displayMode: boolean }) => (
  <span
    className={displayMode ? "rich-math-block" : "rich-math-inline"}
    data-expression={expression}
    dangerouslySetInnerHTML={{
      __html: katex.renderToString(expression, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      }),
    }}
  />
);

const renderRun = (run: MessageRichTextRun, key: string, context: RenderContext) => {
  let node: ReactNode = run.mathematicalExpression
    ? <MathExpression expression={run.mathematicalExpression} displayMode={false} />
    : richDateTimeText(run);
  if (run.code) node = <code>{node}</code>;
  if (run.bold) node = <strong>{node}</strong>;
  if (run.italic) node = <em>{node}</em>;
  if (run.underline) node = <u>{node}</u>;
  if (run.strikethrough) node = <del>{node}</del>;
  if (run.spoiler) node = <span className="rich-spoiler" tabIndex={0}>{node}</span>;
  if (run.subscript) node = <sub>{node}</sub>;
  if (run.superscript) node = <sup>{node}</sup>;
  if (run.marked) node = <mark>{node}</mark>;
  if (run.dateTime) {
    node = <time dateTime={new Date(run.dateTime.unixTime * 1_000).toISOString()}>{node}</time>;
  }
  if (run.customEmojiId) {
    node = (
      <span className="rich-custom-emoji" data-custom-emoji-id={run.customEmojiId} title={run.text}>
        {node}
      </span>
    );
  }
  if (run.semantic) node = <span data-rich-semantic={run.semantic}>{node}</span>;

  const href = safeHref(run.href);
  if (href) {
    node = (
      <a href={href} target={/^https?:/i.test(href) ? "_blank" : undefined} rel="noreferrer">
        {node}
      </a>
    );
  } else if (run.linkTarget) {
    node = (
      <a href={`#${scopedAnchor(context, run.linkTarget.kind, run.linkTarget.name)}`}>
        {node}
      </a>
    );
  }
  if (run.anchor) {
    node = <span id={scopedAnchor(context, run.anchor.kind, run.anchor.name)}>{node}</span>;
  }
  return <Fragment key={key}>{node}</Fragment>;
};

const renderRuns = (runs: MessageRichTextRun[], key: string, context: RenderContext) =>
  runs.map((run, index) => renderRun(run, `${key}:run:${index}`, context));

const Caption = ({ caption, context, captionKey }: {
  caption?: MessageRichCaption;
  context: RenderContext;
  captionKey: string;
}) => caption ? (
  <figcaption>
    {renderRuns(caption.text, `${captionKey}:text`, context)}
    {caption.credit && caption.credit.length > 0 && (
      <cite>{renderRuns(caption.credit, `${captionKey}:credit`, context)}</cite>
    )}
  </figcaption>
) : null;

function RichMediaBlock({ media, context, blockKey }: {
  media: MessageRichMedia;
  context: RenderContext;
  blockKey: string;
}) {
  const [revealed, setRevealed] = useState(!media.hasSpoiler);
  const source = localSource(media.localPath);
  const poster = localSource(media.thumbnailPath) ?? media.previewDataUrl;
  const canDownload = media.fileId !== undefined && media.canDownload !== false && !media.isDownloaded;
  const style = media.width && media.height
    ? { "--rich-media-ratio": `${media.width} / ${media.height}` } as CSSProperties
    : undefined;
  const requestDownload = canDownload && media.fileId !== undefined
    ? () => void context.onDownload(media.fileId!, media.fileName)
    : undefined;

  let content: ReactNode;
  if (media.mediaType === "audio" || media.mediaType === "voice") {
    content = (
      <AudioPlayer
        source={source}
        playbackId={`${context.messageId}:${blockKey}`}
        label={media.fileName}
        fileId={media.fileId}
        size={media.size}
        mimeType={media.mimeType}
        downloadProgress={media.progress}
        onRequestStream={context.onStream}
        onDownload={requestDownload}
        onCancelDownload={media.isDownloading && media.fileId !== undefined
          ? () => void context.onCancelDownload(media.fileId!)
          : undefined}
      />
    );
  } else if (media.mediaType === "video") {
    content = (
      <VideoPlayer
        source={source}
        poster={poster}
        playbackId={`${context.messageId}:${blockKey}`}
        label={media.fileName}
        fileId={media.fileId}
        size={media.size}
        mimeType={media.mimeType}
        mediaWidth={media.width}
        mediaHeight={media.height}
        downloading={media.isDownloading}
        canDownload={canDownload}
        onDownload={requestDownload}
        onRequestStream={context.onStream}
        onSuspendStream={context.onSuspendStream}
        onLoadedMetadata={() => undefined}
        onError={() => undefined}
      />
    );
  } else if (source || poster) {
    const mediaSource = source ?? poster;
    content = media.mediaType === "animation" && /^video\//i.test(media.mimeType ?? "")
      ? <video src={mediaSource} poster={poster} autoPlay={media.autoplay} loop={media.loop} muted playsInline />
      : <img src={mediaSource} alt={media.fileName} loading="lazy" />;
  } else {
    content = (
      <button
        className="rich-media-placeholder"
        type="button"
        onClick={requestDownload}
        disabled={!requestDownload || media.isDownloading}
        aria-label={requestDownload ? `下载 ${media.fileName}` : media.fileName}
      >
        {media.isDownloading
          ? <LoaderCircle className="spin" size={24} />
          : requestDownload ? <Download size={24} /> : <ImageIcon size={24} />}
        <span>{media.fileName}</span>
        {media.sizeLabel && <small>{media.sizeLabel}</small>}
      </button>
    );
  }

  const mediaNode = media.url && safeHref(media.url)
    ? <a className="rich-media-link" href={media.url} target="_blank" rel="noreferrer">{content}</a>
    : content;
  return (
    <figure className={`rich-media-block rich-media-${media.mediaType}`} style={style}>
      <div className="rich-media-visual">
        {mediaNode}
        {!revealed && (
          <button className="rich-media-spoiler" type="button" onClick={() => setRevealed(true)}>
            显示媒体
          </button>
        )}
      </div>
      <Caption caption={media.caption} context={context} captionKey={`${blockKey}:caption`} />
    </figure>
  );
}

const renderCell = (cell: MessageRichTableCell, key: string, context: RenderContext) => {
  const props = {
    key,
    colSpan: cell.colspan,
    rowSpan: cell.rowspan,
    className: cell.visible ? undefined : "rich-table-cell-hidden",
    style: { textAlign: cell.align, verticalAlign: cell.valign } as CSSProperties,
  };
  return cell.header
    ? <th {...props}>{renderRuns(cell.text, key, context)}</th>
    : <td {...props}>{renderRuns(cell.text, key, context)}</td>;
};

const renderBlocks = (blocks: MessageRichBlock[], parentKey: string, context: RenderContext): ReactNode =>
  blocks.map((block, index) => {
    const key = `${parentKey}:block:${index}`;
    switch (block.kind) {
      case "heading":
        return createElement(`h${block.level}`, { key }, renderRuns(block.text, key, context));
      case "paragraph":
        return <p key={key}>{renderRuns(block.text, key, context)}</p>;
      case "preformatted":
        return <pre key={key}><code data-language={block.language}>{renderRuns(block.text, key, context)}</code></pre>;
      case "footer":
        return <footer key={key}>{renderRuns(block.text, key, context)}</footer>;
      case "thinking":
        return (
          <p key={key} className="rich-thinking">
            <LoaderCircle className="spin" size={15} />
            {renderRuns(block.text, key, context)}
          </p>
        );
      case "mathematicalExpression":
        return <MathExpression key={key} expression={block.expression} displayMode />;
      case "anchor":
        return <span key={key} id={scopedAnchor(context, "anchor", block.name)} />;
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        const listType = block.ordered ? block.items.find((item) => item.type)?.type : undefined;
        const checklist = block.items.some(({ hasCheckbox }) => hasCheckbox);
        return (
          <List key={key} type={listType} className={checklist ? "rich-checklist" : undefined}>
            {block.items.map((item, itemIndex) => (
              <li
                key={`${key}:item:${itemIndex}`}
                value={block.ordered ? item.value : undefined}
                className={item.label ? "has-rich-list-label" : undefined}
              >
                {item.label && <span className="rich-list-label">{item.label}</span>}
                {item.hasCheckbox && <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} />}
                <div className="rich-list-item-content">
                  {renderBlocks(item.blocks, `${key}:item:${itemIndex}`, context)}
                </div>
              </li>
            ))}
          </List>
        );
      }
      case "quote":
        return (
          <blockquote key={key} className={block.pull ? "rich-pull-quote" : undefined}>
            {renderBlocks(block.blocks, key, context)}
            {block.credit && block.credit.length > 0 && (
              <cite>{renderRuns(block.credit, `${key}:credit`, context)}</cite>
            )}
          </blockquote>
        );
      case "details":
        return (
          <details key={key} open={block.open}>
            <summary>{renderRuns(block.summary, `${key}:summary`, context)}</summary>
            {renderBlocks(block.blocks, key, context)}
          </details>
        );
      case "table":
        return (
          <table
            key={key}
            className={`${block.bordered ? "is-bordered" : ""} ${block.striped ? "is-striped" : ""}`.trim()}
          >
            {block.caption && block.caption.length > 0 && (
              <caption>{renderRuns(block.caption, `${key}:caption`, context)}</caption>
            )}
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}:row:${rowIndex}`}>
                  {row.map((cell, cellIndex) => renderCell(cell, `${key}:row:${rowIndex}:cell:${cellIndex}`, context))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case "media":
        return <RichMediaBlock key={key} media={block.media} context={context} blockKey={key} />;
      case "collection":
        return (
          <figure key={key} className={`rich-collection rich-${block.layout}`}>
            <div className="rich-collection-items">{renderBlocks(block.blocks, key, context)}</div>
            <Caption caption={block.caption} context={context} captionKey={`${key}:caption`} />
          </figure>
        );
      case "map": {
        const href = `https://www.openstreetmap.org/?mlat=${block.latitude}&mlon=${block.longitude}#map=${block.zoom}/${block.latitude}/${block.longitude}`;
        return (
          <figure key={key} className="rich-map-block">
            <a href={href} target="_blank" rel="noreferrer">
              <MapPin size={24} />
              <span>{block.latitude.toFixed(5)}, {block.longitude.toFixed(5)}</span>
            </a>
            <Caption caption={block.caption} context={context} captionKey={`${key}:caption`} />
          </figure>
        );
      }
      case "divider":
        return <hr key={key} />;
    }
  });

export function RichMessageContent({
  blocks,
  isRtl,
  isFull,
  messageId,
  onDownload,
  onCancelDownload,
  onStream,
  onSuspendStream,
}: RichMessageContentProps) {
  const context: RenderContext = {
    messageId,
    scope: `rich-message-${encodeURIComponent(messageId)}`,
    onDownload,
    onCancelDownload,
    onStream,
    onSuspendStream,
  };
  return (
    <div
      id={scopedAnchor(context, "anchor", "")}
      className="message-rich-text rich-message-content"
      data-rich-text="rich-message"
      data-rich-message-full={isFull ? "true" : "false"}
      dir={isRtl ? "rtl" : "auto"}
    >
      {renderBlocks(blocks, "rich-message", context)}
    </div>
  );
}
