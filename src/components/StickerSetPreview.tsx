import { Check, LoaderCircle, Plus, Sticker, X } from "lucide-react";
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
  const addStickerSet = useTelegramStore((state) => state.addStickerSet);
  const autoplayAnimations = usePreferencesStore((state) => autoplayAllowed(
    state.autoplayAnimations,
    state,
  ));
  const [stickerSet, setStickerSet] = useState<StickerSet>();
  const [selectedStickerId, setSelectedStickerId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    setStickerSet(undefined);
    setSelectedStickerId(undefined);
    setAdded(false);
    void loadStickerSet(stickerSetId).then((nextStickerSet) => {
      if (!active) return;
      setStickerSet(nextStickerSet);
      setSelectedStickerId(nextStickerSet?.stickers[0]?.id);
      setFailed(!nextStickerSet);
      setLoading(false);
    });
    return () => { active = false; };
  }, [loadStickerSet, stickerSetId]);

  const selectedSticker = useMemo(() => stickerSet?.stickers.find(
    (sticker) => sticker.id === selectedStickerId,
  ) ?? stickerSet?.stickers[0], [selectedStickerId, stickerSet]);

  const addSet = async () => {
    if (addPending || added) return;
    setAddPending(true);
    const succeeded = await addStickerSet(stickerSetId);
    setAddPending(false);
    if (succeeded) setAdded(true);
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
            <h2 id="sticker-set-title">{stickerSet?.title ?? "贴纸包"}</h2>
            <small>{stickerSet ? `${stickerSet.size} 张贴纸` : "正在读取贴纸包"}</small>
          </span>
          <button className="icon-button" type="button" aria-label="关闭贴纸包预览" title="关闭" disabled={addPending} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        {loading ? (
          <div className="sticker-set-state" role="status">
            <LoaderCircle className="spin" size={22} />
            正在加载贴纸包
          </div>
        ) : failed || !stickerSet ? (
          <div className="sticker-set-state is-error" role="alert">
            <Sticker size={24} strokeWidth={1.7} />
            无法加载这个贴纸包
          </div>
        ) : (
          <div className="sticker-set-body">
            <div className="sticker-set-stage" aria-label="贴纸预览">
              {selectedSticker ? (
                <EmojiAssetVisual
                  key={selectedSticker.id}
                  asset={selectedSticker}
                  autoplay={autoplayAnimations}
                  label={`预览贴纸 ${selectedSticker.emoji ?? ""}`.trim()}
                  eager
                />
              ) : <Sticker size={48} strokeWidth={1.4} />}
            </div>
            <div className="sticker-set-list" role="group" aria-label="贴纸列表">
              {stickerSet.stickers.map((sticker) => {
                const selected = sticker.id === selectedSticker?.id;
                return (
                  <button
                    type="button"
                    className={selected ? "is-selected" : ""}
                    aria-label={`预览贴纸 ${sticker.emoji ?? ""}`.trim()}
                    aria-pressed={selected}
                    key={sticker.id}
                    onClick={() => setSelectedStickerId(sticker.id)}
                  >
                    <EmojiAssetVisual
                      asset={sticker}
                      autoplay={false}
                      label={`贴纸 ${sticker.emoji ?? ""}`.trim()}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <footer className="sticker-set-footer">
          <button
            className="dialog-primary"
            type="button"
            disabled={loading || failed || !stickerSet || addPending || added}
            onClick={() => void addSet()}
          >
            {addPending ? <LoaderCircle className="spin" size={16} /> : added ? <Check size={16} /> : <Plus size={16} />}
            {addPending ? "正在添加" : added ? "已添加" : "添加贴纸"}
          </button>
        </footer>
      </section>
    </div>
  );
}
