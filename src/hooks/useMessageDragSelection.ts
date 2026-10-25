import { useEffect, useRef } from "react";
import type { Message } from "../telegram/types";
import { conversationScrollWriter, writeConversationScrollTop } from "../utils/conversationTrace";
import { isSelectableMessage } from "../utils/messageSelection";

interface DragSelectionOptions {
  identity: string | undefined;
  list: HTMLElement | null;
  enabled: boolean;
  messages: Message[];
  selectedIds: ReadonlySet<string>;
  selectionMode: boolean;
  startSelection: () => void;
  selectMessages: (messages: Message[], baseIds?: ReadonlySet<string>) => void;
}

// The shell includes text padding, captions, media and inline keyboards. A drag
// starting anywhere inside it must remain owned by the native content gesture.
const contentSelector = ".message-bubble-shell, .message-sender-avatar, .channel-discussion-post, button, a, input, textarea, select, video, audio, [role='button'], [contenteditable], [draggable='true'], [inert]";

export function useMessageDragSelection(options: DragSelectionOptions) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const { list, enabled } = options;
    if (!list || !enabled) return;
    let drag: { pointerId: number; anchorId: string; x: number; y: number; lastY: number; active: boolean; baseIds: ReadonlySet<string> } | undefined;
    let frame: number | undefined;
    let suppressClick = false;
    const messageAt = (y: number) => {
      let closest: string | undefined;
      let distance = Infinity;
      const available = new Set(latest.current.messages.filter(isSelectableMessage).map(message => message.id));
      for (const row of list.querySelectorAll<HTMLElement>(".message-row[data-message-id]")) {
        const id = row.dataset.messageId!;
        if (row.matches(".is-removing") || row.closest(".channel-discussion-post")) continue;
        const bounds = row.getBoundingClientRect();
        const nextDistance = Math.max(bounds.top - y, y - bounds.bottom, 0);
        if (nextDistance < distance) { closest = id; distance = nextDistance; }
      }
      return closest && available.has(closest) ? closest : undefined;
    };
    const update = (y: number) => {
      if (!drag) return;
      const messages = latest.current.messages;
      const anchor = messages.findIndex(message => message.id === drag!.anchorId);
      const endId = messageAt(y);
      const end = messages.findIndex(message => message.id === endId);
      if (anchor < 0 || end < 0) return;
      const range = messages.slice(Math.min(anchor, end), Math.max(anchor, end) + 1).filter(isSelectableMessage);
      if (anchor > end) range.reverse();
      if (!drag.active && range.length < (latest.current.selectionMode ? 1 : 2)) return;
      if (!drag.active) {
        drag.active = true;
        if (!latest.current.selectionMode) latest.current.startSelection();
        list.classList.add("is-drag-selecting-messages");
        globalThis.getSelection()?.removeAllRanges();
      }
      latest.current.selectMessages(range, drag.baseIds);
    };
    const tick = () => {
      frame = undefined;
      if (!drag?.active) return;
      const bounds = list.getBoundingClientRect();
      const edge = 32;
      const offset = drag.lastY < bounds.top + edge ? drag.lastY - bounds.top - edge
        : drag.lastY > bounds.bottom - edge ? drag.lastY - bounds.bottom + edge : 0;
      if (!offset) return;
      const before = list.scrollTop;
      writeConversationScrollTop(list, before + Math.sign(offset) * Math.min(24, Math.max(2, Math.abs(offset) * 0.3)), conversationScrollWriter.selection);
      update(Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, drag.lastY)));
      if (before !== list.scrollTop) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (drag?.active) suppressClick = true;
      drag = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      list.classList.remove("is-drag-selecting-messages");
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      const target = event.target instanceof Element ? event.target : undefined;
      if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey || event.altKey ||
        !target || !list.contains(target) || target.closest(contentSelector) || list.closest("[inert]")) return;
      const bounds = list.getBoundingClientRect();
      // The scrollbar is also blank, but owns its own native drag gesture.
      const scale = list.offsetWidth > 0 ? bounds.width / list.offsetWidth : 1;
      if (event.clientX >= bounds.left + (list.clientLeft + list.clientWidth) * scale) return;
      const anchorId = messageAt(event.clientY);
      if (!anchorId) return;
      drag = { pointerId: event.pointerId, anchorId, x: event.clientX, y: event.clientY, lastY: event.clientY,
        active: false, baseIds: latest.current.selectedIds };
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { stop(); return; }
      drag.lastY = event.clientY;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      event.preventDefault();
      update(event.clientY);
      if (drag?.active && frame === undefined) frame = requestAnimationFrame(tick);
    };
    const up = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) stop(); };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", stop);
    };
  }, [options.identity, options.list, options.enabled]);
}
