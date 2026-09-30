import { useEffect, useRef } from "react";
import type { Message } from "../telegram/types";

/** Overscan prepares media; only the actual viewport reports a channel view. */
export function useChannelMessageViews(
  root: HTMLElement | null,
  identity: string,
  chatId: string | undefined,
  messages: readonly Message[],
  enabled: boolean,
  view: (chatId: string, messageIds: string[]) => Promise<boolean>,
) {
  const acknowledged = useRef(new Set<string>());
  const postIdsKey = JSON.stringify(messages.filter(message => message.isChannelPost &&
    !message.isLocallyDeleted && !message.isRemoving &&
    message.delivery !== "sending" && message.delivery !== "failed").map(message => message.id));
  useEffect(() => { acknowledged.current = new Set(); }, [identity, enabled]);
  useEffect(() => {
    if (!enabled || !root || !chatId) return;
    const postIds = new Set<string>(JSON.parse(postIdsKey));
    const visibleIds = new Set<string>();
    const observed = new Set<Element>();
    const seen = acknowledged.current;
    let disposed = false;
    let frame: number | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      frame = undefined;
      if (disposed || document.visibilityState !== "visible") return;
      const bounds = root.getBoundingClientRect();
      const ids = [...visibleIds].filter(id => {
        if (!postIds.has(id) || seen.has(id)) return false;
        const row = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      if (!ids.length) return;
      ids.forEach(id => seen.add(id));
      void view(chatId, ids).catch(() => false).then(success => {
        if (success) return;
        ids.forEach(id => seen.delete(id));
        if (disposed) return;
        if (retry === undefined) retry = setTimeout(() => { retry = undefined; schedule(); }, 5_000);
      });
    };
    const schedule = () => { if (!disposed && frame === undefined) frame = requestAnimationFrame(flush); };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId;
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) visibleIds.add(id);
        else visibleIds.delete(id);
      }
      schedule();
    }, { root, threshold: 0.01 });
    const observeRows = () => {
      for (const element of observed) {
        if (root.contains(element)) continue;
        observer.unobserve(element);
        observed.delete(element);
        visibleIds.delete((element as HTMLElement).dataset.messageId!);
      }
      root.querySelectorAll<HTMLElement>("[data-message-id]").forEach(element => {
        if (!postIds.has(element.dataset.messageId!) || observed.has(element)) return;
        observed.add(element);
        observer.observe(element);
      });
    };
    const mutations = new MutationObserver(observeRows);
    mutations.observe(root, { childList: true, subtree: true });
    observeRows();
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus", schedule);
    return () => {
      disposed = true;
      observer.disconnect();
      mutations.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (retry !== undefined) clearTimeout(retry);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus", schedule);
    };
  }, [chatId, enabled, identity, postIdsKey, root, view]);
}
