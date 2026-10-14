import { useEffect, useState, type RefObject } from "react";
import { activeModal, isAvailableFocusTarget } from "../utils/focusPolicy";

/** Share file drops across a composer scope without claiming nested discussions or text drags. */
export function useConversationFileDrop(
  composerRef: RefObject<HTMLDivElement | null>,
  scopeKey: string,
  enabled: boolean,
  onDrop: (files: File[]) => void,
) {
  const [fileCount, setFileCount] = useState(0);

  useEffect(() => {
    const wrap = composerRef.current?.closest<HTMLElement>(".composer-wrap");
    const scope = wrap?.closest<HTMLElement>("[data-composer-scope]") ?? wrap;
    let dragging = false;
    const reset = () => { dragging = false; setFileCount(0); };
    reset();
    if (!scope || !wrap) return;

    const ownsTarget = (target: EventTarget | null) => target instanceof Element &&
      scope.contains(target) && (target.closest("[data-composer-scope]") ?? wrap) === scope;
    const canReceive = (target: EventTarget | null) => enabled && isAvailableFocusTarget(wrap) &&
      !activeModal() && target instanceof Element && !target.closest('[inert], [role="dialog"], [role="menu"]');
    const isFileDrag = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const showPreview = (event: DragEvent) => {
      if (!isFileDrag(event) || !ownsTarget(event.target)) return;
      event.preventDefault();
      if (!canReceive(event.target)) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        reset();
        return;
      }
      event.dataTransfer!.dropEffect = "copy";
      // Protected drag data exposes item kinds/counts, but files are only read on drop.
      const count = Array.from(event.dataTransfer!.items).filter(item => item.kind === "file").length;
      dragging = true;
      setFileCount(Math.max(1, count));
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && scope.contains(event.relatedTarget)) return;
      // A newly expanded tray can replace the hovered node with no relatedTarget.
      const hovered = document.elementFromPoint(event.clientX, event.clientY);
      if (!event.relatedTarget && hovered && ownsTarget(hovered)) return;
      reset();
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event) || !ownsTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = canReceive(event.target) ? Array.from(event.dataTransfer!.files) : [];
      reset();
      if (files.length > 0) onDrop(files);
    };
    const outside = (event: DragEvent) => {
      if (!ownsTarget(event.target)) reset();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragging) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
    };

    scope.addEventListener("dragenter", showPreview);
    scope.addEventListener("dragover", showPreview);
    scope.addEventListener("dragleave", leave);
    // Capture before the rich editor can interpret file URL/text fallbacks.
    scope.addEventListener("drop", drop, true);
    window.addEventListener("dragenter", outside, true);
    window.addEventListener("dragover", outside, true);
    // Keep an owned drop target mounted until the scope has captured its files.
    window.addEventListener("drop", outside, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", cancel, true);
    return () => {
      scope.removeEventListener("dragenter", showPreview);
      scope.removeEventListener("dragover", showPreview);
      scope.removeEventListener("dragleave", leave);
      scope.removeEventListener("drop", drop, true);
      window.removeEventListener("dragenter", outside, true);
      window.removeEventListener("dragover", outside, true);
      window.removeEventListener("drop", outside, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [composerRef, scopeKey, enabled, onDrop]);

  return fileCount;
}
