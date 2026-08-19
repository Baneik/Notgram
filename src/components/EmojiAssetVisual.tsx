import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { EmojiPickerAsset } from "../telegram/types";
import { AutoplayVideo } from "./AutoplayVideo";
import { StableImage } from "./StableImage";
import { TgsSticker } from "./TgsSticker";

const assetSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};

interface EmojiAssetVisualProps {
  asset: EmojiPickerAsset;
  autoplay: boolean;
  label: string;
  eager?: boolean;
  className?: string;
}

export function EmojiAssetVisual({
  asset,
  autoplay,
  label,
  eager = false,
  className = "",
}: EmojiAssetVisualProps) {
  const loadEmojiAsset = useTelegramStore((state) => state.loadEmojiAsset);
  const visualRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(eager);
  const [loadedPath, setLoadedPath] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoadedPath(undefined);
    setFailed(false);
    setVisible(eager);
  }, [asset.id, eager]);

  useEffect(() => {
    const visual = visualRef.current;
    if (!visual || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "180px" });
    observer.observe(visual);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || asset.localPath || loadedPath) return;
    let active = true;
    void loadEmojiAsset(asset).then((path) => {
      if (!active) return;
      if (path) {
        setLoadedPath(path);
        setFailed(false);
      } else if (!asset.previewDataUrl && !asset.previewPath) {
        setFailed(true);
      }
    });
    return () => { active = false; };
  }, [asset, loadEmojiAsset, loadedPath, visible]);

  const fullSource = assetSource(asset.localPath ?? loadedPath);
  const previewSource = assetSource(asset.previewPath) ?? asset.previewDataUrl;
  const source = fullSource ?? previewSource;
  const usingFullAsset = Boolean(fullSource);
  const markFailed = () => setFailed(true);

  return (
    <span
      ref={visualRef}
      className={`emoji-asset-visual ${className}`.trim()}
      data-asset-id={asset.id}
    >
      {!source && !failed ? <LoaderCircle className="spin" size={18} /> : failed ? (
        <span className="emoji-asset-fallback">{asset.emoji ?? "贴纸"}</span>
      ) : usingFullAsset && asset.mimeType === "application/x-tgsticker" ? (
        <TgsSticker src={source!} label={label} autoplay={autoplay} onError={markFailed} />
      ) : usingFullAsset && (asset.mimeType === "video/webm" || asset.kind === "animation") ? (
        <AutoplayVideo src={source} muted autoplay={autoplay} loop playsInline aria-label={label} onError={markFailed} />
      ) : (
        <StableImage src={source} alt="" draggable={false} onError={markFailed} />
      )}
    </span>
  );
}
