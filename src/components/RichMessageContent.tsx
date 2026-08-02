import { createElement, Fragment, type ReactNode } from "react";
import type {
  MessageRichBlock,
  MessageRichTableCell,
  MessageRichTextRun,
} from "../telegram/types";

interface RichMessageContentProps {
  blocks: MessageRichBlock[];
  isRtl: boolean;
  isFull: boolean;
}

const safeHref = (value?: string) => {
  if (!value) return undefined;
  return /^(?:https?:|mailto:|tel:|tg:)/i.test(value) ? value : undefined;
};

const renderRun = (run: MessageRichTextRun, key: string) => {
  let node: ReactNode = run.text;
  if (run.code) node = <code>{node}</code>;
  if (run.bold) node = <strong>{node}</strong>;
  if (run.italic) node = <em>{node}</em>;
  if (run.underline) node = <u>{node}</u>;
  if (run.strikethrough) node = <del>{node}</del>;
  if (run.spoiler) node = <span className="rich-spoiler" tabIndex={0}>{node}</span>;
  if (run.subscript) node = <sub>{node}</sub>;
  if (run.superscript) node = <sup>{node}</sup>;
  if (run.marked) node = <mark>{node}</mark>;
  const href = safeHref(run.href);
  if (href) {
    node = (
      <a href={href} target={/^https?:/i.test(href) ? "_blank" : undefined} rel="noreferrer">
        {node}
      </a>
    );
  }
  return <Fragment key={key}>{node}</Fragment>;
};

const renderRuns = (runs: MessageRichTextRun[], key: string) =>
  runs.map((run, index) => renderRun(run, `${key}:run:${index}`));

const renderCell = (cell: MessageRichTableCell, key: string) => {
  const props = { key, colSpan: cell.colspan, rowSpan: cell.rowspan };
  return cell.header
    ? <th {...props}>{renderRuns(cell.text, key)}</th>
    : <td {...props}>{renderRuns(cell.text, key)}</td>;
};

const renderBlocks = (blocks: MessageRichBlock[], parentKey: string): ReactNode =>
  blocks.map((block, index) => {
    const key = `${parentKey}:block:${index}`;
    switch (block.kind) {
      case "heading":
        return createElement(`h${block.level}`, { key }, renderRuns(block.text, key));
      case "paragraph":
        return <p key={key}>{renderRuns(block.text, key)}</p>;
      case "preformatted":
        return (
          <pre key={key}>
            <code data-language={block.language}>{renderRuns(block.text, key)}</code>
          </pre>
        );
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        const checklist = block.items.some(({ hasCheckbox }) => hasCheckbox);
        return (
          <List key={key} className={checklist ? "rich-checklist" : undefined}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}:item:${itemIndex}`} value={block.ordered ? item.value : undefined}>
                {item.hasCheckbox && (
                  <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} />
                )}
                <div className="rich-list-item-content">
                  {renderBlocks(item.blocks, `${key}:item:${itemIndex}`)}
                </div>
              </li>
            ))}
          </List>
        );
      }
      case "quote":
        return (
          <blockquote key={key}>
            {renderBlocks(block.blocks, key)}
            {block.credit && block.credit.length > 0 && (
              <cite>{renderRuns(block.credit, `${key}:credit`)}</cite>
            )}
          </blockquote>
        );
      case "details":
        return (
          <details key={key} open={block.open}>
            <summary>{renderRuns(block.summary, `${key}:summary`)}</summary>
            {renderBlocks(block.blocks, key)}
          </details>
        );
      case "table":
        return (
          <table key={key}>
            {block.caption && block.caption.length > 0 && (
              <caption>{renderRuns(block.caption, `${key}:caption`)}</caption>
            )}
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}:row:${rowIndex}`}>
                  {row.map((cell, cellIndex) =>
                    renderCell(cell, `${key}:row:${rowIndex}:cell:${cellIndex}`))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case "divider":
        return <hr key={key} />;
    }
  });

export function RichMessageContent({ blocks, isRtl, isFull }: RichMessageContentProps) {
  return (
    <div
      className="message-rich-text rich-message-content"
      data-rich-text="rich-message"
      data-rich-message-full={isFull ? "true" : "false"}
      dir={isRtl ? "rtl" : "auto"}
    >
      {renderBlocks(blocks, "rich-message")}
    </div>
  );
}
