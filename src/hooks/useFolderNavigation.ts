import { useCallback } from "react";
import { telegramStore } from "../store/telegramStore";

export function useFolderNavigation(closeSearch: () => void) {
  return useCallback((folderId: string) => {
    const state = telegramStore.getState();
    if (state.accountSwitching || !state.folders.some(folder => folder.id === folderId)) return;
    closeSearch();
    if (state.chatFilter !== folderId) state.setChatFilter(folderId);
  }, [closeSearch]);
}
