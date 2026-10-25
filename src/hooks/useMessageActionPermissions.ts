import { useCallback, useEffect, useRef, useState } from "react";
import { telegramStore, useTelegramStore } from "../store/telegramStore";
import type { TelegramState } from "../store/telegramStore.types";
import { connectionPresentation } from "../telegram/connectionState";
import type { Message } from "../telegram/types";
import { loadMessageActionPermissions } from "../utils/messageActionPermissions";
import { chatMessagePermissionRevision } from "../utils/messagePermissionRevision";

const PERMISSION_TIMEOUT_MS = 10_000;
export type MessagePermissionStatus = "loading" | "ready" | "unavailable" | "retryable";

// Owned by the mounted menu, so closing it cancels retries as well as UI writes.
export function useMessageActionPermissions(message: Message, load: TelegramState["loadMessageProperties"]) {
  const accountId = useTelegramStore(state => state.activeAccountId);
  const operational = useTelegramStore(state => connectionPresentation(state.connectionStatus).operational);
  const { chatId, id: messageId, isLocallyDeleted } = message;
  const chatRevision = useTelegramStore(state => chatMessagePermissionRevision(state.chats.get(chatId)));
  const [phase, setPhase] = useState<MessagePermissionStatus>(message.permissions ? "ready" : "loading");
  const pendingRef = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

  const request = useCallback((force = false) => {
    if (pendingRef.current || !operational || isLocallyDeleted) return;
    const getCurrentMessage = () => telegramStore.getState().activeAccountId === accountId
      ? telegramStore.getState().messages.get(chatId)?.find(candidate => candidate.id === messageId)
      : undefined;
    // A live update can reach the store before React commits the message prop.
    const initialMessage = getCurrentMessage();
    if (!initialMessage || initialMessage.isLocallyDeleted) {
      setPhase("retryable");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (pendingRef.current?.controller !== controller) return;
      controller.abort();
      pendingRef.current = undefined;
      setPhase("retryable");
    }, PERMISSION_TIMEOUT_MS);
    pendingRef.current = { controller, timer };
    setPhase("loading");
    void loadMessageActionPermissions({ chatId, messageId, initialMessage, getCurrentMessage, load, force, signal: controller.signal })
      .then(permissions => {
        if (!controller.signal.aborted) setPhase(permissions ? "ready" : "retryable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setPhase("retryable");
      })
      .finally(() => {
        clearTimeout(timer);
        if (pendingRef.current?.controller === controller) pendingRef.current = undefined;
      });
  }, [accountId, chatId, messageId, operational, isLocallyDeleted, load, chatRevision]);

  useEffect(() => {
    // Skip the discarded StrictMode mount before issuing a native request.
    let disposed = false;
    queueMicrotask(() => { if (!disposed) request(); });
    return () => {
      disposed = true;
      const pending = pendingRef.current;
      pendingRef.current = undefined;
      pending?.controller.abort();
      if (pending) clearTimeout(pending.timer);
    };
  }, [request]);

  const hasPermissions = Boolean(message.permissions);
  const previouslyHadPermissions = useRef(hasPermissions);
  useEffect(() => {
    const invalidated = previouslyHadPermissions.current && !hasPermissions;
    previouslyHadPermissions.current = hasPermissions;
    // Refresh once if a live update invalidates an already usable open menu.
    // Ordinary failures and repeated permission-less updates do not start loops.
    if (invalidated) request();
  }, [hasPermissions, request]);

  const status: MessagePermissionStatus = hasPermissions ? "ready"
    : !operational ? "unavailable" : phase === "ready" ? "retryable" : phase;
  return { status, loading: !hasPermissions && operational && !isLocallyDeleted && phase === "loading", retry: () => request(true) };
}
