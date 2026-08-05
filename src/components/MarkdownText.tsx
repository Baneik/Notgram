import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { handleExternalLinkClick, safeExternalHref as safeHref } from "../utils/externalLinks";

interface MarkdownTextProps {
  text: string;
  className: string;
}

export default function MarkdownText({ text, className }: MarkdownTextProps) {
  return (
    <div className={`message-rich-text ${className}`} data-rich-text="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeHref(url) ?? ""}
        components={{
          a: ({ children, href }) => {
            const safe = safeHref(href);
            return safe
              ? <a href={safe} target="_blank" rel="noreferrer" onClick={handleExternalLinkClick}>{children}</a>
              : <>{children}</>;
          },
          img: ({ alt }) => <span className="rich-image-alt">{alt || "图片"}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
