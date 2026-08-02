import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownTextProps {
  text: string;
  className: string;
}

const safeHref = (value?: string) =>
  value && /^(?:https?:|mailto:|tel:|tg:)/i.test(value) ? value : undefined;

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
              ? <a href={safe} target={/^https?:/i.test(safe) ? "_blank" : undefined} rel="noreferrer">{children}</a>
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
