import { useEffect } from "react";
import { conversationActivityStore } from "../store/conversationActivity";

const ACTIVE_DURATION_FLUSH_MS = 15_000;

export const useConversationActivityTracker = (
  accountId: string,
  chatId?: string,
  enabled = true,
) => {
  useEffect(() => {
    if (!accountId || !chatId || !enabled) return;
    let activeSince: number | undefined;

    const flush = () => {
      if (activeSince === undefined) return;
      const now = Date.now();
      conversationActivityStore.getState().addActiveDuration(accountId, chatId, now - activeSince);
      activeSince = now;
    };
    const updateTracking = () => {
      const active = document.visibilityState === "visible" && document.hasFocus();
      if (active && activeSince === undefined) activeSince = Date.now();
      else if (!active && activeSince !== undefined) {
        flush();
        activeSince = undefined;
      }
    };

    updateTracking();
    const interval = globalThis.setInterval(flush, ACTIVE_DURATION_FLUSH_MS);
    document.addEventListener("visibilitychange", updateTracking);
    globalThis.addEventListener("focus", updateTracking);
    globalThis.addEventListener("blur", updateTracking);
    return () => {
      globalThis.clearInterval(interval);
      document.removeEventListener("visibilitychange", updateTracking);
      globalThis.removeEventListener("focus", updateTracking);
      globalThis.removeEventListener("blur", updateTracking);
      flush();
    };
  }, [accountId, chatId, enabled]);
};
