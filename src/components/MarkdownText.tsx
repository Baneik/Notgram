import { translate } from "../i18n";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, memo, useMemo, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { handleExternalLinkClick, safeExternalHref as safeHref } from "../utils/externalLinks";
import { highlightTextNodes } from "../utils/textHighlight";
import { CollapsibleBlockQuote, type CollapseQuoteHandler } from "./CollapsibleBlockQuote";

interface MarkdownTextProps {
  text: string;
  className: string;
  highlightQuery?: string;
  onCollapseQuote?: CollapseQuoteHandler;
}

function MarkdownText({ text, className, highlightQuery, onCollapseQuote }: MarkdownTextProps) {
  useTranslation();
  const highlight = (children: ReactNode) => highlightTextNodes(children, highlightQuery);
  const components = useMemo<Components>(() => ({
    a: ({ children, href }) => {
      const safe = safeHref(href);
      return safe
        ? <a href={safe} target="_blank" rel="noreferrer" onClick={handleExternalLinkClick}>{highlight(children)}</a>
        : <>{highlight(children)}</>;
    },
    img: ({ alt }) => <span className="rich-image-alt">{alt || translate("图片")}</span>,
    p: ({ children }) => <p>{highlight(children)}</p>,
    h1: ({ children }) => <h1>{highlight(children)}</h1>,
    h2: ({ children }) => <h2>{highlight(children)}</h2>,
    h3: ({ children }) => <h3>{highlight(children)}</h3>,
    h4: ({ children }) => <h4>{highlight(children)}</h4>,
    h5: ({ children }) => <h5>{highlight(children)}</h5>,
    h6: ({ children }) => <h6>{highlight(children)}</h6>,
    li: ({ children }) => <li>{highlight(children)}</li>,
    // Ignore parser separators between blocks; pre-wrap would turn them into empty preview lines.
    blockquote: ({ children }) => (
      <CollapsibleBlockQuote as="blockquote" resetKey={text} onCollapse={onCollapseQuote}>
        {highlight(Children.toArray(children).filter((child) => typeof child !== "string" || child.trim()))}
      </CollapsibleBlockQuote>
    ),
    td: ({ children }) => <td>{highlight(children)}</td>,
    th: ({ children }) => <th>{highlight(children)}</th>,
    pre: ({ children }) => <pre>{highlight(children)}</pre>,
  }), [text, highlightQuery, onCollapseQuote]);
  return (
    <div className={`message-rich-text ${className}`} data-rich-text="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeHref(url) ?? ""}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

export default memo(MarkdownText);
