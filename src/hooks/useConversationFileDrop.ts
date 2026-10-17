import { useEffect, useState, type RefObject } from "react";
import { activeModal, isAvailableFocusTarget } from "../utils/focusPolicy";
import { internalAttachmentDrag, isInternalAttachmentDrag, ownsAttachmentDrag, startAttachmentDrag } from "../utils/attachmentDrag";
import { readComposerDroppedImage } from "../utils/composerDrop";

/** Share file drops across a composer scope without claiming nested discussions or text drags. */
export function useConversationFileDrop(
  composerRef: RefObject<HTMLDivElement | null>,
  accountId: string,
  draftKey: string,
  enabled: boolean,
  onDrop: (files: File[]) => void,
  onError: () => void,
) {
  const [fileCount, setFileCount] = useState(0);

  useEffect(() => {
    const wrap = composerRef.current?.closest<HTMLElement>(".composer-wrap");
    const scope = wrap?.closest<HTMLElement>("[data-composer-scope]") ?? wrap;
    let dragging = false;
    let fileDragInWindow = false;
    const reads = new Set<AbortController>();
    const reset = () => { dragging = false; setFileCount(0); };
    const finish = () => { fileDragInWindow = false; reset(); };
    reset();
    if (!scope || !wrap) return;

    const ownsTarget = (target: EventTarget | null) => target instanceof Element &&
      scope.contains(target) && (target.closest("[data-composer-scope]") ?? wrap) === scope;
    const canReceive = (target: EventTarget | null) => enabled && isAvailableFocusTarget(wrap) &&
      !activeModal() && target instanceof Element && !target.closest('[inert], [role="dialog"], [role="menu"]');
    const isFileDrag = (event: DragEvent) => event.dataTransfer &&
      (isInternalAttachmentDrag(event.dataTransfer) || event.dataTransfer.types.includes("Files"));
    const acceptsSource = (data: DataTransfer) => {
      if (!isInternalAttachmentDrag(data)) return true;
      const source = internalAttachmentDrag(data);
      return source?.accountId === accountId && source.draftKey !== draftKey;
    };
    const startImageDrag = (event: DragEvent) => {
      if (!ownsTarget(event.target) || !(event.target instanceof HTMLImageElement) || !event.dataTransfer ||
        event.defaultPrevented || isInternalAttachmentDrag(event.dataTransfer)) return;
      const imageSource = event.target.currentSrc || event.target.src;
      startAttachmentDrag(event.dataTransfer, draftKey, signal => readComposerDroppedImage(imageSource, signal));
    };
    const showPreview = (event: DragEvent) => {
      if (!isFileDrag(event) || !ownsTarget(event.target)) return;
      event.preventDefault();
      if (!canReceive(event.target) || !acceptsSource(event.dataTransfer!)) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        reset();
        return;
      }
      event.dataTransfer!.dropEffect = "copy";
      // Protected drag data exposes item kinds/counts, but files are only read on drop.
      const count = isInternalAttachmentDrag(event.dataTransfer!) ? 1 :
        Array.from(event.dataTransfer!.items).filter(item => item.kind === "file").length;
      dragging = true;
      setFileCount(Math.max(1, count));
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && scope.contains(event.relatedTarget)) return;
      // Appending placeholders to an existing tray can replace the hovered node.
      const hovered = document.elementFromPoint(event.clientX, event.clientY);
      if (!event.relatedTarget && hovered && ownsTarget(hovered)) return;
      if (!event.relatedTarget && !hovered) fileDragInWindow = false;
      reset();
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event) || !ownsTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const data = event.dataTransfer!;
      const accepted = canReceive(event.target) && acceptsSource(data);
      const source = internalAttachmentDrag(data);
      const files = accepted && !isInternalAttachmentDrag(data) ? Array.from(data.files) : [];
      reset();
      if (files.length > 0) onDrop(files);
      if (accepted && source && ownsAttachmentDrag(data, source)) {
        const controller = new AbortController();
        reads.add(controller);
        void source.read(controller.signal).then(file => {
          if (!controller.signal.aborted && canReceive(scope)) onDrop([file]);
        }).catch(() => {
          if (!controller.signal.aborted) onError();
        }).finally(() => reads.delete(controller));
      }
    };
    const outside = (event: DragEvent) => {
      if (!ownsTarget(event.target)) reset();
      // Escape still belongs to the drag while the pointer is over the sidebar.
      fileDragInWindow = event.type !== "drop" && Boolean(isFileDrag(event));
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!dragging && !fileDragInWindow) || activeModal()) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };

    // Observe after React's message handlers have rejected protected drags.
    window.addEventListener("dragstart", startImageDrag);
    scope.addEventListener("dragenter", showPreview);
    scope.addEventListener("dragover", showPreview);
    scope.addEventListener("dragleave", leave);
    // Capture before the rich editor can interpret file URL/text fallbacks.
    scope.addEventListener("drop", drop, true);
    window.addEventListener("dragenter", outside, true);
    window.addEventListener("dragover", outside, true);
    // Keep an owned drop target mounted until the scope has captured its files.
    window.addEventListener("drop", outside, true);
    window.addEventListener("dragend", finish);
    window.addEventListener("blur", finish);
    window.addEventListener("keydown", cancel, true);
    return () => {
      for (const controller of reads) controller.abort();
      window.removeEventListener("dragstart", startImageDrag);
      scope.removeEventListener("dragenter", showPreview);
      scope.removeEventListener("dragover", showPreview);
      scope.removeEventListener("dragleave", leave);
      scope.removeEventListener("drop", drop, true);
      window.removeEventListener("dragenter", outside, true);
      window.removeEventListener("dragover", outside, true);
      window.removeEventListener("drop", outside, true);
      window.removeEventListener("dragend", finish);
      window.removeEventListener("blur", finish);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [composerRef, accountId, draftKey, enabled, onDrop, onError]);

  return fileCount;
}
