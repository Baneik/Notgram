import { useEffect, useState } from "react";
import { getCachedLocalAsset, isNativeAssetSource, retainLocalAsset } from "../media/localAssetCache";

/** Only sticker media/thumbnail callers opt in; large saved GIFs keep ranged playback. */
export const useCachedEmojiSource = (source: string | undefined, enabled: boolean, visible: boolean, revision = 0) => {
  const cacheable = Boolean(enabled && source && isNativeAssetSource(source));
  const [resolved, setResolved] = useState<{ source: string; url: string; revision: number }>();
  const cached = cacheable && source ? getCachedLocalAsset(source) : undefined;
  const shouldLoad = cacheable && (visible || Boolean(cached));

  useEffect(() => {
    if (!shouldLoad || !source) return;
    let active = true;
    const retained = retainLocalAsset(source);
    void retained.promise.then((url) => {
      if (active) setResolved({ source, url, revision });
    }).catch(() => {
      // Preserve native element error handling and ranged playback fallback.
      if (active) setResolved({ source, url: source, revision });
    });
    return () => {
      active = false;
      retained.release();
    };
  }, [revision, shouldLoad, source]);

  if (!cacheable) return source;
  return cached ?? (resolved && resolved.source === source && resolved.revision === revision && resolved.url === source ? source : undefined);
};
