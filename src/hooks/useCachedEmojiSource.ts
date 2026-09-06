import { useEffect, useState } from "react";
import { getCachedLocalAsset, isNativeAssetSource, retainLocalAsset } from "../media/localAssetCache";

/** Only sticker media/thumbnail callers opt in; large saved GIFs keep ranged playback. */
export const useCachedEmojiSource = (source: string | undefined, enabled: boolean, visible: boolean) => {
  const cacheable = Boolean(enabled && source && isNativeAssetSource(source));
  const [resolved, setResolved] = useState<{ source: string; url: string }>();
  const cached = cacheable && source ? getCachedLocalAsset(source) : undefined;
  const shouldLoad = cacheable && (visible || Boolean(cached));

  useEffect(() => {
    if (!shouldLoad || !source) return;
    let active = true;
    const retained = retainLocalAsset(source);
    void retained.promise.then((url) => {
      if (active) setResolved({ source, url });
    }).catch(() => {
      // Preserve native element error handling and ranged playback fallback.
      if (active) setResolved({ source, url: source });
    });
    return () => {
      active = false;
      retained.release();
    };
  }, [shouldLoad, source]);

  if (!cacheable) return source;
  return cached ?? (resolved && resolved.source === source ? resolved.url : undefined);
};
