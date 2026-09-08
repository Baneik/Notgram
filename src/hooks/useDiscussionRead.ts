import { useEffect, useRef, type RefObject } from "react";
import type { Message } from "../telegram/types";

export function useDiscussionRead(
  scroller: RefObject<HTMLDivElement | null>,
  identity: string,
  chatId: string,
  comments: readonly Message[],
  enabled: boolean,
  markRead: (chatId: string, ids: string[]) => Promise<boolean>,
) {
  const acknowledged = useRef(new Set<string>());
  useEffect(() => { acknowledged.current = new Set(); }, [identity]);
  useEffect(() => {
    const root = scroller.current;
    if (!enabled || !root || typeof IntersectionObserver === "undefined") return;
    let disposed = false;
    const incomingIds = new Set(comments.filter(message => !message.outgoing).map(message => message.id));
    const visibleIds = new Set<string>();
    const seen = acknowledged.current;
    const flush = () => {
      if (disposed || document.visibilityState !== "visible") return;
      const ids = [...visibleIds].filter(id => incomingIds.has(id) && !seen.has(id));
      if (!ids.length) return;
      ids.forEach(id => seen.add(id));
      void markRead(chatId, ids).then(success => { if (!success) ids.forEach(id => seen.delete(id)); })
        .catch(() => ids.forEach(id => seen.delete(id)));
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId;
        if (!id) continue;
        if (entry.isIntersecting) visibleIds.add(id);
        else visibleIds.delete(id);
      }
      flush();
    }, { root, threshold: 0.01 });
    root.querySelectorAll<HTMLElement>(".channel-discussion-message-group [data-message-id]").forEach(element => observer.observe(element));
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("focus", flush);
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("focus", flush);
    };
  }, [chatId, comments, enabled, identity, markRead, scroller]);
}
