import { useEffect, useRef, type RefObject } from "react";
import { activeModal, isAvailableFocusTarget } from "../utils/focusPolicy";
import { internalAttachmentDrag, isCurrentAttachmentDrag, isInternalAttachmentDrag } from "../utils/attachmentDrag";

export function useAttachmentDragSwitch(
  sidebarRef: RefObject<HTMLElement | null>,
  accountId: string,
  folderId: string,
  activeChatId: string | undefined,
  onSelect: (chatId: string) => void,
) {
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    let target: HTMLElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(timer);
      timer = undefined;
      target?.removeAttribute("data-attachment-hover");
      target = undefined;
    };
    const available = (row: HTMLElement) => isAvailableFocusTarget(row) && !activeModal() &&
      !row.closest('[role="menu"], [role="dialog"]');
    const over = (event: DragEvent) => {
      const data = event.dataTransfer;
      const internal = data && internalAttachmentDrag(data);
      const attachment = data && (isInternalAttachmentDrag(data)
        ? internal?.accountId === accountId : data.types.includes("Files"));
      const row = event.target instanceof Element
        ? event.target.closest<HTMLElement>('.chat-list[data-active="true"] .chat-row[data-chat-id]') : null;
      if (!attachment || !row || !sidebar.contains(row) || !available(row)) { reset(); return; }
      event.preventDefault();
      // The sidebar changes destinations; files are released in the target conversation.
      data!.dropEffect = "none";
      if (target === row) return;
      reset();
      if (row.dataset.chatId === activeChatId) return;
      target = row;
      row.setAttribute("data-attachment-hover", "true");
      timer = setTimeout(() => {
        if (target === row && available(row) && (!internal || isCurrentAttachmentDrag(internal))) {
          selectRef.current(row.dataset.chatId!);
        }
        reset();
      }, 500);
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && target?.contains(event.relatedTarget)) return;
      reset();
    };
    const outside = (event: DragEvent) => { if (!(event.target instanceof Node) || !sidebar.contains(event.target)) reset(); };
    const drop = (event: DragEvent) => {
      if (event.dataTransfer && (isInternalAttachmentDrag(event.dataTransfer) || event.dataTransfer.types.includes("Files"))) {
        event.preventDefault();
      }
      reset();
    };
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") reset(); };
    sidebar.addEventListener("dragenter", over);
    sidebar.addEventListener("dragover", over);
    sidebar.addEventListener("dragleave", leave);
    sidebar.addEventListener("drop", drop);
    window.addEventListener("dragenter", outside, true);
    window.addEventListener("dragover", outside, true);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", cancel, true);
    return () => {
      reset();
      sidebar.removeEventListener("dragenter", over);
      sidebar.removeEventListener("dragover", over);
      sidebar.removeEventListener("dragleave", leave);
      sidebar.removeEventListener("drop", drop);
      window.removeEventListener("dragenter", outside, true);
      window.removeEventListener("dragover", outside, true);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [sidebarRef, accountId, folderId, activeChatId]);
}
