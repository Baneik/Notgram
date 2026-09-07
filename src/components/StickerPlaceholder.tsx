import { Sticker } from "lucide-react";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { useVisibleResource } from "../hooks/useVisibleResource";
import { useTelegramStore } from "../store/telegramStore";
import { translate } from "../i18n";

export function StickerPlaceholder({ fileId, width = 512, height = 512, emoji }: {
  fileId?: number;
  width?: number;
  height?: number;
  emoji?: string;
}) {
  const accountId = useTelegramStore((state) => state.activeAccountId);
  const emojiRevision = useTelegramStore((state) => state.emojiRevision);
  const loadOutline = useTelegramStore((state) => state.loadStickerOutline);
  const getCachedOutline = useTelegramStore((state) => state.getCachedStickerOutline);
  const [ref, visible] = useElementVisibility<HTMLSpanElement>("180px");
  const { value: path } = useVisibleResource(
    fileId === undefined ? undefined : `${accountId}:${emojiRevision}:${fileId}`,
    visible,
    fileId === undefined ? undefined : getCachedOutline(fileId),
    () => fileId === undefined ? Promise.resolve("") : loadOutline(fileId),
  );
  const viewWidth = Number.isFinite(width) && width > 0 ? width : 512;
  const viewHeight = Number.isFinite(height) && height > 0 ? height : 512;
  return <span ref={ref} className="sticker-placeholder" aria-label={translate("正在加载贴纸")} role="img">
    {path ? <svg className="sticker-outline" viewBox={`0 0 ${viewWidth} ${viewHeight}`} aria-hidden="true" focusable="false">
      <path d={path} />
    </svg> : <span className="sticker-placeholder-fallback" aria-hidden="true">{emoji || <Sticker size={28} strokeWidth={1.3} />}</span>}
  </span>;
}
