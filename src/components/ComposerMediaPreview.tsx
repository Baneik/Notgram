import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import type { OutgoingAttachmentKind } from "../telegram/types";
import { StableImage } from "./StableImage";

export interface ComposerMediaPreviewItem {
  id: string;
  name: string;
  size: number;
  kind: OutgoingAttachmentKind;
  previewUrl: string;
}

interface ComposerMediaPreviewProps {
  items: ComposerMediaPreviewItem[];
  activeId: string;
  onActiveChange: (id: string) => void;
  onClose: () => void;
}

const sizeLabel = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export function ComposerMediaPreview({
  items,
  activeId,
  onActiveChange,
  onClose,
}: ComposerMediaPreviewProps) {
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const active = items[activeIndex];
  const previous = activeIndex > 0 ? items[activeIndex - 1] : undefined;
  const next = activeIndex >= 0 && activeIndex < items.length - 1
    ? items[activeIndex + 1]
    : undefined;
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && previous) {
        event.preventDefault();
        onActiveChange(previous.id);
      } else if (event.key === "ArrowRight" && next) {
        event.preventDefault();
        onActiveChange(next.id);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [next, onActiveChange, previous]);

  if (!active) return null;

  return createPortal(
    <div
      className="composer-media-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="composer-media-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`附件预览：${active.name}`}
        tabIndex={-1}
      >
        <header>
          <span>{activeIndex + 1} / {items.length}</span>
          <button type="button" aria-label="关闭附件预览" title="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <main>
          {active.kind === "video" ? (
            <video key={active.id} src={active.previewUrl} controls playsInline preload="metadata" />
          ) : (
            <StableImage src={active.previewUrl} alt={active.name} decoding="async" />
          )}
          {previous && (
            <button
              className="composer-media-preview-nav is-previous"
              type="button"
              aria-label="上一个附件"
              title="上一个附件"
              onClick={() => onActiveChange(previous.id)}
            >
              <ChevronLeft size={30} />
            </button>
          )}
          {next && (
            <button
              className="composer-media-preview-nav is-next"
              type="button"
              aria-label="下一个附件"
              title="下一个附件"
              onClick={() => onActiveChange(next.id)}
            >
              <ChevronRight size={30} />
            </button>
          )}
        </main>
        <footer>
          <strong>{active.name}</strong>
          <span>{active.kind === "video" ? "视频" : active.kind === "animation" ? "GIF" : "图片"} · {sizeLabel(active.size)}</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
