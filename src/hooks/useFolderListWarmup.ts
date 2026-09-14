import { useEffect } from "react";
import { telegramStore, useTelegramStore } from "../store/telegramStore";
import type { ChatFolder } from "../telegram/types";
import { useDocumentVisibility } from "./useDocumentVisibility";

/** Mounting hidden panels must not let their fill-to-viewport effects drain every page. */
export function useFolderListWarmup(accountId: string, folders: ChatFolder[]) {
  const ready = useTelegramStore((state) => state.authorization.kind === "ready");
  const online = useTelegramStore((state) => state.connectionStatus === "online");
  const chatLists = useTelegramStore((state) => state.chatLists);
  const visible = useDocumentVisibility();
  const folderIdsKey = JSON.stringify(folders.map((folder) => folder.id).filter((id) => id !== "main").sort());
  useEffect(() => {
    if (!ready || !online || !visible) return;
    const timer = globalThis.setTimeout(() => {
      const current = telegramStore.getState();
      if (current.chatLists.get(current.chatFilter)?.loading) return;
      for (const folderId of JSON.parse(folderIdsKey) as string[]) {
        const state = telegramStore.getState();
        if (state.activeAccountId !== accountId || state.authorization.kind !== "ready" ||
          state.connectionStatus !== "online") return;
        // Count store-owned requests so StrictMode, metadata changes and remounts share the limit.
        const loading = [...state.chatLists].filter(([id, list]) => id !== "main" && list.loading).length;
        if (loading >= 2) return;
        if (state.chatLists.has(folderId) || !state.folders.some((folder) => folder.id === folderId)) continue;
        // Completion wakes the next pass; retries and account/sync generations stay in the store.
        void state.loadMoreChats(folderId);
      }
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [accountId, chatLists, folderIdsKey, online, ready, visible]);
}
