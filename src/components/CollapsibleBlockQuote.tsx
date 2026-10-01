import { ChevronDown, ChevronUp } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { translate } from "../i18n";
import { usePreferencesStore } from "../store/preferencesStore";
import { observeLayout } from "../utils/layoutObservation";
import { useConversationGeometry } from "./ConversationSurface";
import { telegramStore } from "../store/telegramStore";

interface QuoteLayout { lineCount: number; collapsedHeight: number; fingerprint: string }
const quoteLayouts = new Map<string, Map<string, QuoteLayout>>();
let cachedCharacters = 0;
const rememberQuoteLayout = (source: string, key: string, layout: QuoteLayout) => {
  let variants = quoteLayouts.get(source);
  if (!variants) { variants = new Map(); cachedCharacters += source.length; }
  quoteLayouts.delete(source);
  variants.delete(key);
  variants.set(key, layout);
  if (variants.size > 8) variants.delete(variants.keys().next().value!);
  quoteLayouts.set(source, variants);
  while (quoteLayouts.size > 256 || cachedCharacters > 512_000) {
    const oldest = quoteLayouts.keys().next().value!;
    cachedCharacters -= oldest.length;
    quoteLayouts.delete(oldest);
  }
};
telegramStore.subscribe((state, previous) => {
  if (state.activeAccountId !== previous.activeAccountId) { quoteLayouts.clear(); cachedCharacters = 0; }
});

const COLLAPSED_QUOTE_LINES = 3.5;

export type ExpandQuoteHandler = (expand: () => void, quote: Element) => void;

export type CollapseQuoteHandler = (
  collapse: () => void,
  pointerClientY: number,
  getCollapsedAnchor: () => Element | null,
) => void;

export function CollapsibleBlockQuote({
  quoteText,
  layoutSource,
  resetKey,
  onExpand,
  onCollapse,
  children,
  as: Container = "span",
  className = "",
}: {
  quoteText?: string;
  layoutSource?: string;
  resetKey: string;
  onExpand?: ExpandQuoteHandler;
  onCollapse?: CollapseQuoteHandler;
  children: ReactNode;
  as?: "span" | "blockquote";
  className?: string;
}) {
  const Content = Container === "span" ? "span" : "div";
  const contentRef = useRef<HTMLElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const threshold = usePreferencesStore((state) => state.quoteCollapseLines);
  const geometry = useConversationGeometry();
  const layoutContext = `${geometry.key}:${geometry.width}:${threshold}`;
  const source = layoutSource ?? quoteText ?? resetKey;
  const cachedLayout = quoteLayouts.get(source)?.get(layoutContext);
  const [lineCount, setLineCount] = useState(cachedLayout?.lineCount ?? 0);
  const [collapsedHeight, setCollapsedHeight] = useState(cachedLayout?.collapsedHeight ?? 0);
  const [expanded, setExpanded] = useState(false);
  const collapsible = lineCount > threshold;
  const collapsed = collapsible && !expanded;

  useLayoutEffect(() => {
    setExpanded(false);
  }, [resetKey]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const computed = getComputedStyle(content);
      const parsedLineHeight = Number.parseFloat(computed.lineHeight);
      const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : Number.parseFloat(computed.fontSize) * 1.48;
      const fingerprint = `${layoutContext}:${content.getBoundingClientRect().width}:${computed.font}:${computed.lineHeight}:${content.innerHTML}`;
      const cached = quoteLayouts.get(source)?.get(layoutContext);
      if (cached?.fingerprint === fingerprint) {
        setLineCount(current => current === cached.lineCount ? current : cached.lineCount);
        setCollapsedHeight(current => Math.abs(current - cached.collapsedHeight) < 0.25 ? current : cached.collapsedHeight);
        return;
      }
      const range = document.createRange();
      const lineTops: number[] = [];
      // Block rectangles (paragraphs, lists) are containers, not additional text lines.
      const textNodes = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (!lineTops.some((top) => Math.abs(top - rect.top) < 1.5)) lineTops.push(rect.top);
        }
      }
      const nextLineCount = Math.max(
        lineTops.length,
        Math.round(content.scrollHeight / lineHeight),
      );
      setLineCount((current) => current === nextLineCount ? current : nextLineCount);
      // A low threshold must still hide content when the quote is collapsed.
      const nextCollapsedHeight = lineHeight * Math.min(COLLAPSED_QUOTE_LINES, threshold);
      const nextLayout = { lineCount: nextLineCount, collapsedHeight: nextCollapsedHeight, fingerprint };
      rememberQuoteLayout(source, layoutContext, nextLayout);
      setCollapsedHeight((current) => Math.abs(current - nextCollapsedHeight) < 0.25
        ? current
        : nextCollapsedHeight);
    };
    measure();
    return observeLayout(content, measure);
  }, [layoutContext, source]);

  const preview = quoteText?.replace(/\s+/g, " ").trim().slice(0, 120);
  return (
    <Container
      className={`rich-blockquote ${collapsed ? "is-collapsed" : ""} ${collapsible && expanded ? "is-expanded" : ""} ${className}`}
      data-quote-line-count={lineCount || undefined}
      data-quote-state={collapsible ? (expanded ? "expanded" : "collapsed") : "static"}
      style={{
        "--collapsed-quote-height": `${collapsedHeight}px`,
      } as CSSProperties}
    >
      <Content
        ref={(element) => { contentRef.current = element; }}
        className="rich-blockquote-content"
        inert={collapsed ? true : undefined}
      >
        {children}
      </Content>
      {collapsed && (
        <button
          ref={expandButtonRef}
          className="rich-blockquote-expand"
          type="button"
          aria-label={preview ? translate("展开引用：{{value0}}", { value0: preview }) : translate("展开引用")}
          title={translate("展开引用")}
          onClick={(event) => {
            const expand = () => setExpanded(true);
            const quote = event.currentTarget.parentElement;
            if (onExpand && quote) onExpand(expand, quote);
            else expand();
          }}
        >
          <span className="rich-blockquote-fade" aria-hidden="true" />
          <ChevronDown size={17} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
      {collapsible && expanded && (
        <button
          className="rich-blockquote-collapse"
          type="button"
          aria-label={translate("收起引用")}
          title={translate("收起引用")}
          onClick={(event) => {
            const buttonBounds = event.currentTarget.getBoundingClientRect();
            const pointerClientY = event.detail > 0
              ? event.clientY
              : (buttonBounds.top + buttonBounds.bottom) / 2;
            const collapse = () => setExpanded(false);
            const getCollapsedAnchor = () =>
              expandButtonRef.current?.querySelector("svg") ?? expandButtonRef.current;
            if (onCollapse) onCollapse(collapse, pointerClientY, getCollapsedAnchor);
            else collapse();
          }}
        >
          <ChevronUp size={17} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </Container>
  );
}
