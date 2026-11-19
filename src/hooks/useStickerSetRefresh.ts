import { useEffect } from "react";
import { useTelegramStore } from "../store/telegramStore";
import { useDocumentVisibility } from "./useDocumentVisibility";

const STICKER_SET_REFRESH_MS = 60_000;

export function useStickerSetRefresh(stickerSetId?: string) {
  const visible = useDocumentVisibility();
  const ready = useTelegramStore((state) => state.authorization.kind === "ready");
  const accountId = useTelegramStore((state) => state.activeAccountId);
  const loadStickerSet = useTelegramStore((state) => state.loadStickerSet);
  useEffect(() => {
    if (!stickerSetId || !visible || !ready) return;
    const refresh = () => { void loadStickerSet(stickerSetId, { refresh: true }); };
    refresh();
    const timer = globalThis.setInterval(refresh, STICKER_SET_REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [accountId, loadStickerSet, ready, stickerSetId, visible]);
}
