import { translate } from "../i18n";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCachedEmojiSource } from "../hooks/useCachedEmojiSource";
import { useElementVisibility } from "../hooks/useElementVisibility";
import { useVisibleResource } from "../hooks/useVisibleResource";
import { emojiAssetPreview } from "../media/emojiAssetPreview";
import { invalidateLocalAsset } from "../media/localAssetCache";
import { invalidateTgsAnimation } from "../media/tgsAnimationCache";
import { useTelegramStore } from "../store/telegramStore";
import type { EmojiPickerAsset } from "../telegram/types";
import { AutoplayVideo } from "./AutoplayVideo";
import { StableImage } from "./StableImage";
import { StickerPlaceholder } from "./StickerPlaceholder";
import { TgsSticker } from "./TgsSticker";

const assetSource = (path?: string) => path ? isTauri() ? convertFileSrc(path, "notgram-asset") : path : undefined;

interface EmojiAssetVisualProps {
  asset: EmojiPickerAsset;
  autoplay: boolean;
  label: string;
  eager?: boolean;
  previewOnly?: boolean;
  className?: string;
}

export function EmojiAssetVisual({ asset, autoplay, label, eager = false, previewOnly = false, className = "" }: EmojiAssetVisualProps) {
  const loadEmojiAsset = useTelegramStore((state) => state.loadEmojiAsset);
  const getCachedEmojiAsset = useTelegramStore((state) => state.getCachedEmojiAsset);
  const getCachedStickerPickerPreview = useTelegramStore((state) => state.getCachedStickerPickerPreview);
  const recoverFile = useTelegramStore((state) => state.recoverFile);
  const accountId = useTelegramStore((state) => state.activeAccountId);
  const emojiRevision = useTelegramStore((state) => state.emojiRevision);
  const [visualRef, visible] = useElementVisibility<HTMLSpanElement>("180px");
  const [readyFullSource, setReadyFullSource] = useState<string>();
  const [readyPreviewSource, setReadyPreviewSource] = useState<string>();
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  const [readRevision, setReadRevision] = useState(0);
  const recoveredFiles = useRef(new Set<number>());
  const recoveryGeneration = useRef(0);
  useEffect(() => {
    recoveredFiles.current.clear();
    recoveryGeneration.current++;
    return () => { recoveryGeneration.current++; };
  }, [accountId, asset.id]);
  const preview = useMemo(() => emojiAssetPreview(asset), [asset]);
  const animated = asset.mimeType === "application/x-tgsticker" || asset.mimeType === "video/webm" || asset.kind === "animation";
  const cachedFull = getCachedEmojiAsset(asset);
  const pickerPreview = asset.kind === "sticker" ? getCachedStickerPickerPreview(asset) : undefined;
  const hasPreview = Boolean(pickerPreview || preview || asset.previewPath || asset.previewDataUrl);
  const wantsFull = previewOnly ? !pickerPreview && !animated && (!hasPreview || Boolean(cachedFull)) : !animated || autoplay || eager || !hasPreview;
  const cachedPreview = preview ? getCachedEmojiAsset(preview) : undefined;
  const key = accountId + ":" + emojiRevision + ":" + readRevision;
  const thumbnail = useVisibleResource(
    !pickerPreview && preview && (!wantsFull || !cachedFull || cachedPreview) ? key + ":preview:" + preview.fileId : undefined,
    visible,
    cachedPreview,
    () => preview ? loadEmojiAsset(preview) : Promise.resolve(undefined),
  );
  const full = useVisibleResource(
    wantsFull ? key + ":full:" + asset.fileId : undefined,
    visible,
    cachedFull,
    () => loadEmojiAsset(asset),
  );
  const fullPath = wantsFull ? full.value : undefined;
  const rawFullSource = assetSource(visible ? fullPath : undefined);
  const rawPreviewSource = assetSource(thumbnail.value ?? asset.previewPath);
  const fullSource = useCachedEmojiSource(rawFullSource, asset.kind === "sticker" && asset.mimeType !== "application/x-tgsticker", visible, readRevision);
  const previewSource = useCachedEmojiSource(rawPreviewSource, true, visible, readRevision) ?? asset.previewDataUrl;
  const usableFull = fullSource && !failedSources.has(fullSource) ? fullSource : undefined;
  const usablePreview = previewSource && !failedSources.has(previewSource) ? previewSource : undefined;
  const fullReady = Boolean(usableFull && readyFullSource === usableFull);
  const previewReady = Boolean(usablePreview && readyPreviewSource === usablePreview);
  const ready = fullReady || previewReady || Boolean(pickerPreview);
  const markFailed = (source: string, usingFull: boolean) => {
    setFailedSources((current) => new Set(current).add(source));
    if (!isTauri()) return;
    const fileId = usingFull ? asset.fileId : asset.previewFileId;
    if (fileId === undefined || recoveredFiles.current.has(fileId)) return;
    recoveredFiles.current.add(fileId);
    const generation = recoveryGeneration.current;
    void recoverFile(fileId, 28).then((recovered) => {
      if (!recovered || recoveryGeneration.current !== generation) return;
      const rawSource = usingFull ? rawFullSource : rawPreviewSource;
      if (rawSource) { invalidateLocalAsset(rawSource); invalidateTgsAnimation(rawSource); }
      setReadRevision((value) => value + 1);
      setFailedSources((current) => { const next = new Set(current); next.delete(source); return next; });
    });
  };

  return <span ref={visualRef} className={("emoji-asset-visual " + className).trim()} data-asset-id={asset.id}>
    {!ready && <StickerPlaceholder fileId={asset.kind === "sticker" ? asset.fileId : undefined} width={asset.width} height={asset.height} emoji={asset.emoji} />}
    {pickerPreview && !fullReady && <img className="stable-image" data-picker-preview="true" data-image-state="ready" data-image-transition="none"
      src={pickerPreview} alt="" draggable={false} />}
    {usablePreview && !fullReady && !pickerPreview && <StableImage retainOnRemount={asset.kind === "sticker"} src={usablePreview} alt="" draggable={false}
      onError={() => markFailed(usablePreview, false)} onReady={() => setReadyPreviewSource(usablePreview)} />}
    {usableFull && <span className="emoji-asset-full" data-asset-state={fullReady ? "ready" : "loading"}>
      {asset.mimeType === "application/x-tgsticker" ? (
        <TgsSticker src={usableFull} label={label} autoplay={autoplay} onError={() => markFailed(usableFull, true)} onReady={() => setReadyFullSource(usableFull)} />
      ) : asset.mimeType === "video/webm" || asset.kind === "animation" ? (
        <AutoplayVideo retainOnRemount={asset.kind === "sticker"} src={usableFull} muted autoplay={autoplay} loop playsInline aria-label={label} onError={() => markFailed(usableFull, true)} onReady={() => setReadyFullSource(usableFull)} />
      ) : <StableImage retainOnRemount={asset.kind === "sticker"} src={usableFull} alt="" draggable={false} onError={() => markFailed(usableFull, true)} onReady={() => setReadyFullSource(usableFull)} />}
    </span>}
    {(full.failed || thumbnail.failed || failedSources.size > 0) && !ready && <span className="emoji-asset-error" title={failedSources.size > 0 ? translate("贴纸暂不可用") : translate("贴纸加载失败，正在重试")}><AlertCircle size={14} /></span>}
  </span>;
}
