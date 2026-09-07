import { translate } from "../i18n";
import { LoaderCircle, Plus, Sticker, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useTelegramStore } from "../store/telegramStore";
import type { StickerSet } from "../telegram/types";
import { autoplayAllowed } from "../utils/motionPreference";
import { usePreferencesStore } from "../store/preferencesStore";
import { EmojiAssetVisual } from "./EmojiAssetVisual";

interface StickerSetPreviewProps {
  stickerSetId: string;
  onClose: () => void;
}

export function StickerSetPreview({ stickerSetId, onClose }: StickerSetPreviewProps) {
  const dialogRef = useModalFocus<HTMLElement>(onClose);
  const loadStickerSet = useTelegramStore((state) => state.loadStickerSet);
  const emojiRevision = useTelegramStore((state) => state.emojiRevision);
  const getCachedStickerSet = useTelegramStore((state) => state.getCachedStickerSet);
  const addStickerSet = useTelegramStore((state) => state.addStickerSet);
  const removeStickerSet = useTelegramStore((state) => state.removeStickerSet);
  const autoplayAnimations = usePreferencesStore((state) => autoplayAllowed(
    state.autoplayAnimations,
    state,
  ));
  const [stickerSet, setStickerSet] = useState<StickerSet | undefined>(() => getCachedStickerSet(stickerSetId));
  const [selectedStickerId, setSelectedStickerId] = useState<string>();
  const [loading, setLoading] = useState(() => !getCachedStickerSet(stickerSetId));
  const [failed, setFailed] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => { setSelectedStickerId(undefined); setActionFailed(false); }, [stickerSetId]);

  useEffect(() => {
    let active = true;
    const cached = getCachedStickerSet(stickerSetId);
    setLoading(!cached);
    setFailed(false);
    setStickerSet(cached);
    void loadStickerSet(stickerSetId).then((nextStickerSet) => {
      if (!active) return;
      setStickerSet(nextStickerSet);
      setFailed(!nextStickerSet);
      setLoading(false);
    });
    return () => { active = false; };
  }, [emojiRevision, getCachedStickerSet, loadStickerSet, retryRevision, stickerSetId]);

  const selectedSticker = useMemo(() => stickerSet?.stickers.find(
    (sticker) => sticker.id === selectedStickerId,
  ) ?? stickerSet?.stickers[0], [selectedStickerId, stickerSet]);

  const addSet = async () => {
    if (addPending) return;
    setAddPending(true);
    setActionFailed(false);
    const succeeded = stickerSet?.isInstalled
      ? await removeStickerSet(stickerSetId)
      : await addStickerSet(stickerSetId);
    if (succeeded) {
      onClose();
      return;
    }
    setAddPending(false);
    setActionFailed(true);
  };

  return (
    <div
      className="sticker-set-backdrop"
      role="presentation"
      onWheel={(event) => { event.stopPropagation(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !addPending) onClose(); }}
    >
      <section
        ref={dialogRef}
        className="sticker-set-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sticker-set-title"
        tabIndex={-1}
      >
        <header className="sticker-set-header">
          <span>
            <h2 id="sticker-set-title">{stickerSet?.title ?? translate("贴纸包")}</h2>
            <small>{stickerSet ? translate("{{value0}} 张贴纸", { value0: stickerSet.size }) : translate("正在读取贴纸包")}</small>
          </span>
          <button className="icon-button" type="button" aria-label={translate("关闭贴纸包预览")} title={translate("关闭")} disabled={addPending} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        {loading ? (
          <div className="sticker-set-state" role="status">
            <LoaderCircle className="spin" size={22} />{translate("正在加载贴纸包")}</div>
        ) : failed || !stickerSet ? (
          <div className="sticker-set-state is-error" role="alert">
            <Sticker size={24} strokeWidth={1.7} />{translate("无法加载这个贴纸包")}
            <button type="button" onClick={() => setRetryRevision((value) => value + 1)}>{translate("重试")}</button>
          </div>
        ) : (
          <div className="sticker-set-body">
            <div className="sticker-set-stage" aria-label={translate("贴纸预览")}>
              {selectedSticker ? (
                <EmojiAssetVisual
                  key={selectedSticker.id}
                  asset={selectedSticker}
                  autoplay={autoplayAnimations}
                  label={translate("预览贴纸 {{value0}}", { value0: selectedSticker.emoji ?? "" }).trim()}
                  eager
                />
              ) : <Sticker size={48} strokeWidth={1.4} />}
            </div>
            <div className="sticker-set-list" role="group" aria-label={translate("贴纸列表")}>
              {stickerSet.stickers.map((sticker) => {
                const selected = sticker.id === selectedSticker?.id;
                return (
                  <button
                    type="button"
                    className={selected ? "is-selected" : ""}
                    aria-label={translate("预览贴纸 {{value0}}", { value0: sticker.emoji ?? "" }).trim()}
                    aria-pressed={selected}
                    key={sticker.id}
                    onClick={() => setSelectedStickerId(sticker.id)}
                  >
                    <EmojiAssetVisual
                      asset={sticker}
                      autoplay={false}
                      previewOnly
                      label={translate("贴纸 {{value0}}", { value0: sticker.emoji ?? "" }).trim()}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <footer className="sticker-set-footer">
          {actionFailed && <span role="alert">{stickerSet?.isInstalled ? translate("移除贴纸包失败") : translate("添加贴纸包失败")}</span>}
          <button
            className="dialog-primary"
            type="button"
            disabled={loading || failed || !stickerSet || addPending}
            onClick={() => void addSet()}
          >
            {addPending ? <LoaderCircle className="spin" size={16} /> : stickerSet?.isInstalled ? <Trash2 size={16} /> : <Plus size={16} />}
            {addPending ? translate("正在处理") : stickerSet?.isInstalled ? translate("移除贴纸") : translate("添加贴纸")}
          </button>
        </footer>
      </section>
    </div>
  );
}
