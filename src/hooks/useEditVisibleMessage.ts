import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ComposerInputElement } from "../components/ComposerInput";
import { isEditableMessageContent } from "../telegram/messageContent";
import type { Message, MessagePermissions } from "../telegram/types";

export function useEditVisibleMessage(
  inputRef: RefObject<ComposerInputElement | null>,
  viewportRef: RefObject<HTMLElement | null>,
  messages: readonly Message[],
  identity: string,
  loadPermissions: (chatId: string, messageId: string, force?: boolean, signal?: AbortSignal) => Promise<MessagePermissions | undefined>,
  onEdit: (message: Message) => void,
) {
  const current = useRef({ messages, onEdit });
  current.current = { messages, onEdit };
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [identity]);
  return useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const input = inputRef.current;
    const viewport = viewportRef.current;
    if (!input || !viewport || input.value) return;
    const visibleIds = () => {
      const bounds = viewport.getBoundingClientRect();
      return new Set([...viewport.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => {
        const rect = row.getBoundingClientRect();
        return !row.closest("[inert], [aria-hidden='true']") && rect.height > 0 &&
          rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(window.innerHeight, bounds.bottom);
      }).map(row => row.dataset.messageId));
    };
    const visible = visibleIds();
    const candidates = [...current.current.messages].reverse().filter(message =>
      visible.has(message.id) && message.outgoing && isEditableMessageContent(message.content) &&
      message.permissions?.canEdit !== false && !message.isLocallyDeleted && !message.isRemoving && !message.isPending);
    // Any subsequent input/scroll/navigation revokes the asynchronous edit intent.
    const cancel = () => controller.abort();
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("pointerdown", cancel, true);
    input.addEventListener("input", cancel);
    viewport.addEventListener("scroll", cancel);
    const cleanup = () => {
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("pointerdown", cancel, true);
      input.removeEventListener("input", cancel);
      viewport.removeEventListener("scroll", cancel);
    };
    controller.signal.addEventListener("abort", cleanup, { once: true });
    void (async () => {
      for (const message of candidates) {
        const permissions = message.permissions ?? await loadPermissions(message.chatId, message.id, false, controller.signal);
        if (controller.signal.aborted || !input.isConnected || inputRef.current !== input || input.value ||
          document.activeElement !== input) return;
        const latest = current.current.messages.find(candidate => candidate.id === message.id);
        if (!latest || latest.isLocallyDeleted || latest.isRemoving || !visibleIds().has(message.id)) continue;
        if (permissions?.canEdit) { current.current.onEdit({ ...latest, permissions }); return; }
      }
    })().catch(() => undefined).finally(cleanup);
  }, [identity, inputRef, loadPermissions, viewportRef]);
}
